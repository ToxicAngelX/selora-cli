/**
 * v1.6 usage-windows tests. Three layers:
 *  1. pure formatting — the footer segment money (`$4.12/$10.00`, sub-dollar
 *     `$0.0381` precision), the `resets 2h 14m` countdown, week percent, and
 *     the omission rules (unlimited / unenforced / unparseable wire / narrow
 *     terminals). Money math is BigInt micro-units — never floats.
 *  2. WindowsTracker cadence with fake timers — immediate fetch on start,
 *     the 60s idle tick, ticks skipped mid-stream, the post-reply refresh,
 *     once-per-streak error logging, and in-flight dedupe.
 *  3. the chat REPL against the local mock gateway — the segment lands on
 *     the prompt's model line once the poll resolves, `/windows` prints the
 *     detail block, and a 404 endpoint omits the segment silently.
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  FAKE_KEY_USER,
  WINDOWS_BODY,
  WINDOWS_BODY_EXHAUSTED,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { runChat } from '../src/commands/chat.js';
import {
  WINDOWS_POLL_MS,
  WindowsTracker,
  formatResetsIn,
  formatWindowUsd,
  formatWindowUsdMicro,
  windowDetailLines,
  windowFooterSegment,
  windowPercent,
} from '../src/commands/chat-windows.js';
import type { SpendWindow, WindowsResponse } from '../src/api/endpoints/me.js';
import type { CliContext, CliIo } from '../src/context.js';

// ---------------------------------------------------------------------------
// builders
// ---------------------------------------------------------------------------

function win(over: Partial<SpendWindow> = {}): SpendWindow {
  return {
    usedUsd: '4.120000',
    limitUsd: '10.000000',
    remainingUsd: '5.880000',
    startedAt: '2026-10-05T10:00:00Z',
    resetsAt: '2026-10-05T14:00:00Z',
    resetsInMs: 8_040_000, // exactly 2h 14m
    requests: 12,
    enforced: true,
    exhausted: false,
    unlimited: false,
    ...over,
  };
}

function windows(
  session: Partial<SpendWindow> = {},
  week: Partial<SpendWindow> = {},
): WindowsResponse {
  return {
    session: win(session),
    week: win({
      usedUsd: '13.000000',
      limitUsd: '60.000000',
      remainingUsd: '47.000000',
      startedAt: '2026-09-29T00:00:00Z',
      resetsAt: '2026-10-06T00:00:00Z',
      resetsInMs: 129_900_000, // exactly 36h 05m — week resets exceed a day
      requests: 1204,
      ...week,
    }),
  };
}

const WARN_THEME = { warning: (s: string): string => `[WARN]${s}[/WARN]` };

// ---------------------------------------------------------------------------
// money formatting
// ---------------------------------------------------------------------------

describe('formatWindowUsd', () => {
  it('renders >= $1 values with exactly 2 decimals (truncation toward zero)', () => {
    expect(formatWindowUsd('4.120000')).toBe('$4.12');
    expect(formatWindowUsd('10.000000')).toBe('$10.00');
    expect(formatWindowUsd('1.000000')).toBe('$1.00');
    expect(formatWindowUsd('4.129999')).toBe('$4.12'); // truncates, never rounds
  });

  it('keeps sub-dollar precision ($0.0381-style), trailing zeros trimmed', () => {
    expect(formatWindowUsd('0.038100')).toBe('$0.0381');
    expect(formatWindowUsd('0.500000')).toBe('$0.50');
    expect(formatWindowUsd('0.100000')).toBe('$0.10');
    expect(formatWindowUsd('0.000100')).toBe('$0.0001');
    expect(formatWindowUsd('0.038199')).toBe('$0.0381'); // truncates, never rounds
    expect(formatWindowUsd('0.000000')).toBe('$0.00');
  });

  it('handles negatives and never throws on junk', () => {
    expect(formatWindowUsd('-2.500000')).toBe('-$2.50');
    expect(formatWindowUsd('-0.038100')).toBe('-$0.0381');
    expect(formatWindowUsd('junk')).toBe('$junk');
    expect(formatWindowUsd('')).toBe('$');
  });

  it('formatWindowUsdMicro agrees on BigInt micro-units', () => {
    expect(formatWindowUsdMicro(4_120_000n)).toBe('$4.12');
    expect(formatWindowUsdMicro(38_100n)).toBe('$0.0381');
    expect(formatWindowUsdMicro(0n)).toBe('$0.00');
  });
});

// ---------------------------------------------------------------------------
// reset countdown
// ---------------------------------------------------------------------------

describe('formatResetsIn', () => {
  it('renders hours+minutes, zero-padded minutes, hours past a day', () => {
    expect(formatResetsIn(8_040_000)).toBe('2h 14m');
    expect(formatResetsIn(129_900_000)).toBe('36h 05m');
    expect(formatResetsIn(3_600_000)).toBe('1h 00m');
    expect(formatResetsIn(2_700_000)).toBe('45m');
    expect(formatResetsIn(60_000)).toBe('1m');
  });

  it('renders <1m under a minute and "" for non-positive/garbage', () => {
    expect(formatResetsIn(59_000)).toBe('<1m');
    expect(formatResetsIn(999)).toBe('<1m');
    expect(formatResetsIn(0)).toBe('');
    expect(formatResetsIn(-5)).toBe('');
    expect(formatResetsIn(Number.NaN)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// week percent (BigInt, rounded to nearest 1%)
// ---------------------------------------------------------------------------

describe('windowPercent', () => {
  it('rounds to nearest whole percent', () => {
    expect(windowPercent(win({ usedUsd: '13.000000', limitUsd: '60.000000' }))).toBe(22);
    expect(windowPercent(win({ usedUsd: '1.000000', limitUsd: '8.000000' }))).toBe(13); // 12.5 → 13
    expect(windowPercent(win({ usedUsd: '0.000000', limitUsd: '60.000000' }))).toBe(0);
  });

  it('is null without a positive parseable limit or when unlimited', () => {
    expect(windowPercent(win({ limitUsd: '0.000000' }))).toBeNull();
    expect(windowPercent(win({ limitUsd: 'junk' }))).toBeNull();
    expect(windowPercent(win({ usedUsd: 'junk' }))).toBeNull();
    expect(windowPercent(win({ unlimited: true }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// the footer segment
// ---------------------------------------------------------------------------

describe('windowFooterSegment', () => {
  it('renders used/limit, the reset countdown, and the week percent', () => {
    expect(windowFooterSegment(windows(), 80)).toBe('$4.12/$10.00 · resets 2h 14m · week 22%');
  });

  it('renders sub-dollar used values with $0.0381-style precision', () => {
    expect(windowFooterSegment(windows({ usedUsd: '0.038100' }), 80)).toBe(
      '$0.0381/$10.00 · resets 2h 14m · week 22%',
    );
  });

  it('exhausted caps render the warn color as "cap reached · resets …"', () => {
    const exhausted = windows({ exhausted: true, usedUsd: '10.000000', remainingUsd: '0.000000' });
    expect(windowFooterSegment(exhausted, 80, WARN_THEME)).toBe(
      '[WARN]cap reached · resets 2h 14m[/WARN]',
    );
    // themeless (tests, NO_COLOR): plain text, still honest
    expect(windowFooterSegment(exhausted, 80)).toBe('cap reached · resets 2h 14m');
    // no countdown when the wire carries no reset time
    expect(windowFooterSegment(windows({ exhausted: true, resetsInMs: 0 }), 80)).toBe(
      'cap reached',
    );
  });

  it('omits entirely when unlimited (pulsar) or enforcement is off', () => {
    expect(windowFooterSegment(windows({ unlimited: true }), 80)).toBe('');
    expect(windowFooterSegment(windows({ enforced: false }), 80)).toBe('');
    // unlimited wins even over an exhausted flag
    expect(windowFooterSegment(windows({ unlimited: true, exhausted: true }), 80)).toBe('');
  });

  it('drops the week % below 60 cols, then the countdown below 40', () => {
    const w = windows();
    expect(windowFooterSegment(w, 59)).toBe('$4.12/$10.00 · resets 2h 14m');
    expect(windowFooterSegment(w, 60)).toContain('week 22%');
    expect(windowFooterSegment(w, 39)).toBe('$4.12/$10.00');
    expect(windowFooterSegment(w, 40)).toContain('resets 2h 14m');
  });

  it('omits the week % when the week limit is 0 or the week is unlimited', () => {
    expect(windowFooterSegment(windows({}, { limitUsd: '0.000000' }), 80)).toBe(
      '$4.12/$10.00 · resets 2h 14m',
    );
    expect(windowFooterSegment(windows({}, { unlimited: true }), 80)).toBe(
      '$4.12/$10.00 · resets 2h 14m',
    );
  });

  it('omits the countdown when resetsInMs is 0, keeps used/limit', () => {
    expect(windowFooterSegment(windows({ resetsInMs: 0 }), 80)).toBe('$4.12/$10.00 · week 22%');
  });

  it('untrusted wire data omits the segment, never throws', () => {
    expect(windowFooterSegment(windows({ usedUsd: 'not-money' }), 80)).toBe('');
    expect(windowFooterSegment(windows({ limitUsd: '' }), 80)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// the /windows detail block
// ---------------------------------------------------------------------------

describe('windowDetailLines', () => {
  it('prints both windows with money, requests, local reset clock, and flag words', () => {
    const lines = windowDetailLines(windows());
    const text = lines.join('\n');
    expect(text).toContain('Session (4h) window:');
    expect(text).toContain('  used $4.12 of $10.00 · remaining $5.88 · 12 requests');
    expect(text).toContain('  resets at ');
    expect(text).toContain(' local (in 2h 14m)');
    expect(text).toContain('  enforced · not exhausted');
    expect(text).toContain('Week window:');
    expect(text).toContain('  used $13.00 of $60.00 · remaining $47.00 · 1,204 requests');
    expect(text).toContain(' local (in 36h 05m)');
    // the local clock renders as YYYY-MM-DD HH:MM in the runner's timezone
    expect(text).toMatch(/resets at \d{4}-\d{2}-\d{2} \d{2}:\d{2} local/);
  });

  it('unlimited windows read as words, not fake numbers', () => {
    const text = windowDetailLines(
      windows({ unlimited: true, usedUsd: '', limitUsd: '', remainingUsd: '' }),
    ).join('\n');
    expect(text).toContain('  unlimited — no cap');
    expect(text).toContain('  enforced · unlimited');
  });

  it('exhausted and unenforced flags read as human words', () => {
    expect(windowDetailLines(windows({ exhausted: true })).join('\n')).toContain(
      '  enforced · exhausted',
    );
    expect(windowDetailLines(windows({ enforced: false })).join('\n')).toContain(
      '  not enforced · not exhausted',
    );
  });

  it('unparseable wire data degrades honestly, never throws', () => {
    const text = windowDetailLines(
      windows({ usedUsd: 'junk', limitUsd: 'junk', resetsAt: 'not-a-date', resetsInMs: 0 }),
    ).join('\n');
    const sessionBlock = text.split('Week window:')[0]!;
    expect(sessionBlock).toContain('  (no window data reported)');
    expect(sessionBlock).not.toContain('resets at');
  });
});

// ---------------------------------------------------------------------------
// the poll tracker (fake timers)
// ---------------------------------------------------------------------------

describe('WindowsTracker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const flush = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(0);
  };

  it('fetches immediately on start, then every 60s while idle, and stops cleanly', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let changes = 0;
    const t = new WindowsTracker({
      fetch: () => {
        calls += 1;
        return Promise.resolve(windows());
      },
      isBusy: () => false,
      onChange: () => {
        changes += 1;
      },
    });
    t.start();
    await flush();
    expect(calls).toBe(1);
    expect(changes).toBe(1);
    expect(t.current?.session.usedUsd).toBe('4.120000');
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(calls).toBe(2);
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(calls).toBe(3);
    expect(changes).toBe(3);
    t.stop();
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS * 3);
    expect(calls).toBe(3);
  });

  it('never fetches mid-stream: the 60s tick skips while busy', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let busy = false;
    const t = new WindowsTracker({
      fetch: () => {
        calls += 1;
        return Promise.resolve(windows());
      },
      isBusy: () => busy,
    });
    t.start();
    await flush();
    expect(calls).toBe(1);
    busy = true; // a reply is streaming
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS * 3);
    expect(calls).toBe(1); // no fetch mid-stream
    busy = false; // the stream ended
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(calls).toBe(2);
    t.stop();
  });

  it('notifyIdle refreshes immediately after a reply completes', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const t = new WindowsTracker({
      fetch: () => {
        calls += 1;
        return Promise.resolve(windows());
      },
      isBusy: () => false,
    });
    t.start();
    await flush();
    expect(calls).toBe(1);
    t.notifyIdle(); // a reply just consumed budget
    await flush();
    expect(calls).toBe(2); // no 60s wait
    t.stop();
  });

  it('concurrent refreshes share one in-flight fetch', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = new WindowsTracker({
      fetch: () => {
        calls += 1;
        return gate.then(() => windows());
      },
      isBusy: () => false,
    });
    t.start();
    t.notifyIdle();
    expect(calls).toBe(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(t.current).not.toBeNull();
    expect(calls).toBe(1);
    t.stop();
  });

  it('errors omit the segment silently and log once per failure streak', async () => {
    vi.useFakeTimers();
    let calls = 0;
    let failing = true;
    const errors: unknown[] = [];
    const t = new WindowsTracker({
      fetch: () => {
        calls += 1;
        return failing ? Promise.reject(new Error('boom')) : Promise.resolve(windows());
      },
      isBusy: () => false,
      onFirstError: (err) => errors.push(err),
    });
    t.start();
    await flush();
    expect(t.current).toBeNull(); // omitted, not a failure surface
    expect(errors.length).toBe(1);
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(calls).toBe(2);
    expect(errors.length).toBe(1); // never per retry
    failing = false; // the gateway recovers
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(t.current).not.toBeNull();
    failing = true; // a NEW streak logs once more
    await vi.advanceTimersByTimeAsync(WINDOWS_POLL_MS);
    expect(errors.length).toBe(2);
    // last-known-good keeps rendering through the new streak
    expect(t.current).not.toBeNull();
    t.stop();
  });

  it('stop() aborts an in-flight fetch — an exiting REPL never waits on it', async () => {
    let calls = 0;
    let signalSeen: AbortSignal | undefined;
    const errors: unknown[] = [];
    const t = new WindowsTracker({
      fetch: (signal) => {
        calls += 1;
        signalSeen = signal;
        return new Promise<WindowsResponse>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('cancelled')));
        });
      },
      isBusy: () => false,
      onFirstError: (err) => errors.push(err),
    });
    t.start();
    expect(calls).toBe(1);
    t.stop();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(signalSeen?.aborted).toBe(true);
    expect(errors.length).toBe(0); // a stop abort is a shutdown, not a failure
  });

  it('fetchNow serves /windows: fresh data on success, the error propagates', async () => {
    const good = new WindowsTracker({
      fetch: () => Promise.resolve(windows()),
      isBusy: () => false,
    });
    const w = await good.fetchNow();
    expect(w.session.usedUsd).toBe('4.120000');
    expect(good.current).not.toBeNull(); // the footer shares the fresh state
    const bad = new WindowsTracker({
      fetch: () => Promise.reject(new Error('endpoint gone')),
      isBusy: () => false,
    });
    await expect(bad.fetchNow()).rejects.toThrow('endpoint gone');
  });
});

// ---------------------------------------------------------------------------
// the chat REPL end to end (mock gateway)
// ---------------------------------------------------------------------------

let server: MockServer;
let env: TempEnv;
const replDirs: string[] = [];

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
  useApiUrl(server.url);
});

afterAll(async () => {
  for (const d of replDirs) rmSync(d, { recursive: true, force: true });
  cleanup(env.dir);
  await server.close();
});

function replCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-windows-'));
  replDirs.push(d);
  return d;
}

function replCtx(io: CliIo): CliContext {
  return { debug: false, json: false, apiUrl: server.url, io };
}

async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Transcript-style io (chat.test.ts conventions) whose stdin the test feeds
 * line by line — the REPL's next prompt can be gated on the windows poll
 * having landed, which piped all-at-once lines cannot express.
 */
function scriptedIo(): {
  io: CliIo;
  cap: { out(): string; err(): string; all(): string };
  push: (line: string) => void;
} {
  let out = '';
  let err = '';
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  async function* lines(): AsyncGenerator<string> {
    for (;;) {
      while (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = undefined;
      }
      yield queue.shift()!;
    }
  }
  const io: CliIo = {
    stdin: Readable.from(lines()),
    isTTY: true,
    out: (s) => {
      out += `${s}\n`;
    },
    err: (s) => {
      err += `${s}\n`;
    },
    writeOut: (s) => {
      out += s;
    },
    writeErr: (s) => {
      err += s;
    },
  };
  return {
    io,
    cap: { out: () => out, err: () => err, all: () => `${out}\n${err}` },
    push: (line) => {
      queue.push(`${line}\n`);
      wake?.();
    },
  };
}

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';

function installRoutes(windowsBody: string | null): void {
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.path.slice('/v1/models/'.length));
      return { status: 200, body: modelDetailBody(id) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    if (req.method === 'GET' && req.path === '/v1/me/windows') {
      if (windowsBody === null) return { status: 404, body: NOT_FOUND };
      if (req.headers['authorization'] === `Bearer ${FAKE_KEY_USER}`) {
        return { status: 200, body: windowsBody };
      }
      return { status: 401, body: NOT_FOUND };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

describe('chat REPL usage windows', () => {
  it('the poll lands on the prompt model line; /windows prints the detail block', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(WINDOWS_BODY);
    const { io, cap, push } = scriptedIo();
    const done = runChat(replCtx(io), { cwd: replCwd() });
    // Wait for the initial poll to resolve before the next prompt is drawn:
    // the request must be observed AND the response processed (local mock —
    // one short settle is plenty, same flavor as chat.test.ts `until`).
    await until(
      () => server.requests.some((r) => r.path === '/v1/me/windows'),
      'initial windows poll',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    push('hello'); // a reply — its completion triggers the post-reply refresh
    await until(
      () => server.requests.filter((r) => r.path === '/v1/me/windows').length >= 2,
      'post-reply windows refresh',
    );
    push('/windows');
    await until(() => cap.err().includes('Session (4h) window:'), '/windows block');
    push('/exit');
    await done;

    // WINDOWS_BODY: $1.80/$10.00, resets in 1h 12m, week 13/60 → 22%
    const err = cap.err();
    expect(err).toContain('$1.80/$10.00 · resets 1h 12m · week 22%');
    // the /windows detail block (r.bullet renders to stderr, like all bullets)
    expect(err).toContain('Session (4h) window:');
    expect(err).toContain('used $1.80 of $10.00 · remaining $8.20 · 12 requests');
    expect(err).toContain('Week window:');
    expect(err).toContain('enforced · not exhausted');
    expect(cap.all()).toContain('✓ Session ended');
    expect(process.exitCode).toBeUndefined();
  });

  it('an exhausted window renders "cap reached" on the prompt line', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(WINDOWS_BODY_EXHAUSTED);
    const { io, cap, push } = scriptedIo();
    const done = runChat(replCtx(io), { cwd: replCwd() });
    await until(
      () => server.requests.some((r) => r.path === '/v1/me/windows'),
      'initial windows poll',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    push('hello');
    await until(() => cap.err().includes('cap reached'), 'exhausted segment');
    push('/exit');
    await done;
    expect(cap.err()).toContain('cap reached · resets 1h 12m');
    expect(cap.err()).not.toContain('$10.00/$10.00');
    expect(cap.all()).toContain('✓ Session ended');
  });

  it('a 404 windows endpoint omits the segment silently — no error anywhere', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(null);
    const { io, cap, push } = scriptedIo();
    const done = runChat(replCtx(io), { cwd: replCwd() });
    await until(
      () => server.requests.some((r) => r.path === '/v1/me/windows'),
      'initial windows poll',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    push('hello');
    await until(() => cap.out().includes('Hello, world!'), 'reply');
    push('/exit');
    await done;
    const all = cap.all();
    expect(all).not.toContain('$1.80');
    expect(all).not.toContain('cap reached');
    expect(all).not.toContain('windows poll failed'); // debug is off here
    expect(all).toContain('✓ Session ended'); // the REPL was never disturbed
    expect(process.exitCode).toBeUndefined();
  });
});
