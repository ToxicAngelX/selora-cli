/**
 * Phase 3 chat tests. Two layers against the local mock gateway:
 *  1. streamChat / requestStream — SSE decode (deltas, reasoning, usage,
 *     charge), the non-streaming fallback, pre-stream errors, wire body.
 *  2. the REPL driven through injected CliContext (isTTY: true, piped lines):
 *     streamed replies, footer semantics (real numbers only), /model switch
 *     verification, clean exit, and the Ctrl+C abort seam.
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_COMPLETION_NONSTREAM,
  CHAT_STREAM_FULL,
  CHAT_STREAM_HANG,
  CHAT_STREAM_INBAND_ERROR,
  CHAT_STREAM_NO_USAGE,
  CHAT_STREAM_SECOND,
  CHAT_STREAM_SPLIT,
  CHAT_STREAM_TOOL_CALLS,
  CHAT_STREAM_TOOL_CALLS_PARALLEL,
  CHAT_STREAM_TOOL_CALL_SPLIT_ARGS,
  FAKE_KEY_USER,
  MODEL_NOT_FOUND_404,
  RATE_LIMIT_429,
  REVOKED_KEY_401,
  WINDOW_EXHAUSTED_402,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { SeloraClient } from '../src/api/client.js';
import { streamChat, type ChatMessage } from '../src/api/endpoints/chat.js';
import { SeloraApiError } from '../src/api/errors.js';
import { runChat } from '../src/commands/chat.js';
import type { CliContext, CliIo } from '../src/context.js';

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';
const WINDOW_RESET_TEXT = 'Plan usage resumes at 2026-10-05T14:00:00Z.';

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

function keyClient(opts: { apiKey?: string } = {}): SeloraClient {
  return new SeloraClient({
    baseUrl: server.url,
    apiKey: opts.apiKey === undefined ? FAKE_KEY_USER : opts.apiKey,
    debug: false,
  });
}

async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Transcript-style io: line writes append s+'\n', raw writes append s — order preserved. */
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

function replCtx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hello' }];

// ---------------------------------------------------------------------------
// streamChat / requestStream (endpoint layer)
// ---------------------------------------------------------------------------

describe('streamChat', () => {
  it('decodes the full stream: deltas, reasoning, finish reason, usage, charge, request id', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    const deltas: string[] = [];
    const reasoning: string[] = [];
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      {
        onDelta: (t) => deltas.push(t),
        onReasoning: (t) => reasoning.push(t),
      },
    );
    expect(deltas.join('')).toBe('Hello, world!');
    expect(reasoning).toEqual(['(thinking about it)']);
    expect(result.finishReason).toBe('stop');
    expect(result.toolCallsRequested).toBe(false);
    expect(result.usage).toEqual({ promptTokens: 4821, completionTokens: 1234, totalTokens: 6055 });
    expect(result.charge).toBe('0.018234');
    expect(result.requestId).toBe('req_chat_full');
  });

  it('tool_calls detection is real: a tool_calls delta + finish_reason "tool_calls" set the flag', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_TOOL_CALLS }));
    const deltas: string[] = [];
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      {
        onDelta: (t) => deltas.push(t),
      },
    );
    expect(deltas.join('')).toBe('I would read a file for that.');
    expect(result.finishReason).toBe('tool_calls');
    expect(result.toolCallsRequested).toBe(true);
    expect(result.usage).toEqual({ promptTokens: 200, completionTokens: 40, totalTokens: 240 });
    expect(result.charge).toBe('0.002000');
  });

  it('tool_calls FRAGMENTS accumulate: arguments split across chunks (mid-token) assemble whole', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_TOOL_CALL_SPLIT_ARGS }));
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      { onDelta: () => {} },
    );
    expect(result.toolCallsRequested).toBe(true);
    expect(result.toolCalls).toEqual([
      { id: 'call_SPLIT1', name: 'read_file', arguments: '{"path":"src/index.ts"}' },
    ]);
    expect(result.finishReason).toBe('tool_calls');
    expect(result.usage).toEqual({ promptTokens: 40, completionTokens: 10, totalTokens: 50 });
    expect(result.charge).toBe('0.000400');
  });

  it('PARALLEL tool calls: two calls in one delta arrive as two decoded calls, in index order', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_TOOL_CALLS_PARALLEL }));
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      { onDelta: () => {} },
    );
    expect(result.toolCalls).toEqual([
      {
        id: 'call_PAR1',
        name: 'write_file',
        arguments: '{"path":"out.txt","content":"hi"}',
      },
      { id: 'call_PAR2', name: 'read_file', arguments: '{"path":"src/index.ts"}' },
    ]);
  });

  it('the agent round-trip wire shape: tools in the request, tool echo + tool result in messages', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    await streamChat(
      keyClient(),
      {
        model: 'glm-5.3-flash',
        messages: [
          { role: 'user', content: 'read package.json' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_RT1',
                type: 'function',
                function: { name: 'read_file', arguments: '{"path":"package.json"}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'call_RT1', content: '{"name":"selora"}' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'read_file',
              description: 'Read a file',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          },
        ],
      },
      { onDelta: () => {} },
    );
    const body = JSON.parse(server.requests.at(-1)!.body) as Record<string, unknown>;
    // the tool definitions ride along verbatim, with tool_choice auto
    expect(body['tools']).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ]);
    expect(body['tool_choice']).toBe('auto');
    // the assistant echo keeps content:null + tool_calls; the tool message
    // keeps tool_call_id + content — exactly the verified round-trip shape
    expect(body['messages']).toEqual([
      { role: 'user', content: 'read package.json' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_RT1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"package.json"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'call_RT1', content: '{"name":"selora"}' },
    ]);
  });

  it('buffers events split mid-JSON across SSE frames', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_SPLIT }));
    const deltas: string[] = [];
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      {
        onDelta: (t) => deltas.push(t),
      },
    );
    expect(deltas.join('')).toBe('Hello, world!');
    expect(result.charge).toBe('0.018234');
  });

  it('sends the exact wire body, key auth, and SSE Accept header', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      { onDelta: () => {} },
    );
    const req = server.requests.at(-1)!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/chat/completions');
    expect(req.headers['authorization']).toBe(`Bearer ${FAKE_KEY_USER}`);
    expect(req.headers['accept']).toBe('text/event-stream');
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body)).toEqual({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'hello' }],
      stream: true,
      stream_options: { include_usage: true },
    });
  });

  it('include_usage:false shape: gateway.charge decoded, usage stays undefined', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_NO_USAGE }));
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      {
        onDelta: () => {},
      },
    );
    expect(result.usage).toBeUndefined();
    expect(result.charge).toBe('0.001000');
    expect(result.finishReason).toBe('stop');
  });

  it('requestStream delivers raw data strings including [DONE]', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    const events: string[] = [];
    await keyClient().requestStream('/v1/chat/completions', {
      body: { model: 'glm-5.3-flash', messages: MESSAGES, stream: true },
      onEvent: (data) => events.push(data),
    });
    expect(events.at(-1)).toBe('[DONE]');
    expect(events.length).toBe(7); // 6 data events (the keep-alive comment emits none) + [DONE]
  });

  it('in-band stream error: SeloraApiError with the backend message VERBATIM (reset time included)', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_INBAND_ERROR }));
    let caught: unknown;
    await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      { onDelta: () => {} },
    ).catch((err: unknown) => {
      caught = err;
    });
    expect(caught).toBeInstanceOf(SeloraApiError);
    const e = caught as SeloraApiError;
    expect(e.kind).toBe('http_error');
    expect(e.message).toContain(WINDOW_RESET_TEXT);
    expect(e.message).toContain('Top up API credits to continue pay-as-you-go');
    expect(e.reqId).toBe('req_chat_inband');
  });

  it('429 before the stream starts: rate_limited with retry_after_seconds', async () => {
    server.setHandler(() => ({
      status: 429,
      body: RATE_LIMIT_429,
      headers: { 'retry-after': '1' },
    }));
    await expect(
      streamChat(
        keyClient(),
        { model: 'glm-5.3-flash', messages: MESSAGES, retries: 0 },
        { onDelta: () => {} },
      ),
    ).rejects.toMatchObject({ kind: 'rate_limited', status: 429, retryAfterSeconds: 1 });
  });

  it('402 window-exhausted before the stream starts: verbatim message with the reset time', async () => {
    server.setHandler(() => ({ status: 402, body: WINDOW_EXHAUSTED_402 }));
    let caught: unknown;
    await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES, retries: 0 },
      {
        onDelta: () => {},
      },
    ).catch((err: unknown) => {
      caught = err;
    });
    const e = caught as SeloraApiError;
    expect(e.kind).toBe('window_exhausted');
    expect(e.status).toBe(402);
    expect(e.message).toContain(WINDOW_RESET_TEXT);
  });

  it('401 revoked key: auth_revoked with the verbatim rotation message', async () => {
    server.setHandler(() => ({ status: 401, body: REVOKED_KEY_401 }));
    let caught: unknown;
    await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES, retries: 0 },
      {
        onDelta: () => {},
      },
    ).catch((err: unknown) => {
      caught = err;
    });
    const e = caught as SeloraApiError;
    expect(e.kind).toBe('auth_revoked');
    expect(e.message).toContain('This API key was revoked on 2026-10-01');
  });

  it('non-streaming 2xx fallback: message.content + usage + gateway decoded', async () => {
    server.setHandler(() => ({ status: 200, body: CHAT_COMPLETION_NONSTREAM }));
    const deltas: string[] = [];
    const result = await streamChat(
      keyClient(),
      { model: 'glm-5.3-flash', messages: MESSAGES },
      {
        onDelta: (t) => deltas.push(t),
      },
    );
    expect(deltas.join('')).toBe('Plain completion reply.');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 100, completionTokens: 5, totalTokens: 105 });
    expect(result.charge).toBe('0.000500');
    expect(result.requestId).toBe('req_chat_nonstream');
  });

  it('no stored key: the standard auth error', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    const noKey = new SeloraClient({ baseUrl: server.url, debug: false });
    await expect(
      streamChat(noKey, { model: 'glm-5.3-flash', messages: MESSAGES }, { onDelta: () => {} }),
    ).rejects.toMatchObject({ kind: 'auth', message: 'You are not logged in. Run: selora login' });
  });

  it('aborting the signal before the request: distinguishable cancelled error', async () => {
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    const controller = new AbortController();
    controller.abort();
    await expect(
      streamChat(
        keyClient(),
        { model: 'glm-5.3-flash', messages: MESSAGES, signal: controller.signal },
        {
          onDelta: () => {},
        },
      ),
    ).rejects.toMatchObject({ kind: 'cancelled', message: 'Request cancelled.' });
  });

  it('time-to-first-byte timeout: headers never arrive in time → timeout error', async () => {
    server.setHandler(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { status: 200, sse: CHAT_STREAM_FULL };
    });
    await expect(
      streamChat(
        keyClient(),
        { model: 'glm-5.3-flash', messages: MESSAGES, timeoutMs: 50 },
        {
          onDelta: () => {},
        },
      ),
    ).rejects.toMatchObject({ kind: 'timeout' });
  });
});

// ---------------------------------------------------------------------------
// The REPL (command layer)
// ---------------------------------------------------------------------------

function installChatRoutes(streams: string[][]): { chatCalls: number } {
  const state = { chatCalls: 0 };
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
      const stream = streams[Math.min(state.chatCalls, streams.length - 1)] ?? CHAT_STREAM_FULL;
      state.chatCalls += 1;
      return { status: 200, sse: stream };
    }
    return { status: 404, body: NOT_FOUND };
  });
  return state;
}

describe('chat REPL', () => {
  it('streams two replies, footers only where usage arrived, verifies /model switch, exits cleanly', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    const state = installChatRoutes([CHAT_STREAM_FULL, CHAT_STREAM_SECOND]);
    const before = server.requests.length;
    const { io, cap } = replIo(['hello', '/model gpt-5.2-mini', 'second question', '/exit']);

    await runChat(replCtx(io), {});

    const out = cap.out();
    // verified header with the display name
    expect(out).toContain('✓ Connected to glm-5.3-flash (GLM 5.3 Flash)');
    // both streamed replies rendered (raw deltas, no buffering)
    expect(out).toContain('Hello, world!');
    expect(out).toContain('Second reply, after the switch.');
    // footer ONLY where the usage chunk arrived — real numbers, comma-grouped;
    // sub-dime cost keeps 3 decimals ($0.018234 → $0.018)
    expect(out).toContain('  Tokens: 6,055 · Cost: $0.018');
    expect(out).toContain('  Tokens: 150 · Cost: $0.001');
    expect(out).not.toContain('Tokens: 4,821');
    // reasoning went to stderr, dim gray channel
    expect(cap.err()).toContain('(thinking about it)');
    // the gray prompt was written for each turn
    expect(cap.err().split('❯ ').length - 1).toBe(4);
    // model switch verified against /v1/models/:id
    expect(out).toContain('✓ Switched to gpt-5.2-mini');
    const mine = server.requests.slice(before);
    const chatReqs = mine.filter((r) => r.path === '/v1/chat/completions');
    expect(chatReqs.length).toBe(2);
    expect(state.chatCalls).toBe(2);
    // the second request used the switched model AND the full history
    const secondBody = JSON.parse(chatReqs[1]!.body) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondBody.model).toBe('gpt-5.2-mini');
    expect(secondBody.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Hello, world!' },
      { role: 'user', content: 'second question' },
    ]);
    // /model verification hit the public route without auth
    const modelReqs = mine.filter((r) => r.path === '/v1/models/gpt-5.2-mini');
    expect(modelReqs.length).toBe(1);
    expect(modelReqs[0]!.headers['authorization']).toBeUndefined();
    // clean exit
    expect(cap.all()).toContain('✓ Session ended');
    expect(process.exitCode).toBeUndefined();
  });

  it('no usage chunk → no footer, content still rendered', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_NO_USAGE]);
    const { io, cap } = replIo(['hi', '/exit']);
    await runChat(replCtx(io), {});
    const out = cap.out();
    expect(out).toContain('No footer for this one.');
    expect(out).not.toContain('Tokens:');
    expect(out).not.toContain('Cost:');
    expect(process.exitCode).toBeUndefined();
  });

  it('unknown startup model: honest 404 message + hint, REPL never starts', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_FULL]);
    const before = server.requests.length;
    const { io, cap } = replIo(['hello', '/exit']);
    await runChat(replCtx(io), { model: 'no-such-model' });
    const text = cap.all();
    expect(text).toContain('✗ Model not available');
    expect(text).toContain('List available models with: selora models');
    expect(text).not.toContain('Connected to');
    expect(text).not.toContain('Session ended');
    expect(process.exitCode).toBe(1);
    // no chat request was ever made
    expect(server.requests.slice(before).some((r) => r.path === '/v1/chat/completions')).toBe(
      false,
    );
  });

  it('unknown startup model in --json mode: {ok:false, error:{message:"Model not available"}}', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_FULL]);
    const { io, cap } = replIo(['hello', '/exit']);
    await runChat(replCtx(io, true), { model: 'no-such-model' });
    const parsed = JSON.parse(cap.out()) as { ok: boolean; error: { message: string } };
    expect(parsed.ok).toBe(false);
    expect(parsed.error.message).toBe('Model not available');
    expect(process.exitCode).toBe(1);
  });

  it('non-TTY stdin: honest message pointing at selora run, exit 1', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_FULL]);
    const { io, cap } = replIo([]);
    const nonTTY: CliIo = { ...io, stdin: Readable.from([]), isTTY: false };
    await runChat(replCtx(nonTTY), {});
    const text = cap.all();
    expect(text).toContain(
      '✗ selora chat needs an interactive terminal — use: selora run "<prompt>"',
    );
    expect(text).not.toContain('Connected to');
    expect(process.exitCode).toBe(1);
  });

  it('no stored key: standard auth error, exit 1', async () => {
    saveConfig({});
    installChatRoutes([CHAT_STREAM_FULL]);
    const { io, cap } = replIo(['hello', '/exit']);
    await runChat(replCtx(io), {});
    expect(cap.all()).toContain('✗ You are not logged in. Run: selora login');
    expect(process.exitCode).toBe(1);
  });

  it('Ctrl+C mid-stream (abort seam): request aborted, session kept, aborted pair dropped from history', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    // One delta, then the stream stays open forever.
    server.setHandler((req) => {
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        return { status: 200, sse: CHAT_STREAM_HANG, sseHang: true };
      }
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
      }
      return { status: 404, body: NOT_FOUND };
    });
    const { io, cap } = replIo(['hello', '/exit']);
    const before = server.requests.length;
    let interrupt: (() => void) | undefined;
    const session = runChat(
      replCtx(io),
      {},
      {
        registerInterrupt: (fn) => {
          interrupt = fn;
        },
      },
    );
    // wait until the request is actually in flight (markdown rendering is
    // line-buffered, so a partial first line legitimately renders nothing),
    // then "press Ctrl+C"
    await until(
      () => server.requests.slice(before).some((rq) => rq.path === '/v1/chat/completions'),
      'chat request started',
    );
    expect(typeof interrupt).toBe('function');
    interrupt!();
    await session;
    const text = cap.all();
    expect(text).toContain('· Request cancelled — session kept');
    expect(text).toContain('✓ Session ended');
    // exactly one chat request: the aborted pair was dropped, nothing retried
    expect(
      server.requests.slice(before).filter((r) => r.path === '/v1/chat/completions').length,
    ).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('402 mid-session: verbatim error shown, REPL stays alive, turn dropped', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
      }
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        return { status: 402, body: WINDOW_EXHAUSTED_402 };
      }
      return { status: 404, body: NOT_FOUND };
    });
    const { io, cap } = replIo(['oops', '/exit']);
    await runChat(replCtx(io), {});
    const text = cap.all();
    expect(text).toContain('✗ Your 4h plan usage limit is reached');
    expect(text).toContain(WINDOW_RESET_TEXT);
    // REPL survived the error and exited cleanly afterwards
    expect(text).toContain('✓ Session ended');
    expect(process.exitCode).toBeUndefined();
  });

  it('revoked key mid-session: fatal — verbatim message, exit 1, no "Session ended"', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
      }
      if (req.method === 'POST' && req.path === '/v1/chat/completions') {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      return { status: 404, body: NOT_FOUND };
    });
    const { io, cap } = replIo(['hello', '/exit']);
    await runChat(replCtx(io), {});
    const text = cap.all();
    expect(text).toContain('This API key was revoked on 2026-10-01');
    expect(text).toContain('restart the app');
    expect(text).not.toContain('Session ended');
    expect(process.exitCode).toBe(1);
  });

  it('empty lines reprompt; unknown slash commands get help; /model with no arg shows current', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_FULL]);
    const { io, cap } = replIo(['', '/wat', '/model', '/exit']);
    await runChat(replCtx(io), {});
    const text = cap.all();
    expect(text).toContain('Unknown command /wat — /help lists commands.');
    expect(text).toContain('Current model: glm-5.3-flash (GLM 5.3 Flash)');
    // 5 prompts were drawn (empty, /wat, /model, + none for /exit)
    expect(cap.err().split('❯ ').length - 1).toBeGreaterThanOrEqual(4);
    expect(process.exitCode).toBeUndefined();
  });

  it('/model to an unknown id: honest 404, current model kept', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes([CHAT_STREAM_FULL]);
    const before = server.requests.length;
    const { io, cap } = replIo(['/model no-such-model', 'hello', '/exit']);
    await runChat(replCtx(io), {});
    const text = cap.all();
    expect(text).toContain('✗ Model not available');
    expect(text).not.toContain('Switched to');
    // the subsequent turn still used the original model
    const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
    expect((JSON.parse(chatReq!.body) as { model: string }).model).toBe('glm-5.3-flash');
    expect(text).toContain('Hello, world!');
  });
});
