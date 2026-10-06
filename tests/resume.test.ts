/**
 * Resume + crash-safe session tests (v0.6), against the mock gateway:
 *  - `selora resume [name]`: named/most-recent resolution, the honest empty
 *    and missing-name errors, non-TTY refusal.
 *  - chat auto-save: a completed turn lands in .selora/sessions/chat.json
 *    immediately; an ABORTED turn never does.
 *  - the launch offer: a saved chat session asks once (y restores the
 *    history, anything else starts fresh); /clear clears the file too.
 *  - run --session mid-run survival: an interrupted run saves the turns
 *    completed so far (never mid-turn state).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  CHAT_STREAM_HANG,
  CHAT_STREAM_TOOL_CALLS,
  FAKE_KEY_USER,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import {
  loadSession,
  newSession,
  saveSession,
  sessionPath,
  SESSION_VERSION,
} from '../src/agent/session/store.js';
import { runChat } from '../src/commands/chat.js';
import { runResume } from '../src/commands/resume.js';
import { runRun } from '../src/commands/run.js';
import { buildProgram } from '../src/program.js';
import type { CliContext, CliIo } from '../src/context.js';

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

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-resume-'));
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

function ctxFor(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

function installRoutes(streams: string[] = [CHAT_STREAM_FULL]): { chatCalls: number } {
  const state = { chatCalls: 0 };
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      const stream = streams[Math.min(state.chatCalls, streams.length - 1)] ?? CHAT_STREAM_FULL;
      state.chatCalls += 1;
      return { status: 200, sse: stream };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
  return state;
}

async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// selora resume
// ---------------------------------------------------------------------------

describe('selora resume', () => {
  it('the program registers resume with the chat-style flags', () => {
    const { io } = replIo([]);
    const program = buildProgram(io);
    const resume = program.commands.find((c) => c.name() === 'resume');
    expect(resume).toBeDefined();
    const flags = resume!.options.map((o) => o.long);
    for (const f of ['--model', '--safe', '--yes', '--json', '--debug', '--api-url']) {
      expect(flags).toContain(f);
    }
  });

  it('empty project: honest message pointing at chat/run --session, exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      const { io, cap } = replIo([]);
      await runResume(ctxFor(io), undefined, { cwd: dir });
      expect(cap.all()).toContain(
        'no sessions in this project — start one: selora chat, or selora run --session <name> "<prompt>"',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('missing or invalid name: honest errors, exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      const missing = replIo([]);
      await runResume(ctxFor(missing.io), 'ghost', { cwd: dir });
      expect(missing.cap.all()).toContain('no session named "ghost" in this project');
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      const bad = replIo([]);
      await runResume(ctxFor(bad.io), '../escape', { cwd: dir });
      expect(bad.cap.all()).toContain('session name must be 1-64 chars');
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('named resume opens the REPL with the history seeded (no question asked)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const s = newSession('work', 'glm-5.3-flash');
      s.messages = [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ];
      saveSession(dir, s);

      const before = server.requests.length;
      const { io, cap } = replIo(['follow up', '/exit']);
      await runResume(ctxFor(io), 'work', { cwd: dir });

      const text = cap.all();
      expect(text).toContain('Resumed session "work" — 2 messages restored');
      expect(text).not.toContain('Resume the previous session?');
      const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
      const body = JSON.parse(chatReq!.body) as { messages: Array<Record<string, unknown>> };
      expect(body.messages).toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'follow up' },
      ]);
      // the session kept saving under the SAME name
      const saved = loadSession(dir, 'work');
      expect(saved).not.toBeNull();
      expect(saved!.messages).toHaveLength(4);
      expect(saved!.version).toBe(SESSION_VERSION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bare resume picks the most recently updated session and adopts its model', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const older = {
        ...newSession('older', 'glm-5.3-flash'),
        updatedAt: '2026-10-05T10:00:00.000Z',
        messages: [{ role: 'user', content: 'old' }] as never,
      };
      const newer = {
        ...newSession('newer', 'gpt-5.2-mini'),
        updatedAt: '2026-10-05T11:00:00.000Z',
        messages: [{ role: 'user', content: 'recent' }] as never,
      };
      mkdirSync(join(dir, '.selora', 'sessions'), { recursive: true });
      writeFileSync(sessionPath(dir, 'older'), JSON.stringify(older), 'utf8');
      writeFileSync(sessionPath(dir, 'newer'), JSON.stringify(newer), 'utf8');

      const before = server.requests.length;
      const { io, cap } = replIo(['next', '/exit']);
      await runResume(ctxFor(io), undefined, { cwd: dir });

      expect(cap.all()).toContain('Resumed session "newer" — 1 messages restored');
      // the session's model won over the configured default
      const modelReq = server.requests
        .slice(before)
        .find((r) => r.path === '/v1/models/gpt-5.2-mini');
      expect(modelReq).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-TTY stdin: the honest needs-a-terminal error (a REPL cannot run on a pipe)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const s = newSession('work', 'glm-5.3-flash');
      s.messages = [{ role: 'user', content: 'hi' }];
      saveSession(dir, s);
      const { io, cap } = replIo([]);
      const nonTTY: CliIo = { ...io, stdin: Readable.from([]), isTTY: false };
      await runResume(ctxFor(nonTTY), 'work', { cwd: dir });
      expect(cap.all()).toContain(
        'selora chat needs an interactive terminal — use: selora run "<prompt>"',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// chat auto-save + the launch offer
// ---------------------------------------------------------------------------

describe('chat auto-save', () => {
  it('a completed turn lands in .selora/sessions/chat.json immediately; the exit hints at resume', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const { io, cap } = replIo(['hello', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });

      const saved = loadSession(dir, 'chat');
      expect(saved).not.toBeNull();
      expect(saved!.version).toBe(SESSION_VERSION);
      expect(saved!.model).toBe('glm-5.3-flash');
      expect(saved!.messages).toEqual([
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Hello, world!' },
      ]);
      expect(cap.all()).toContain('Conversation saved — resume it with: selora resume');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an ABORTED turn never reaches the file — only completed turns persist', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    // hang the SECOND stream of THIS test mid-reply (requests are counted
    // relative to the test's start — the server is shared across the file)
    const chatStart = server.requests.filter((r) => r.path === '/v1/chat/completions').length;
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
      }
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        const n =
          server.requests.filter((r) => r.path === '/v1/chat/completions').length - chatStart;
        return n >= 2
          ? { status: 200, sse: CHAT_STREAM_HANG, sseHang: true }
          : { status: 200, sse: CHAT_STREAM_FULL };
      }
      return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
    });
    const dir = tempProject();
    try {
      const { io, cap } = replIo(['first', 'second', '/exit']);
      const before = server.requests.length;
      let interrupt: (() => void) | undefined;
      const done = runChat(
        ctxFor(io),
        { cwd: dir },
        {
          registerInterrupt: (fn) => {
            interrupt = fn;
          },
        },
      );
      await until(
        () =>
          server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions').length >=
          2,
        'second chat request started',
      );
      interrupt!();
      await done;

      expect(cap.all()).toContain('Request cancelled — session kept');
      const saved = loadSession(dir, 'chat');
      expect(saved).not.toBeNull();
      // ONLY the first completed turn — the aborted pair is nowhere
      expect(saved!.messages).toEqual([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'Hello, world!' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('/clear clears the saved session too — a cleared chat offers no resume', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const { io } = replIo(['hello', '/clear', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });
      const saved = loadSession(dir, 'chat');
      expect(saved).not.toBeNull();
      expect(saved!.messages).toEqual([]);

      // relaunch: NO offer is made (nothing to resume)
      const again = replIo(['/exit']);
      await runChat(ctxFor(again.io), { cwd: dir });
      expect(again.cap.all()).not.toContain('Resume the previous session?');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('chat resume offer', () => {
  it('a saved chat session asks once; "y" restores the full history', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const s = newSession('chat', 'glm-5.3-flash');
      s.messages = [
        { role: 'user', content: 'saved question' },
        { role: 'assistant', content: 'saved answer' },
      ];
      saveSession(dir, s);

      const before = server.requests.length;
      const { io, cap } = replIo(['y', 'follow up', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });

      const text = cap.all();
      expect(text).toContain('Resume the previous session? (2 messages,');
      expect(text).toContain('Resumed session "chat" — 2 messages restored');
      const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
      const body = JSON.parse(chatReq!.body) as { messages: Array<Record<string, unknown>> };
      expect(body.messages).toEqual([
        { role: 'user', content: 'saved question' },
        { role: 'assistant', content: 'saved answer' },
        { role: 'user', content: 'follow up' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('any answer other than y starts FRESH — the saved file is untouched until a turn completes', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const s = newSession('chat', 'glm-5.3-flash');
      s.messages = [
        { role: 'user', content: 'saved question' },
        { role: 'assistant', content: 'saved answer' },
      ];
      saveSession(dir, s);

      const before = server.requests.length;
      const { io, cap } = replIo(['n', 'brand new', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });

      expect(cap.all()).not.toContain('messages restored');
      const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
      const body = JSON.parse(chatReq!.body) as { messages: Array<Record<string, unknown>> };
      // no history leaked into the fresh conversation
      expect(body.messages).toEqual([{ role: 'user', content: 'brand new' }]);
      // and the file now holds the NEW conversation (the completed turn saved)
      const saved = loadSession(dir, 'chat');
      expect(saved!.messages[0]).toEqual({ role: 'user', content: 'brand new' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run --session mid-run survival
// ---------------------------------------------------------------------------

describe('run --session crash safety', () => {
  it('an interrupted run saves the turns completed so far (never mid-turn state)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      // the tool round's target exists so the read succeeds
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      const chatStart = server.requests.filter((r) => r.path === '/v1/chat/completions').length;
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          const n =
            server.requests.filter((r) => r.path === '/v1/chat/completions').length - chatStart;
          return n >= 2
            ? { status: 200, sse: CHAT_STREAM_HANG, sseHang: true }
            : { status: 200, sse: CHAT_STREAM_TOOL_CALLS };
        }
        return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
      });

      const { io, cap } = replIo([]);
      const before = server.requests.length;
      let interrupt: (() => void) | undefined;
      const done = runRun(
        ctxFor(io),
        'read it',
        { cwd: dir, session: 'crashy', yes: true },
        {
          registerInterrupt: (fn) => {
            interrupt = fn;
          },
        },
      );
      // turn 1 (tool call) completes, turn 2 hangs → interrupt it
      await until(
        () =>
          server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions').length >=
          2,
        'second chat request started',
      );
      interrupt!();
      await done;

      const text = cap.all();
      expect(text).toContain('Interrupted — request cancelled.');
      expect(text).toContain(
        'session "crashy" saved up to the last completed turn — resume: selora resume crashy',
      );
      expect(process.exitCode).toBe(130);

      // the saved history is exactly the completed turn: user, the assistant
      // tool-call echo, the tool result — a wire-valid resumable shape
      const saved = loadSession(dir, 'crashy');
      expect(saved).not.toBeNull();
      expect(saved!.version).toBe(SESSION_VERSION);
      expect(saved!.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
      const assistant = saved!.messages[1]!;
      expect(assistant.role === 'assistant' && assistant.tool_calls?.[0]?.function.name).toBe(
        'read_file',
      );
      const tool = saved!.messages[2]!;
      expect(tool.role === 'tool' && tool.content).toContain('export const x = 1;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an interruption with NO completed turns writes nothing (fresh session)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          return { status: 200, sse: CHAT_STREAM_HANG, sseHang: true };
        }
        return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
      });
      const { io, cap } = replIo([]);
      const before = server.requests.length;
      let interrupt: (() => void) | undefined;
      const done = runRun(
        ctxFor(io),
        'doomed',
        { cwd: dir, session: 'never' },
        {
          registerInterrupt: (fn) => {
            interrupt = fn;
          },
        },
      );
      await until(
        () => server.requests.slice(before).some((r) => r.path === '/v1/chat/completions'),
        'chat request started',
      );
      interrupt!();
      await done;
      expect(cap.all()).toContain('Interrupted — request cancelled.');
      expect(cap.all()).not.toContain('saved up to the last completed turn');
      expect(loadSession(dir, 'never')).toBeNull();
      expect(process.exitCode).toBe(130);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
