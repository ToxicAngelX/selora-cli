/**
 * The `!` one-shot shell escape (v0.9). Layers:
 *
 *  1. parseBangLine — the prefix is recognized ONLY at the start of the line;
 *     `\!` escapes a literal bang; a bare `!` is an empty command.
 *  2. startShellCommand — with an injected fake spawn (output merge in
 *     arrival order, exit code, spawn failure, kill → SIGINT then SIGKILL)
 *     and with the REAL spawn for a portable smoke run.
 *  3. foldShellOutput / renderShellBlock — the last-40-lines fold with the
 *     "… N more lines" marker, the dim block, the highlighted non-zero exit.
 *  4. the REPL integration (mock gateway): `! cmd` runs and renders, the
 *     command + output are NEVER sent to the model, `\!` sends a literal
 *     bang as a normal message, and Ctrl+C mid-`!` kills the command and
 *     keeps the session.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL, FAKE_KEY_USER, modelDetailBody } from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { trustDir } from '../src/config/trust.js';
import { runChat } from '../src/commands/chat.js';
import {
  foldShellOutput,
  parseBangLine,
  renderShellBlock,
  startShellCommand,
  SHELL_OUTPUT_LINE_CAP,
  type SpawnedProcess,
  type SpawnImpl,
} from '../src/shellescape.js';
import { themeFor } from '../src/ui/theme.js';
import type { CliContext, CliIo } from '../src/context.js';

const plain = themeFor('mono', false);

// ---------------------------------------------------------------------------
// parseBangLine
// ---------------------------------------------------------------------------

describe('parseBangLine', () => {
  it('a leading ! is a shell command (trimmed)', () => {
    expect(parseBangLine('! npm test')).toEqual({ kind: 'shell', command: 'npm test' });
    expect(parseBangLine('!ls')).toEqual({ kind: 'shell', command: 'ls' });
    expect(parseBangLine('!')).toEqual({ kind: 'shell', command: '' });
    expect(parseBangLine('!   ')).toEqual({ kind: 'shell', command: '' });
  });

  it('only at the START of the line — a later ! stays a plain message', () => {
    expect(parseBangLine('foo ! bar')).toEqual({ kind: 'plain' });
    expect(parseBangLine('hello')).toEqual({ kind: 'plain' });
    expect(parseBangLine('/help')).toEqual({ kind: 'plain' });
  });

  it('\\! escapes a literal leading bang (the backslash is consumed)', () => {
    expect(parseBangLine('\\!important')).toEqual({ kind: 'escaped', text: '!important' });
    expect(parseBangLine('\\!')).toEqual({ kind: 'escaped', text: '!' });
    expect(parseBangLine('\\! ls')).toEqual({ kind: 'escaped', text: '! ls' });
  });
});

// ---------------------------------------------------------------------------
// startShellCommand with an injected spawn
// ---------------------------------------------------------------------------

interface FakeSpec {
  out?: string[];
  err?: string[];
  code?: number | null;
  signal?: string | null;
  spawnError?: Error;
  /** When true, the fake only closes after a kill signal (SIGINT ignored). */
  closesOnSigkillOnly?: boolean;
}

function fakeSpawn(spec: FakeSpec, killed: string[] = []): SpawnImpl {
  return (_command, _cwd) => {
    if (spec.spawnError !== undefined) throw spec.spawnError;
    const stdout = new Readable({ read() {} });
    const stderr = new Readable({ read() {} });
    const listeners: {
      error?: (err: Error) => void;
      close?: (code: number | null, signal: string | null) => void;
    } = {};
    const proc: SpawnedProcess = {
      stdout,
      stderr,
      kill(signal = 'SIGTERM') {
        killed.push(signal);
        if (spec.closesOnSigkillOnly === true && signal !== 'SIGKILL') return;
        setTimeout(() => {
          listeners.close?.(null, signal);
        }, 0);
      },
      on(
        event: 'error' | 'close',
        listener: ((err: Error) => void) | ((code: number | null, signal: string | null) => void),
      ) {
        if (event === 'error') listeners.error = listener as (err: Error) => void;
        else listeners.close = listener as (code: number | null, signal: string | null) => void;
      },
    };
    setTimeout(() => {
      for (const chunk of spec.out ?? []) stdout.emit('data', Buffer.from(chunk));
      for (const chunk of spec.err ?? []) stderr.emit('data', Buffer.from(chunk));
      if (spec.code !== undefined || spec.signal !== undefined) {
        listeners.close?.(spec.code ?? null, spec.signal ?? null);
      }
    }, 0);
    return proc;
  };
}

describe('startShellCommand (injected spawn)', () => {
  it('merges stdout and stderr in arrival order and resolves the exit code', async () => {
    const handle = startShellCommand('whatever', '/tmp', {
      spawnImpl: fakeSpawn({ out: ['o1\n', 'o2\n'], err: ['e1\n'], code: 3 }),
    });
    const result = await handle.done;
    expect(result.code).toBe(3);
    expect(result.signal).toBeNull();
    expect(result.output).toBe('o1\no2\ne1\n');
    expect(result.truncated).toBe(false);
  });

  it('a spawn throw resolves a spawnError (never rejects)', async () => {
    const handle = startShellCommand('whatever', '/tmp', {
      spawnImpl: fakeSpawn({ spawnError: new Error('ENOENT no shell') }),
    });
    const result = await handle.done;
    expect(result.spawnError).toBe('ENOENT no shell');
    expect(result.code).toBeNull();
  });

  it('kill sends SIGINT and escalates to SIGKILL when the process lingers', async () => {
    const killed: string[] = [];
    const handle = startShellCommand('whatever', '/tmp', {
      spawnImpl: fakeSpawn({ closesOnSigkillOnly: true }, killed),
    });
    handle.kill();
    const result = await handle.done; // resolves when the SIGKILL lands
    expect(killed).toEqual(['SIGINT', 'SIGKILL']);
    expect(result.code).toBeNull();
    expect(result.signal).toBe('SIGKILL');
  });

  it('real spawn smoke: echo runs in the given cwd with shell semantics', async () => {
    const cmd =
      process.platform === 'win32'
        ? 'echo hello-shell'
        : 'echo hello-$([ 1 -eq 1 ] && echo shell)'; // $() proves a real shell
    const handle = startShellCommand(cmd, tmpdir()); // cross-platform temp dir
    const result = await handle.done;
    expect(result.code).toBe(0);
    expect(result.output).toContain('hello-shell');
  });
});

// ---------------------------------------------------------------------------
// fold + render
// ---------------------------------------------------------------------------

describe('foldShellOutput', () => {
  it('keeps everything under the cap (one trailing newline is structural)', () => {
    expect(foldShellOutput('a\nb\n')).toEqual({ lines: ['a', 'b'], hidden: 0 });
    expect(foldShellOutput('')).toEqual({ lines: [], hidden: 0 });
  });

  it('keeps the LAST maxLines and reports the folded count', () => {
    const output = Array.from({ length: 50 }, (_, i) => `line${i + 1}`).join('\n');
    const folded = foldShellOutput(output, 10);
    expect(folded.lines).toEqual(Array.from({ length: 10 }, (_, i) => `line${41 + i}`));
    expect(folded.hidden).toBe(40);
  });
});

describe('renderShellBlock', () => {
  it('renders the dim block + a dim exit 0 line', () => {
    const lines = renderShellBlock(
      { code: 0, signal: null, output: 'hello\nworld\n', truncated: false },
      plain,
    );
    expect(lines).toEqual(['      hello', '      world', '  · exit 0']);
  });

  it('folds long output: marker first, then the last 40 lines', () => {
    const output =
      Array.from({ length: SHELL_OUTPUT_LINE_CAP + 7 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
    const lines = renderShellBlock({ code: 0, signal: null, output, truncated: false }, plain);
    expect(lines[0]).toBe('      … 7 more lines');
    expect(lines).toHaveLength(1 + SHELL_OUTPUT_LINE_CAP + 1); // marker + tail + exit
    expect(lines[lines.length - 2]).toBe(`      L${SHELL_OUTPUT_LINE_CAP + 7}`);
  });

  it('non-zero exit is the error line; a kill reports the signal; empty output says so', () => {
    const failed = renderShellBlock(
      { code: 2, signal: null, output: 'boom\n', truncated: false },
      plain,
    );
    expect(failed[failed.length - 1]).toBe('  ✗ exit 2');
    const killed = renderShellBlock(
      { code: null, signal: 'SIGINT', output: '', truncated: false },
      plain,
    );
    expect(killed).toEqual(['  ⎿ (no output)', '  ✗ killed (SIGINT)']);
    const spawnFailed = renderShellBlock(
      { code: null, signal: null, output: '', truncated: false, spawnError: 'no shell' },
      plain,
    );
    expect(spawnFailed).toEqual(['  ✗ could not start: no shell']);
  });
});

// ---------------------------------------------------------------------------
// the REPL integration
// ---------------------------------------------------------------------------

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

function replIo(lines: string[]): {
  io: CliIo;
  cap: { out(): string; err(): string; all(): string };
} {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdin: Readable.from(lines.map((l) => `${l}\n`)),
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
  return { io, cap: { out: () => out, err: () => err, all: () => `${out}\n${err}` } };
}

function replCtx(io: CliIo): CliContext {
  return { debug: false, json: false, apiUrl: server.url, io };
}

const chatDirs: string[] = [];
function chatCwd(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-shell-'));
  chatDirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of chatDirs) rmSync(d, { recursive: true, force: true });
});

function installRoutes(): { chatBodies: () => unknown[] } {
  const bodies: unknown[] = [];
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: '{"error":{"code":"auth","message":"nope"}}' };
      }
      bodies.push(JSON.parse(req.body));
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    return { status: 404, body: NOT_FOUND };
  });
  return { chatBodies: () => bodies };
}

describe('the REPL `!` escape', () => {
  it('! echo runs in the project cwd; the block + exit 0 render; NOTHING reaches the model', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { chatBodies } = installRoutes();
    const cwd = chatCwd();
    const { io, cap } = replIo([
      '! echo repl-works',
      '! node -e "process.stdout.write(process.cwd())"',
      '/exit',
    ]);
    await runChat(replCtx(io), { cwd });
    const text = cap.all();
    expect(text).toContain('repl-works');
    expect(text).toContain('· exit 0');
    expect(text).toContain(cwd); // the node one-liner proves the project cwd
    // no chat request was ever made — `!` output is never model input
    expect(chatBodies()).toHaveLength(0);
    expect(cap.all()).toContain('✓ Session ended');
    expect(process.exitCode).toBeUndefined();
  });

  it('a non-zero exit is highlighted (✗ exit N); a bare ! prints the usage hint', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const { io, cap } = replIo(['!exit 7', '!', '/exit']);
    await runChat(replCtx(io), { cwd: chatCwd() });
    const text = cap.all();
    expect(text).toContain('✗ exit 7');
    expect(text).toContain('! runs a shell command here');
    expect(cap.all()).toContain('✓ Session ended');
  });

  it('\\! sends a literal leading bang as a normal message', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const { chatBodies } = installRoutes();
    const { io, cap } = replIo(['\\!not-a-command', '/exit']);
    await runChat(replCtx(io), { cwd: chatCwd() });
    expect(chatBodies()).toHaveLength(1);
    const body = chatBodies()[0] as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages[0]?.content).toBe('!not-a-command');
    expect(cap.all()).toContain('Hello, world!');
  });

  it('long output folds at the last 40 lines with the "… N more lines" marker', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const { io, cap } = replIo([
      `! node -e "for(let i=1;i<=52;i++)console.log('row'+i)"`,
      '/exit',
    ]);
    await runChat(replCtx(io), { cwd: chatCwd() });
    const err = cap.err();
    expect(err).toContain('… 12 more lines');
    expect(err).toContain('row52');
    expect(err).not.toContain('row12\n');
    expect(err).toContain('· exit 0');
  });

  it('Ctrl+C mid-`!` kills the command and keeps the session', { timeout: 15000 }, async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    // a PassThrough stdin: write the command, then \x03 while it runs.
    // The setRawMode stub makes readline treat the stream as raw-capable —
    // without it readline never decodes \x03 into SIGINT (cooked streams
    // hand it to the TTY driver, which a PassThrough does not emulate).
    const stdin = new PassThrough();
    (stdin as PassThrough & { setRawMode?: (m: boolean) => void }).setRawMode = () => {};
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
    // Raw-capable stdin (the SIGINT decode) + a pre-trusted cwd: the trust
    // screen would otherwise open (it keys off rawCapable too) and swallow
    // the typed-ahead '! command' line.
    const cwd = chatCwd();
    trustDir(cwd);
    const session = runChat(replCtx(io), { cwd });
    await until(() => err.includes('❯ '), 'prompt');
    stdin.write('! node -e "setTimeout(()=>{},30000)"\n');
    await sleep(600); // let the child actually start
    stdin.write('\x03'); // Ctrl+C at the prompt layer → kills the child
    // POSIX reports the signal; Windows TerminateProcess reports exit 1 — both
    // are the non-zero/highlighted end of the block
    await until(() => /✗ (killed|exit \d)/.test(err), 'kill rendered');
    stdin.write('/exit\n');
    await session;
    expect(`${out}\n${err}`).toContain('✓ Session ended');
    expect(process.exitCode).toBeUndefined();
  });
});
