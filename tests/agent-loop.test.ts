/**
 * The agent loop end-to-end against the local mock gateway (run-init style:
 * injected CliContext + canned SSE). Covers the paths run-init's deny test
 * does not:
 *  - APPROVAL: 'y' executes the real tool and feeds the REAL file content
 *    back to the model as the tool message.
 *  - 'a' (always): one prompt, then session-scoped auto-allow for the rest
 *    of the run (never written to disk).
 *  - --yes: non-interactive execution with NO prompt at all.
 *  - --safe: only read-only tools are sent on the wire; a write tool call is
 *    fed back as unknown.
 *  - --json without --yes: every tool denied, machine shape still complete.
 *  - the 3-consecutive-failure circuit breaker (exit 1, honest error).
 *  - the turn cap (--max-turns flag + selora.json agent.maxTurns + invalid
 *    values refused).
 *  - sessions: --session saves on completion, resumes history on the next
 *    run, model resolution prefers the resumed session.
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  CHAT_STREAM_TOOL_CALLS,
  CHAT_STREAM_TOOL_CALL_BAD_JSON,
  CHAT_STREAM_TOOL_CALL_UNKNOWN,
  FAKE_KEY_USER,
  REVOKED_KEY_401,
  WINDOW_EXHAUSTED_402,
} from './mock/fixtures.js';
import { capturedIo, cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { runRun } from '../src/commands/run.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { SeloraClient } from '../src/api/client.js';
import type { PermissionAsker } from '../src/agent/permissions.js';
import type { ReviewDecision } from '../src/diff/types.js';
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

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-loop-'));
}

function ctx(io: CliIo, json = false, debug = false): CliContext {
  return { debug, json, apiUrl: server.url, io };
}

/** capturedIo, but stdin yields the given lines (permission answers). */
function ioWithStdin(lines: string[]): ReturnType<typeof capturedIo> {
  const base = capturedIo();
  const io: CliIo = { ...base.io, stdin: Readable.from(lines.map((l) => `${l}\n`)) };
  return { io, cap: base.cap };
}

/** First N chat requests → tool-call streams, then CHAT_STREAM_FULL answers. */
function routeToolRounds(rounds: number, sse: string[]): void {
  let chatCalls = 0;
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      chatCalls += 1;
      return { status: 200, sse: chatCalls <= rounds ? sse : CHAT_STREAM_FULL };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

function routePlain(): void {
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

/** A write_file round (wire shapes from the live recon), inline. */
const WRITE_ROUND: string[] = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_W1","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"out.txt\\",\\"content\\":\\"hi from the agent\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120},"gateway":{"charge":"0.001000"}}\n\n',
  'data: [DONE]\n\n',
];

/** Same shape, but writing a DIFFERENT path (label-scoping of 'a' for writes). */
const WRITE_ROUND_OTHER: string[] = WRITE_ROUND.map((f) =>
  f.replace('call_W1', 'call_W2').replace('out.txt', 'other.txt'),
);

/** A run_command round — an exec tool (the only kind offering [e]dit). */
const COMMAND_ROUND: string[] = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_C1","type":"function","function":{"name":"run_command","arguments":"{\\"command\\":\\"printf original\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20,"total_tokens":120},"gateway":{"charge":"0.001000"}}\n\n',
  'data: [DONE]\n\n',
];

/** chat request N (1-based) → the Nth SSE round; anything after → the answer. */
function routeRounds(rounds: string[][]): void {
  let calls = 0;
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      calls += 1;
      return { status: 200, sse: calls <= rounds.length ? rounds[calls - 1]! : CHAT_STREAM_FULL };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

// ---------------------------------------------------------------------------
// approval paths
// ---------------------------------------------------------------------------

describe('agent loop — permission paths', () => {
  it("'y' executes the REAL tool: file content goes back to the model, file untouched", async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      routeToolRounds(1, CHAT_STREAM_TOOL_CALLS);
      const before = server.requests.length;
      const { io, cap } = ioWithStdin(['y']);
      await runRun(ctx(io), 'what does src/index.ts do?', { cwd: dir });

      // the permission prompt rendered the preview, then the real run happened
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('┌─ read_file(src/index.ts)');
      expect(err).toContain('└─ Allow? [y]es / [n]o / [a]lways this session');
      expect(err).toContain('· read src/index.ts (1 line');
      expect(err).not.toContain('denied by user');
      // read-only: the file still exists with its original content
      expect(readFileSync(join(dir, 'src', 'index.ts'), 'utf8')).toBe('export const x = 1;\n');

      // the second request carries the REAL tool result, not a denial
      const chatReqs = server.requests
        .slice(before)
        .filter((r) => r.path === '/v1/chat/completions');
      expect(chatReqs).toHaveLength(2);
      const second = JSON.parse(chatReqs[1]!.body) as { messages: Array<Record<string, unknown>> };
      expect(second.messages[2]!['role']).toBe('tool');
      expect(second.messages[2]!['tool_call_id']).toBe('call_TEST1');
      expect(String(second.messages[2]!['content'])).toContain('export const x = 1;');
      // cumulative budget line spans both turns
      expect(cap.out.join('\n')).toContain('Agent totals: 2 turns · Tokens: 6,295 · Cost: $0.020');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'a' (always this session): prompts ONCE, then auto-allows the same read; nothing persisted", async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      routeToolRounds(2, CHAT_STREAM_TOOL_CALLS); // two read_file rounds
      const { io, cap } = ioWithStdin(['a']);
      await runRun(ctx(io), 'read it twice', { cwd: dir });

      const err = cap.errText() + cap.err.join('\n');
      // exactly ONE prompt box for two identical calls
      expect(err.match(/┌─ read_file/g)?.length).toBe(1);
      expect(err).toContain('· allowed for this session');
      // both tool rounds really executed
      expect(err.match(/· read src\/index\.ts/g)?.length).toBe(2);
      // three requests total: tool, tool, answer
      const out = cap.out.join('\n');
      expect(out).toContain('Agent totals: 3 turns');
      // auto-allows are memory-only: no file anywhere records them
      expect(existsSync(join(dir, '.selora'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("'a' on a WRITE covers only that exact label — a different write prompts again", async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routeRounds([WRITE_ROUND, WRITE_ROUND_OTHER]);
      const { io, cap } = ioWithStdin(['a', 'n']);
      await runRun(ctx(io), 'write two files', { cwd: dir });
      const err = cap.errText() + cap.err.join('\n');
      // both writes prompted (different labels) — "always" did not leak across
      expect(err.match(/┌─ write_file/g)?.length).toBe(2);
      expect(err).toContain('┌─ write_file(out.txt)');
      expect(err).toContain('┌─ write_file(other.txt)');
      // first approved ('a'), second denied ('n')
      expect(err).toContain('· wrote out.txt');
      expect(err).toContain('· denied by user');
      expect(existsSync(join(dir, 'out.txt'))).toBe(true);
      expect(existsSync(join(dir, 'other.txt'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an explicit 'n' denies politely: denial text to the model, run completes, exit 0", async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      routeToolRounds(1, CHAT_STREAM_TOOL_CALLS);
      const before = server.requests.length;
      const { io, cap } = ioWithStdin(['n']);
      await runRun(ctx(io), 'read it', { cwd: dir });
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('· denied by user');
      expect(err).not.toContain('closed without an answer'); // a real 'n', not EOF
      const second = JSON.parse(server.requests.slice(before).at(-1)!.body) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(String(second.messages[2]!['content'])).toBe('Permission denied by user.');
      expect(process.exitCode).toBeUndefined();
      // the run still produced the model's final answer
      expect(cap.outText()).toContain('Hello, world!');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Spawns a real POSIX binary (printf) — on Windows run_command is opt-in only.
  it.skipIf(process.platform === 'win32')(
    '[e]dit: the user replaces the command; the REPLACEMENT runs, not the original',
    async () => {
      saveConfig({ apiKey: FAKE_KEY_USER });
      const dir = tempProject();
      try {
        routeRounds([COMMAND_ROUND]);
        const before = server.requests.length;
        const { io, cap } = ioWithStdin(['e', 'printf edited-by-user', 'y']);
        await runRun(ctx(io), 'run something', { cwd: dir });
        const err = cap.errText() + cap.err.join('\n');
        // the exec prompt offers [e]dit; the replacement flow renders the current line
        expect(err).toContain('[y]es / [n]o / [a]lways this session / [e]dit command');
        expect(err).toContain('│   current: printf original');
        expect(err).toContain('└─ Replacement command (empty line cancels):');
        // the original was never executed — the replacement was
        expect(err).not.toContain('ran: printf original');
        expect(err).toContain('ran: printf edited-by-user');
        const second = JSON.parse(server.requests.slice(before).at(-1)!.body) as {
          messages: Array<Record<string, unknown>>;
        };
        expect(String(second.messages[2]!['content'])).toContain('edited-by-user');
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('malformed tool arguments JSON: honest failure to the model — not a crash, breaker not tripped', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routeRounds([CHAT_STREAM_TOOL_CALL_BAD_JSON]);
      const before = server.requests.length;
      const { io, cap } = capturedIo(); // never even prompted (parse fails first)
      await runRun(ctx(io), 'call with bad json', { cwd: dir });
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('✗ Invalid tool arguments for read_file: not valid JSON');
      expect(err).not.toContain('┌─'); // no permission prompt for an unparseable call
      const second = JSON.parse(server.requests.slice(before).at(-1)!.body) as {
        messages: Array<Record<string, unknown>>;
      };
      expect(String(second.messages[2]!['content'])).toContain('not valid JSON');
      // one failure does not abort — the model answered after the feedback
      expect(cap.outText()).toContain('Hello, world!');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// --safe / --yes / --json
// ---------------------------------------------------------------------------

describe('agent loop — modes', () => {
  it('--safe sends ONLY the read-only tools on the wire', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routePlain();
    const before = server.requests.length;
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'hello', { safe: true });
    const req = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions')!;
    const tools = (JSON.parse(req.body) as { tools: Array<Record<string, unknown>> }).tools;
    const names = tools.map((t) => (t['function'] as Record<string, unknown>)['name']);
    // v0.3: list_dir + the web tools joined the read-only set
    expect(names).toEqual([
      'read_file',
      'list_dir',
      'glob',
      'grep',
      'web_search',
      'web_fetch',
      'git_status',
      'git_diff',
      'git_log',
    ]);
    // the run itself is unaffected (no tools requested)
    expect(cap.outText()).toContain('Hello, world!');
  });

  it('--safe + a write tool call: the tool was never offered, so it is fed back as unknown', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routeToolRounds(1, WRITE_ROUND);
      const before = server.requests.length;
      const { io, cap } = capturedIo(); // stdin closed; no prompt can happen
      await runRun(ctx(io), 'write it', { cwd: dir, safe: true });
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('→ write_file() — no such tool');
      expect(err).toContain('Unknown tool "write_file"');
      // the write never happened — the safe toolset has no write tools at all
      expect(existsSync(join(dir, 'out.txt'))).toBe(false);
      // the request carried only the 6 read-only tools
      const req = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions')!;
      const names = (
        JSON.parse(req.body) as { tools: Array<{ function: { name: string } }> }
      ).tools.map((t) => t.function.name);
      expect(names).not.toContain('write_file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--yes executes write_file with NO prompt; the file really appears', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routeToolRounds(1, WRITE_ROUND);
      const before = server.requests.length;
      const { io, cap } = capturedIo(); // stdin EMPTY — nothing to answer
      await runRun(ctx(io), 'write out.txt', { cwd: dir, yes: true });

      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hi from the agent');
      const err = cap.errText() + cap.err.join('\n');
      expect(err).not.toContain('┌─'); // no prompt was ever rendered
      expect(err).toContain('→ write_file(out.txt)');
      expect(err).toContain('· wrote out.txt');
      // the model received the tool summary as the result
      const second = JSON.parse(
        server.requests.slice(before).find((r, i) => r.path === '/v1/chat/completions' && i > 0)!
          .body,
      ) as { messages: Array<Record<string, unknown>> };
      expect(String(second.messages[2]!['content'])).toContain('wrote out.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--json without --yes: tools are DENIED (prompts are impossible), shape stays machine-clean', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      routeToolRounds(1, CHAT_STREAM_TOOL_CALLS);
      const { io, cap } = capturedIo();
      await runRun(ctx(io, true), 'read it', { cwd: dir });
      const parsed = JSON.parse(cap.out.join('')) as {
        ok: boolean;
        content: string;
        turns: number;
        tools: Array<{ tool: string; ok: boolean; summary: string }>;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.turns).toBe(2);
      expect(parsed.tools).toEqual([
        {
          tool: 'read_file',
          label: 'read_file(src/index.ts)',
          ok: false,
          summary: 'denied by user',
        },
      ]);
      // nothing but JSON on stdout; no prompt on stderr
      expect(cap.outText()).toBe('');
      expect(cap.errText()).toBe('');
      // the tool content never reached the model (denied before execution)
      const lastReq = server.requests.filter((r) => r.path === '/v1/chat/completions').at(-1)!;
      expect(
        String((JSON.parse(lastReq.body) as { messages: unknown[] }).messages[2]),
      ).not.toContain('export const x');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// circuit breaker + turn cap
// ---------------------------------------------------------------------------

describe('agent loop — limits', () => {
  it('3 CONSECUTIVE tool failures abort the run with exit 1 and an honest error', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      // every round names a tool that does not exist — failure, failure, failure
      let calls = 0;
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          calls += 1;
          return { status: 200, sse: CHAT_STREAM_TOOL_CALL_UNKNOWN };
        }
        return { status: 404, body: NOT_FOUND };
      });
      const before = server.requests.length;
      const { io, cap } = capturedIo();
      await runRun(ctx(io), 'use the ghost tool', { cwd: dir });
      expect(calls).toBe(3); // stopped after the third consecutive failure
      expect(process.exitCode).toBe(1);
      expect(cap.errText() + cap.err.join('\n')).toContain(
        'agent stopped: 3 consecutive tool failures',
      );
      expect(server.requests.slice(before)).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the breaker counts CONSECUTIVE failures only — a success resets it', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
      // fail, fail, SUCCESS, fail, fail → never 3 in a row → the run completes
      routeRounds([
        CHAT_STREAM_TOOL_CALL_UNKNOWN,
        CHAT_STREAM_TOOL_CALL_UNKNOWN,
        CHAT_STREAM_TOOL_CALLS,
        CHAT_STREAM_TOOL_CALL_UNKNOWN,
        CHAT_STREAM_TOOL_CALL_UNKNOWN,
      ]);
      const { io, cap } = ioWithStdin(['y']); // approve the one real read
      await runRun(ctx(io), 'flaky tools', { cwd: dir });
      expect(process.exitCode).toBeUndefined();
      expect(cap.outText()).toContain('Hello, world!'); // reached the answer
      const err = cap.errText() + cap.err.join('\n');
      expect(err.match(/no such tool/g)?.length).toBe(4);
      expect(err).not.toContain('3 consecutive tool failures');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--max-turns caps the loop; the dangling tool_calls are dropped, exit 0 + honest bullet', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      let calls = 0;
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          calls += 1;
          return { status: 200, sse: CHAT_STREAM_TOOL_CALLS };
        }
        return { status: 404, body: NOT_FOUND };
      });
      const { io, cap } = capturedIo();
      await runRun(ctx(io), 'loop forever', { cwd: dir, maxTurns: 2, yes: true });
      expect(calls).toBe(2);
      const err = cap.errText() + cap.err.join('\n');
      expect(err).toContain('stopped at the turn cap (2)');
      expect(err).toContain('--max-turns');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('selora.json agent.maxTurns is honored; invalid --max-turns values are refused', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      writeFileSync(
        join(dir, 'selora.json'),
        JSON.stringify({ version: 1, model: 'glm-5.3-flash', agent: { maxTurns: 1 } }),
        'utf8',
      );
      let calls = 0;
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          calls += 1;
          return { status: 200, sse: CHAT_STREAM_TOOL_CALLS };
        }
        return { status: 404, body: NOT_FOUND };
      });
      const { io, cap } = capturedIo();
      await runRun(ctx(io), 'loop once', { cwd: dir, yes: true });
      expect(calls).toBe(1); // the config's cap of 1
      expect(cap.err.join('\n')).toContain('stopped at the turn cap (1)');

      for (const bad of [0, 201, 12.5]) {
        const { io: badIo, cap: badCap } = capturedIo();
        await runRun(ctx(badIo), 'x', { cwd: dir, maxTurns: bad });
        expect(badCap.err.join('\n')).toContain('--max-turns must be an integer between 1 and 200');
        expect(process.exitCode).toBe(1);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------

describe('agent loop — sessions', () => {
  it('--session saves the conversation on completion and RESUMES it on the next run', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routePlain();
      const before = server.requests.length;
      const first = ioWithStdin([]);
      await runRun(ctx(first.io), 'first prompt', {
        cwd: dir,
        session: 'work',
        model: 'glm-5.3-flash',
      });
      // saved: visible project-local file with the full exchange
      const file = join(dir, '.selora', 'sessions', 'work.json');
      expect(existsSync(file)).toBe(true);
      const stored = JSON.parse(readFileSync(file, 'utf8')) as {
        model: string;
        messages: Array<Record<string, unknown>>;
      };
      expect(stored.messages).toEqual([
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'Hello, world!' },
      ]);
      expect(first.cap.err.join('\n')).toContain('session saved: work');

      // resume: the stored history rides along, the session's model wins
      const second = ioWithStdin([]);
      await runRun(ctx(second.io, true), 'second prompt', { cwd: dir, session: 'work' });
      const reqs = server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions');
      expect(reqs).toHaveLength(2);
      const body = JSON.parse(reqs[1]!.body) as { model: string; messages: unknown[] };
      expect(body.model).toBe('glm-5.3-flash'); // from the resumed session
      expect(body.messages).toEqual([
        { role: 'user', content: 'first prompt' },
        { role: 'assistant', content: 'Hello, world!' },
        { role: 'user', content: 'second prompt' },
      ]);
      // and the session file now holds 4 messages
      const grown = JSON.parse(readFileSync(file, 'utf8')) as { messages: unknown[] };
      expect(grown.messages).toHaveLength(4);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a session name that is not a safe slug is refused before anything runs', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    routePlain();
    const { io, cap } = capturedIo();
    await runRun(ctx(io), 'x', { session: '../escape' });
    expect(cap.err.join('\n')).toContain('session name must be 1-64 chars');
    expect(process.exitCode).toBe(1);
    const { io: jsonIo, cap: jsonCap } = capturedIo();
    await runRun(ctx(jsonIo, true), 'x', { session: 'has space' });
    expect(jsonCap.out.join('')).toContain('session name must be 1-64 chars');
  });

  it('a run that FAILS mid-stream never writes the session (a half turn would corrupt it)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      // window exhausted BEFORE the stream starts → the loop throws
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          return { status: 402, body: WINDOW_EXHAUSTED_402 };
        }
        return { status: 404, body: NOT_FOUND };
      });
      const { io, cap } = capturedIo();
      await runRun(ctx(io), 'doomed', { cwd: dir, session: 'never' });
      expect(process.exitCode).toBe(1);
      expect(cap.err.join('\n')).toContain('window');
      expect(existsSync(join(dir, '.selora'))).toBe(false); // NOTHING was written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('--model beats the session model (flag > session > project > global > default)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const dir = tempProject();
    try {
      routePlain();
      // a session storing a model we can distinguish on the wire
      mkdirSync(join(dir, '.selora', 'sessions'), { recursive: true });
      writeFileSync(
        join(dir, '.selora', 'sessions', 'm.json'),
        JSON.stringify({
          version: 1,
          name: 'm',
          model: 'glm-5.3',
          createdAt: '2026-10-05T00:00:00.000Z',
          updatedAt: '2026-10-05T00:00:00.000Z',
          messages: [],
        }),
        'utf8',
      );
      const before = server.requests.length;
      const { io } = ioWithStdin([]);
      await runRun(ctx(io), 'hi', { cwd: dir, session: 'm', model: 'glm-5.3-flash' });
      const body = JSON.parse(server.requests.slice(before).at(-1)!.body) as { model: string };
      expect(body.model).toBe('glm-5.3-flash');
      // the flag's model was saved into the session (it is what actually ran)
      const stored = JSON.parse(
        readFileSync(join(dir, '.selora', 'sessions', 'm.json'), 'utf8'),
      ) as {
        model: string;
      };
      expect(stored.model).toBe('glm-5.3-flash');
      // and WITHOUT the flag, the session's model wins: re-seed 'glm-5.3' to see it
      writeFileSync(
        join(dir, '.selora', 'sessions', 'm.json'),
        JSON.stringify({ ...stored, model: 'glm-5.3' }),
        'utf8',
      );
      const before2 = server.requests.length;
      const { io: io2 } = ioWithStdin([]);
      await runRun(ctx(io2), 'hi again', { cwd: dir, session: 'm' });
      const body2 = JSON.parse(server.requests.slice(before2).at(-1)!.body) as { model: string };
      expect(body2.model).toBe('glm-5.3');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// v1.3: dry-run mode, the file-change review hooks, and the checkpoint callback
// ---------------------------------------------------------------------------

/** An asker that records every request — the hook paths must never ask. */
function recordingAsker(): PermissionAsker & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    ask: async (req) => {
      asked.push(req.label);
      return 'deny';
    },
    replacement: async () => null,
  };
}

function loopClient(): SeloraClient {
  return new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER });
}

describe('v1.3 loop hooks', () => {
  it('dryRun: a write tool shows its diff, writes NOTHING, tells the model plainly', async () => {
    routeToolRounds(1, WRITE_ROUND);
    const dir = tempProject();
    try {
      const tools = builtinTools();
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write the file' }],
        tools,
        maxTurns: 5,
        cwd: dir,
        permissions: recordingAsker(),
        autoApprove: false,
        dryRun: true,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
        },
      });
      expect(existsSync(join(dir, 'out.txt'))).toBe(false);
      const ev = result.toolEvents.find((e) => e.name === 'write_file');
      expect(ev?.ok).toBe(true);
      expect(ev?.summary).toContain('[dry-run]');
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toContain('DRY-RUN MODE');
      expect(toolMsg?.content).toContain('NOTHING was written');
      expect(result.stop).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dryRun: read tools still run normally (reads are harmless)', async () => {
    const READ_ROUND: string[] = [
      'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_R1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"a.txt\\"}"}}]},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];
    routeToolRounds(1, READ_ROUND);
    const dir = tempProject();
    try {
      writeFileSync(join(dir, 'a.txt'), 'real content', 'utf8');
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'read it' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        // reads still pass the normal gate in dry-run mode — allow them
        permissions: { ask: async () => 'allow', replacement: async () => null },
        autoApprove: false,
        dryRun: true,
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toContain('real content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fileChange hooks: review+apply REPLACE the gate for diff write tools', async () => {
    routeToolRounds(1, WRITE_ROUND);
    const dir = tempProject();
    try {
      const asker = recordingAsker();
      const seen: string[] = [];
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write the file' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        fileChange: {
          review: async (change) => {
            seen.push(`${change.kind}:${change.path}`);
            return { action: 'apply' } satisfies ReviewDecision;
          },
          apply: async (change) => {
            writeFileSync(join(dir, change.path), change.after, 'utf8');
            return { ok: true, summary: `applied ${change.path} via review` };
          },
        },
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      // the classic gate was never consulted for the write
      expect(asker.asked).toEqual([]);
      // the hook saw the change with its diff-derived kind and wrote the file
      expect(seen).toEqual(['created:out.txt']);
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hi from the agent');
      const ev = result.toolEvents.find((e) => e.name === 'write_file');
      expect(ev?.summary).toBe('applied out.txt via review');
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toBe('applied out.txt via review');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fileChange hooks: a reject decision writes nothing and carries the reason', async () => {
    routeToolRounds(1, WRITE_ROUND);
    const dir = tempProject();
    try {
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write the file' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: recordingAsker(),
        autoApprove: false,
        fileChange: {
          review: async () =>
            ({ action: 'reject', reason: 'wrong file' }) satisfies ReviewDecision as ReviewDecision,
          apply: async () => ({ ok: true, summary: 'unreachable' }),
        },
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      expect(existsSync(join(dir, 'out.txt'))).toBe(false);
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toContain('Permission denied by user. Reason: wrong file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fileChange hooks: apply-hunks forwards the accepted hunk indices', async () => {
    routeToolRounds(1, WRITE_ROUND);
    const dir = tempProject();
    try {
      let gotAccepted: readonly number[] | undefined | 'unset' = 'unset';
      await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write the file' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: recordingAsker(),
        autoApprove: false,
        fileChange: {
          review: async () => ({ action: 'apply-hunks', accepted: [0] }) satisfies ReviewDecision,
          apply: async (_change, acceptedHunks) => {
            gotAccepted = acceptedHunks;
            return { ok: true, summary: 'partial applied' };
          },
        },
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      expect(gotAccepted).toEqual([0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('onFileChange: the classic gate path checkpoints successful diff writes', async () => {
    routeToolRounds(1, WRITE_ROUND);
    const dir = tempProject();
    try {
      const records: Array<{ path: string; kind: string }> = [];
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write the file' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: {
          ask: async () => 'allow',
          replacement: async () => null,
        },
        autoApprove: false,
        onFileChange: (rec) => {
          records.push({ path: rec.path, kind: rec.kind });
        },
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('hi from the agent');
      expect(records).toEqual([{ path: 'out.txt', kind: 'created' }]);
      expect(result.toolEvents.find((e) => e.name === 'write_file')?.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
