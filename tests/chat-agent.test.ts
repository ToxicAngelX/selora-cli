/**
 * v0.3 chat agent tests (mock gateway): the REPL now runs the agent loop —
 * the startup screen renders (logo + info box), tool calls prompt through the
 * SHARED readline (answers piped as lines), tools display as ● / ⎿ lines, the
 * markdown renderer streams the reply, slash commands work (/theme /clear
 * /tools /permissions /cost), and the exit summary reports files changed.
 * All output is plain (no ANSI): the real stdout is not a TTY in tests, which
 * is exactly the NO_COLOR/non-TTY contract.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  CHAT_STREAM_TOOL_CALLS,
  FAKE_KEY_USER,
  MODEL_NOT_FOUND_404,
  REVOKED_KEY_401,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { runChat } from '../src/commands/chat.js';
import type { CliContext, CliIo } from '../src/context.js';
import { VERSION } from '../src/version.js';

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

function ctx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

/** routes: models always OK; chat rounds then the plain answer. */
function routeToolRounds(rounds: number): void {
  let chatCalls = 0;
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.path.slice('/v1/models/'.length));
      if (id === 'no-such-model') return { status: 404, body: MODEL_NOT_FOUND_404 };
      return { status: 200, body: modelDetailBody(id) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      chatCalls += 1;
      return { status: 200, sse: chatCalls <= rounds ? CHAT_STREAM_TOOL_CALLS : CHAT_STREAM_FULL };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

describe('chat agent — startup screen + tool round-trip', () => {
  it('the startup screen renders (logo + info box: version/model/cwd/plan), plain when color is off', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routeToolRounds(0);
    const { io, cap } = replIo(['/exit']);
    await runChat(ctx(io), {});
    const out = cap.out();
    // the block logo (or compact line under 60 cols — the box is shared)
    expect(out).toContain(VERSION);
    expect(out).toContain('glm-5.3-flash');
    expect(out).toContain('GLM 5.3 Flash');
    // plan fetch failed against the mock (404) — honest degradation
    expect(out).toContain('unknown');
    // tips
    expect(out).toContain('/help for commands');
    expect(out).toContain('Ctrl+C');
    // NO ANSI: the real stdout is not a TTY, so the theme is level 0
    expect(out).not.toContain('\x1b[');
    expect(cap.err()).not.toContain('\x1b[');
  });

  it('a tool call mid-conversation: ●/⎿ display, shared-readline approval, real result to the model', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routeToolRounds(1);
    const before = server.requests.length;
    // 'y' answers the permission prompt through the SHARED readline queue
    const { io, cap } = replIo(['read it', 'y', '/exit']);
    await runChat(ctx(io), {});

    const err = cap.err();
    // the v0.2 line-based permission box (piped stdin has no raw mode)
    expect(err).toContain('┌─ read_file(src/index.ts)');
    expect(err).toContain('└─ Allow? [y]es / [n]o / [a]lways this session');
    // the v0.3 rich tool display
    expect(err).toContain('● Read(src/index.ts)');
    expect(err).toContain('⎿');
    // the model got the REAL file content (repo's src/index.ts)
    const chatReqs = server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBe(2);
    const body = JSON.parse(chatReqs[1]!.body) as {
      tools: unknown[];
      messages: Array<Record<string, unknown>>;
    };
    // the request carried the full 18-tool registry
    expect(body.tools.length).toBe(18);
    expect(String(body.messages[2]!['content'])).toContain('import');
    // the final answer rendered through the markdown stream
    expect(cap.out()).toContain('Hello, world!');
    // history adoption: the follow-up request carries the full exchange
    // (the final assistant answer is the RESPONSE to this request)
    expect(body.messages.map((m) => m['role'])).toEqual(['user', 'assistant', 'tool']);
    expect(process.exitCode).toBeUndefined();
  });

  it('a denied tool feeds back politely and the conversation continues', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routeToolRounds(1);
    const before = server.requests.length;
    const { io, cap } = replIo(['read it', 'n', '/exit']);
    await runChat(ctx(io), {});
    const err = cap.err();
    // the rich display's ⎿ line carries the denial
    expect(err).toContain('denied by user');
    const chatReqs = server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions');
    const body = JSON.parse(chatReqs[1]!.body) as { messages: Array<Record<string, unknown>> };
    expect(String(body.messages[2]!['content'])).toBe('Permission denied by user.');
    expect(cap.out()).toContain('Hello, world!');
  });

  it('files changed by an approved write land in the exit summary', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    // one write_file round (writes out.txt into the process cwd — the REPL's
    // sandbox root), then the answer
    const writeRound: string[] = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_W9","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"out.txt\\",\\"content\\":\\"v3 test\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12},"gateway":{"charge":"0.000100"}}\n\n',
      'data: [DONE]\n\n',
    ];
    let calls = 0;
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
      }
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        calls += 1;
        return { status: 200, sse: calls === 1 ? writeRound : CHAT_STREAM_FULL };
      }
      return { status: 404, body: NOT_FOUND };
    });
    // The REPL's sandbox root is the process cwd — run this test from a temp
    // dir so the write lands there, not in the repository.
    const sandbox = mkdtempSync(join(tmpdir(), 'selora-chat-agent-'));
    const prevCwd = process.cwd();
    process.chdir(sandbox);
    try {
      const { io, cap } = replIo(['write it', 'y', '/exit']);
      await runChat(ctx(io), {});
      const text = cap.all();
      expect(text).toContain('● Write(out.txt)');
      // the file really appeared in the sandbox
      expect(existsSync(join(sandbox, 'out.txt'))).toBe(true);
      // the exit summary names the change
      expect(text).toContain('1 file change');
      expect(text).toContain('write_file(out.txt)');
      expect(text).toContain('Session ended');
    } finally {
      process.chdir(prevCwd);
      rmSync(sandbox, { recursive: true, force: true });
    }
  });
});

describe('chat agent — slash commands', () => {
  it('/tools, /permissions, /cost, /clear, /theme — all live in the REPL', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routeToolRounds(0);
    const { io, cap } = replIo([
      '/tools',
      '/permissions',
      '/cost',
      '/theme nebula',
      '/theme',
      '/theme hotdog',
      '/clear',
      '/exit',
    ]);
    await runChat(ctx(io), {});
    const text = cap.all();
    expect(text).toContain('Tools (18, mode: ask): read_file');
    expect(text).toContain('Nothing auto-allowed yet');
    expect(text).toContain('Requests: 0');
    expect(text).toContain('✓ Theme set to nebula');
    expect(text).toContain('Current theme: nebula');
    expect(text).toContain('unknown theme "hotdog"');
    expect(text).toContain('History cleared.');
    // the theme was persisted to the global config
    expect(loadConfig().theme).toBe('nebula');
    expect(process.exitCode).toBeUndefined();
  });

  it('/model with an argument still verifies before switching', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routeToolRounds(0);
    const { io, cap } = replIo(['/model no-such-model', '/exit']);
    await runChat(ctx(io), {});
    const text = cap.all();
    expect(text).toContain('✗ Model not available');
    expect(text).not.toContain('Switched to');
  });
});
