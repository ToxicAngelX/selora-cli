/**
 * Phase 4 init/run integration tests against the local mock gateway, driven
 * through injected CliContext (the chat.test.ts style). Covers:
 *  - init: exact selora.json content, model verification via the PUBLIC
 *    /v1/models/:id route with NO auth header, overwrite refusal without
 *    --force, --force overwrite, 404 → no file, --json shapes.
 *  - run: one-shot streaming through the SAME pipeline as chat (deltas +
 *    real-numbers footer), real wire-based tool_calls detection, 402 verbatim
 *    + exit 1, the model hierarchy (flag > project selora.json > global
 *    default), and buffered --json output.
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  CHAT_STREAM_INBAND_ERROR,
  CHAT_STREAM_TOOL_CALLS,
  FAKE_KEY_USER,
  MODEL_NOT_FOUND_404,
  REVOKED_KEY_401,
  WINDOW_EXHAUSTED_402,
  modelDetailBody,
} from './mock/fixtures.js';
import { capturedIo, cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { projectConfigPath } from '../src/config/project.js';
import { runInit } from '../src/commands/init.js';
import { runRun } from '../src/commands/run.js';
import type { CliContext, CliIo } from '../src/context.js';

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';
const WINDOW_RESET_TEXT = 'Plan usage resumes at 2026-10-05T14:00:00Z.';
const EXPECTED_INIT_JSON = {
  version: 1,
  model: 'glm-5.3-flash',
  context: {
    include: ['src/**/*', 'docs/**/*.md'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
};

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
  return mkdtempSync(join(tmpdir(), 'selora-proj-'));
}

function ctx(io: CliIo, json = false, debug = false): CliContext {
  return { debug, json, apiUrl: server.url, io };
}

/** Models route (public) + chat route (key-authed, canned stream). */
function installRoutes(stream: string[]): void {
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
      return { status: 200, sse: stream };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

// ---------------------------------------------------------------------------
// selora init
// ---------------------------------------------------------------------------

describe('init', () => {
  it('writes the exact selora.json; model verified via /v1/models/:id with NO auth header', async () => {
    saveConfig({});
    const dir = tempProject();
    try {
      installRoutes([]);
      const { io, cap } = capturedIo();
      await runInit(ctx(io), { cwd: dir });
      // exact file content
      const parsed = JSON.parse(readFileSync(projectConfigPath(dir), 'utf8')) as unknown;
      expect(parsed).toEqual(EXPECTED_INIT_JSON);
      // honest messaging
      expect(cap.out.join('\n')).toContain('✓ Wrote selora.json (model: glm-5.3-flash)');
      expect(cap.err.join('\n')).toContain(
        '· the agent enforces context.exclude for read/search tools; an optional "agent" section (maxTurns, allowWindowsCmd) can be hand-edited (see docs/agent.md)',
      );
      // the verification request carried NO auth header (public internal flavor)
      const modelReq = server.requests.find((r) => r.path === '/v1/models/glm-5.3-flash');
      expect(modelReq).toBeDefined();
      expect(modelReq!.headers['authorization']).toBeUndefined();
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an existing selora.json without --force (exit 1, no clobber)', async () => {
    saveConfig({});
    const dir = tempProject();
    try {
      installRoutes([]);
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ version: 1, model: 'old-model' }),
        'utf8',
      );
      const { io, cap } = capturedIo();
      await runInit(ctx(io), { cwd: dir });
      expect(cap.err.join('\n')).toContain('✗ selora.json already exists (use --force)');
      expect(process.exitCode).toBe(1);
      // the original file is untouched
      expect(JSON.parse(readFileSync(projectConfigPath(dir), 'utf8'))).toEqual({
        version: 1,
        model: 'old-model',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--force overwrites the existing file', async () => {
    saveConfig({});
    const dir = tempProject();
    try {
      installRoutes([]);
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ version: 1, model: 'old-model' }),
        'utf8',
      );
      const { io, cap } = capturedIo();
      await runInit(ctx(io), { cwd: dir, force: true });
      expect(JSON.parse(readFileSync(projectConfigPath(dir), 'utf8'))).toEqual(EXPECTED_INIT_JSON);
      expect(cap.out.join('\n')).toContain('✓ Wrote selora.json (model: glm-5.3-flash)');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown --model: honest 404 + hint, exit 1, NO file written', async () => {
    saveConfig({});
    const dir = tempProject();
    try {
      installRoutes([]);
      const before = server.requests.length;
      const { io, cap } = capturedIo();
      await runInit(ctx(io), { cwd: dir, model: 'no-such-model' });
      expect(cap.err.join('\n')).toContain('✗ Model not available');
      expect(cap.err.join('\n')).toContain('List available models with: selora models');
      expect(process.exitCode).toBe(1);
      expect(existsSync(projectConfigPath(dir))).toBe(false);
      // exactly one request: the failed verification, no chat traffic
      expect(
        server.requests.slice(before).every((r) => r.path === '/v1/models/no-such-model'),
      ).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('model falls back to the global defaultModel when --model is absent', async () => {
    saveConfig({ defaultModel: 'claude-haiku-4.5' });
    const dir = tempProject();
    try {
      installRoutes([]);
      const { io, cap } = capturedIo();
      await runInit(ctx(io), { cwd: dir });
      expect(JSON.parse(readFileSync(projectConfigPath(dir), 'utf8'))).toEqual({
        ...EXPECTED_INIT_JSON,
        model: 'claude-haiku-4.5',
      });
      expect(cap.out.join('\n')).toContain('✓ Wrote selora.json (model: claude-haiku-4.5)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json: {ok:true, path, model, created:true}; --force on an existing file → overwritten:true', async () => {
    saveConfig({});
    const dir = tempProject();
    try {
      installRoutes([]);
      const first = capturedIo();
      await runInit(ctx(first.io, true), { cwd: dir });
      const created = JSON.parse(first.cap.out.join('')) as Record<string, unknown>;
      expect(created).toEqual({
        ok: true,
        path: projectConfigPath(dir),
        model: 'glm-5.3-flash',
        created: true,
      });
      // plain human bullet must NOT appear in json mode
      expect(first.cap.err.join('\n')).not.toContain('v0.1 stores this config only');

      const second = capturedIo();
      await runInit(ctx(second.io, true), { cwd: dir, force: true });
      const overwritten = JSON.parse(second.cap.out.join('')) as Record<string, unknown>;
      expect(overwritten).toEqual({
        ok: true,
        path: projectConfigPath(dir),
        model: 'glm-5.3-flash',
        overwritten: true,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// selora run
// ---------------------------------------------------------------------------

describe('run', () => {
  it('one-shot: streams deltas raw to stdout + the real-numbers footer; run requests carry the agent tool definitions', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(CHAT_STREAM_FULL);
    const before = server.requests.length;
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'hello there', {});
    // streamed content, raw, immediate — exactly the deltas + the trailing newline
    expect(cap.outText()).toBe('Hello, world!\n');
    // reasoning went to the raw stderr channel (dim gray), then its newline
    expect(cap.errText()).toBe('(thinking about it)\n');
    // footer: real numbers only (usage chunk DID arrive), chat's formatting
    expect(cap.out.join('\n')).toContain('  Tokens: 6,055 · Cost: $0.018');
    // the request body: single user message + the agent tool bridge
    const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
    const body = JSON.parse(chatReq!.body) as Record<string, unknown>;
    expect(body['model']).toBe('glm-5.3-flash');
    expect(body['messages']).toEqual([{ role: 'user', content: 'hello there' }]);
    expect(body['stream']).toBe(true);
    expect(body['stream_options']).toEqual({ include_usage: true });
    // v0.2: run attaches the built-in tool definitions (OpenAI dialect)
    expect(body['tool_choice']).toBe('auto');
    const tools = body['tools'] as Array<Record<string, unknown>>;
    const toolNames = (tools.map((t) => (t['function'] as Record<string, unknown>)['name']) as string[]);
    expect(toolNames).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'run_command',
      'git_status',
      'git_diff',
      'git_log',
      'git_commit',
      'git_restore',
    ]);
    // each definition is the verified wire shape
    for (const t of tools) {
      expect(t['type']).toBe('function');
      const fn = t['function'] as Record<string, unknown>;
      expect(typeof fn['description']).toBe('string');
      expect((fn['parameters'] as Record<string, unknown>)['type']).toBe('object');
    }
    // no model-verification request — run does not pre-verify (the gateway
    // rejects unknown models at request time)
    expect(server.requests.slice(before).some((r) => r.path.startsWith('/v1/models/'))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it('tool_calls: permission prompt (stdin closed → deny), result fed back, second stream answers — no v0.1 gray line', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      // first request → the tool-call stream; every later request → the plain answer
      let chatCalls = 0;
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
            return { status: 401, body: REVOKED_KEY_401 };
          }
          chatCalls += 1;
          return { status: 200, sse: chatCalls === 1 ? CHAT_STREAM_TOOL_CALLS : CHAT_STREAM_FULL };
        }
        return { status: 404, body: NOT_FOUND };
      });
      const before = server.requests.length;
      const { io, cap } = capturedIo();
      await runRun(ctx(io), 'what does src/index.ts do?', { cwd: dir });
      // both turns streamed their content
      expect(cap.outText()).toContain('I would read a file for that.');
      expect(cap.outText()).toContain('Hello, world!');
      // live tool progress: the call line, the dry-run preview prompt, the denial
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('→ read_file(src/index.ts)');
      expect(err).toContain('└─ Allow? [y]es / [n]o / [a]lways this session');
      expect(err).toContain('· denied by user');
      expect(err).toContain('permission prompt closed without an answer — treating as no');
      // per-turn footers (240 then 6,055) and the cumulative line
      const out = cap.out.join('\n');
      expect(out).toContain('  Tokens: 240 · Cost: $0.002');
      expect(out).toContain('  Tokens: 6,055 · Cost: $0.018');
      expect(out).toContain('Agent totals: 2 turns · Tokens: 6,295 · Cost: $0.020');
      // the v0.1 gray line is GONE — this is real execution now
      expect(err).not.toContain('agent mode not implemented');
      // exactly two chat requests; the second carried the tool echo + result
      const chatReqs = server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions');
      expect(chatReqs).toHaveLength(2);
      const second = JSON.parse(chatReqs[1]!.body) as {
        messages: Array<Record<string, unknown>>;
      };
      // [user, assistant echo with tool_calls, tool result] — the echo carries
      // the streamed content + the calls verbatim (the verified round-trip shape)
      expect(second.messages).toHaveLength(3);
      expect(second.messages[0]).toEqual({ role: 'user', content: 'what does src/index.ts do?' });
      const echo = second.messages[1] as Record<string, unknown>;
      expect(echo['role']).toBe('assistant');
      expect(echo['content']).toBe('I would read a file for that.');
      expect(echo['tool_calls']).toEqual([
        {
          id: 'call_TEST1',
          type: 'function',
          function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
        },
      ]);
      expect(second.messages[2]).toEqual({
        role: 'tool',
        tool_call_id: 'call_TEST1',
        content: 'Permission denied by user.',
      });
      // the follow-up request carries the tool definitions again
      expect((JSON.parse(chatReqs[1]!.body) as { tools: unknown[] }).tools.length).toBe(11);
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a plain reply never prints tool activity (negative control)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(CHAT_STREAM_FULL);
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'read the file please', {});
    expect(cap.err.join('\n')).not.toContain('agent mode not implemented');
    expect(cap.errText()).not.toContain('→ ');
  });

  it('402 window-exhausted before the stream: verbatim message + exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    server.setHandler((req) => {
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        return { status: 402, body: WINDOW_EXHAUSTED_402 };
      }
      return { status: 404, body: NOT_FOUND };
    });
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'oops', {});
    const err = cap.err.join('\n');
    expect(err).toContain('✗ Your 4h plan usage limit is reached');
    expect(err).toContain(WINDOW_RESET_TEXT);
    expect(process.exitCode).toBe(1);
  });

  it('in-band stream error (402 mid-stream): verbatim message + exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(CHAT_STREAM_INBAND_ERROR);
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'oops', {});
    const err = cap.err.join('\n');
    expect(err).toContain('✗ Your 4h plan usage limit is reached');
    expect(err).toContain(WINDOW_RESET_TEXT);
    // the partial line was terminated before the error
    expect(cap.outText()).toBe('partial \n');
    expect(process.exitCode).toBe(1);
  });

  it('model hierarchy: project selora.json overrides the global default; --model beats the project', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER, defaultModel: 'claude-haiku-4.5' });
    const dir = tempProject();
    try {
      installRoutes(CHAT_STREAM_FULL);
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({
          version: 1,
          model: 'gpt-5.2-mini',
          context: { include: ['src/**/*'], exclude: [] },
        }),
        'utf8',
      );
      const before = server.requests.length;

      // project wins over the global default
      const first = capturedIo();
      await runRun(ctx(first.io, false, true), 'hi', { cwd: dir });
      const body1 = JSON.parse(
        server.requests.slice(before).find((r) => r.path === '/v1/chat/completions')!.body,
      ) as { model: string };
      expect(body1.model).toBe('gpt-5.2-mini');
      // the resolution source is reported only under --debug
      expect(first.cap.err.join('\n')).toContain(
        'model: gpt-5.2-mini (resolved from project selora.json)',
      );

      // the flag beats the project file
      const second = capturedIo();
      await runRun(ctx(second.io), 'hi', { cwd: dir, model: 'kimi-k2' });
      const body2 = JSON.parse(server.requests.slice(before).at(-1)!.body) as { model: string };
      expect(body2.model).toBe('kimi-k2');
      // and the flag run stayed silent about resolution (no --debug)
      expect(second.cap.err.join('\n')).not.toContain('resolved from');

      // with no project file, the global default applies
      const bare = tempProject();
      try {
        const third = capturedIo();
        await runRun(ctx(third.io, false, true), 'hi', { cwd: bare });
        const body3 = JSON.parse(server.requests.slice(before).at(-1)!.body) as { model: string };
        expect(body3.model).toBe('claude-haiku-4.5');
        expect(third.cap.err.join('\n')).toContain('resolved from global default model');
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json: ONE buffered object on stdout, nothing streamed raw', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(CHAT_STREAM_FULL);
    const { io, cap } = capturedIo();
    await runRun(ctx(io, true), 'hello', {});
    // exactly one JSON object, pretty-printed on stdout
    const parsed = JSON.parse(cap.out.join('')) as Record<string, unknown>;
    expect(parsed).toEqual({
      ok: true,
      model: 'glm-5.3-flash',
      content: 'Hello, world!',
      finishReason: 'stop',
      turns: 1,
      tools: [],
      usage: { promptTokens: 4821, completionTokens: 1234, totalTokens: 6055 },
      charge: '0.018234',
    });
    // no streamed deltas, no human footer — machine output only
    expect(cap.outText()).toBe('');
    expect(cap.out.join('\n')).not.toContain('Tokens:');
    expect(process.exitCode).toBeUndefined();
  });

  it('missing prompt: honest usage error + exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes(CHAT_STREAM_FULL);
    const before = server.requests.length;
    const { io, cap } = capturedIo();
    await runRun(ctx(io), undefined, {});
    expect(cap.err.join('\n')).toContain('✗ Usage: selora run "<prompt>"');
    expect(process.exitCode).toBe(1);
    // no request was ever made
    expect(server.requests.slice(before).length).toBe(0);
  });

  it('no stored key: standard auth error + exit 1', async () => {
    saveConfig({});
    installRoutes(CHAT_STREAM_FULL);
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'hello', {});
    expect(cap.err.join('\n')).toContain('✗ You are not logged in. Run: selora login');
    expect(process.exitCode).toBe(1);
  });
});
