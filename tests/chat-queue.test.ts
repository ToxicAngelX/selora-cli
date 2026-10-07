/**
 * The single queued prompt (v0.9) and the queue-related stability pins.
 * Driven through the real REPL (mock gateway, PassThrough stdin so lines can
 * be written WHILE a turn streams):
 *
 *  - at most ONE line queues behind a running turn: the first gets
 *    "· queued — runs when this turn finishes" and RUNS next; a second gets
 *    "· one prompt already queued — it runs next" and is discarded (echoed
 *    dimly, never sent).
 *  - Ctrl+C aborting a turn also clears the queued line.
 *  - a `!` line mid-turn is refused with a one-line notice and never queued.
 *  - an aborted turn never reaches the session file: the on-disk
 *    chat.json holds exactly the completed turns (crash-safe invariant).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  CHAT_STREAM_SECOND,
  FAKE_KEY_USER,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { runChat } from '../src/commands/chat.js';
import { loadSession } from '../src/agent/session/store.js';
import type { CliContext, CliIo } from '../src/context.js';

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';

let server: MockServer;
let env: TempEnv;

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
  useApiUrl(server.url);
});

afterAll(async () => {
  cleanup(env.dir);
  await server.close();
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function until(cond: () => boolean, label: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
    await sleep(10);
  }
}

interface Controlled {
  io: CliIo;
  stdin: PassThrough;
  cap: { out(): string; err(): string; all(): string };
}

/** A REPL io whose stdin is written on demand (the mid-turn typing seam). */
function controlledIo(): Controlled {
  const stdin = new PassThrough();
  let out = '';
  let err = '';
  const io: CliIo = {
    stdin,
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
  return { io, stdin, cap: { out: () => out, err: () => err, all: () => `${out}\n${err}` } };
}

function ctx(io: CliIo): CliContext {
  return { debug: false, json: false, apiUrl: server.url, io };
}

const chatDirs: string[] = [];
function chatCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-queue-'));
  chatDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of chatDirs) rmSync(d, { recursive: true, force: true });
});

/** Model route + a chat route whose FIRST call hangs until `release()`. */
function routeFirstHangs(): { release: () => void; chatBodies: () => unknown[] } {
  const bodies: unknown[] = [];
  let releaseFn: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let calls = 0;
  server.setHandler(async (req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      calls += 1;
      bodies.push(JSON.parse(req.body));
      if (calls === 1) await gate;
      return { status: 200, sse: calls === 1 ? CHAT_STREAM_FULL : CHAT_STREAM_SECOND };
    }
    return { status: 404, body: NOT_FOUND };
  });
  return {
    release: () => releaseFn?.(),
    chatBodies: () => bodies,
  };
}

/** Model route + a chat route where the listed calls (1-based) hang forever. */
function routeHangOn(hangCalls: ReadonlySet<number>): { chatBodies: () => unknown[] } {
  const bodies: unknown[] = [];
  let calls = 0;
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      calls += 1;
      bodies.push(JSON.parse(req.body));
      return hangCalls.has(calls)
        ? { status: 200, sse: CHAT_STREAM_FULL, sseHang: true }
        : { status: 200, sse: calls === 1 ? CHAT_STREAM_FULL : CHAT_STREAM_SECOND };
    }
    return { status: 404, body: NOT_FOUND };
  });
  return { chatBodies: () => bodies };
}

/** Wait until the REPL has drawn its first prompt (startup fully done). */
async function waitForPrompt(cap: { err(): string }): Promise<void> {
  await until(() => cap.err().includes('❯ '), 'first prompt drawn');
}

describe('the single queued prompt (v0.9)', () => {
  it('the first mid-turn line queues with a notice and runs next; a second is discarded with notices', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { release, chatBodies } = routeFirstHangs();
    const { io, stdin, cap } = controlledIo();
    const session = runChat(ctx(io), { cwd: chatCwd() });

    await waitForPrompt(cap);
    stdin.write('first\n');
    await until(() => chatBodies().length === 1, 'turn 1 in flight');
    stdin.write('second\n');
    await until(
      () => cap.err().includes('· queued — runs when this turn finishes'),
      'queued notice',
    );
    stdin.write('third\n');
    await until(
      () => cap.err().includes('· one prompt already queued — it runs next'),
      'discard notice',
    );
    expect(cap.err()).toContain('· discarded: third');

    release();
    // turn 1 finishes, the queued 'second' runs as turn 2
    await until(() => chatBodies().length === 2, 'queued line ran after the turn');
    const second = chatBodies()[1] as { messages: Array<{ role: string; content: unknown }> };
    const lastUser = [...second.messages].reverse().find((m) => m.role === 'user');
    expect(lastUser?.content).toBe('second');
    // the discarded line never reached the model anywhere
    expect(JSON.stringify(chatBodies())).not.toContain('third');
    // v1.2.1: the queued line was never echoed mid-turn (the spinner owned the
    // row) — it is replayed as a `❯ …` prompt row when the turn actually runs…
    expect(cap.err()).toContain('❯ second');

    await until(() => cap.out().includes('Second reply'), 'turn 2 reply');
    stdin.write('/exit\n');
    await session;
    expect(cap.all()).toContain('✓ Session ended');
    // …and its raw echo never leaked onto the reply channel mid-turn
    expect(cap.out()).not.toContain('second');
    expect(process.exitCode).toBeUndefined();
  });

  it('Ctrl+C aborting a turn also clears the queued line', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { chatBodies } = routeHangOn(new Set([1]));
    const { io, stdin, cap } = controlledIo();
    let interrupt: (() => void) | undefined;
    const session = runChat(
      ctx(io),
      { cwd: chatCwd() },
      {
        registerInterrupt: (fn) => {
          interrupt = fn;
        },
      },
    );

    await waitForPrompt(cap);
    stdin.write('first\n');
    await until(() => chatBodies().length === 1, 'turn in flight');
    stdin.write('queued line\n');
    await until(() => cap.err().includes('· queued — runs when this turn finishes'), 'queued');
    interrupt!();
    await until(() => cap.all().includes('· Request cancelled — session kept'), 'cancelled');
    // the queued line was dropped: the next written line is the next turn
    stdin.write('after the abort\n');
    await until(() => chatBodies().length === 2, 'fresh turn ran');
    const second = chatBodies()[1] as { messages: Array<{ role: string; content: unknown }> };
    expect(second.messages).toHaveLength(1); // the aborted pair was dropped too
    expect(second.messages[0]?.content).toBe('after the abort');
    expect(JSON.stringify(chatBodies())).not.toContain('queued line');

    await until(() => cap.out().includes('Second reply'), 'reply');
    stdin.write('/exit\n');
    await session;
    expect(cap.all()).toContain('✓ Session ended');
  });

  it('a `!` line mid-turn is refused with a one-line notice and never queued', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { chatBodies } = routeHangOn(new Set([1]));
    const { io, stdin, cap } = controlledIo();
    let interrupt: (() => void) | undefined;
    const session = runChat(
      ctx(io),
      { cwd: chatCwd() },
      {
        registerInterrupt: (fn) => {
          interrupt = fn;
        },
      },
    );

    await waitForPrompt(cap);
    stdin.write('first\n');
    await until(() => chatBodies().length === 1, 'turn in flight');
    stdin.write('! echo should-not-run\n');
    await until(
      () =>
        cap.err().includes('· a turn is streaming — ! commands wait for the prompt (not queued)'),
      'refusal notice',
    );
    expect(cap.err()).not.toContain('· queued — runs when this turn finishes');
    interrupt!();
    await until(() => cap.all().includes('· Request cancelled — session kept'), 'cancelled');
    // and the refused `!` command never ran (no shell block, not queued either)
    expect(cap.err()).not.toContain('· exit 0');
    expect(chatBodies()).toHaveLength(1);

    stdin.write('/exit\n');
    await session;
    expect(cap.all()).toContain('✓ Session ended');
  });

  it('stability: an aborted turn never reaches the session file — chat.json holds completed turns only', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { chatBodies } = routeHangOn(new Set([2])); // turn 1 completes, turn 2 hangs
    const cwd = chatCwd();
    const { io, stdin, cap } = controlledIo();
    let interrupt: (() => void) | undefined;
    const session = runChat(
      ctx(io),
      { cwd },
      {
        registerInterrupt: (fn) => {
          interrupt = fn;
        },
      },
    );

    await waitForPrompt(cap);
    // turn 1 completes → auto-saved
    stdin.write('one\n');
    await until(() => chatBodies().length === 1, 'turn 1 done streaming');
    await until(() => loadSession(cwd, 'chat') !== null, 'session file saved');
    // turn 2 hangs → abort it
    stdin.write('two\n');
    await until(() => chatBodies().length === 2, 'turn 2 in flight');
    interrupt!();
    await until(() => cap.all().includes('· Request cancelled — session kept'), 'cancelled');
    stdin.write('/exit\n');
    await session;

    // the file is valid and holds EXACTLY the completed first turn
    const saved = loadSession(cwd, 'chat');
    expect(saved).not.toBeNull();
    expect(saved!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(saved!.messages)).not.toContain('two');
    expect(cap.all()).toContain('✓ Session ended');
  });
});
