/**
 * POST /v1/chat/completions (streaming) — the API-KEY-ONLY route (session
 * JWTs are refused by the gateway). Body: {model, messages, stream:true,
 * stream_options:{include_usage:true}} plus, for the agent loop, a `tools`
 * passthrough (OpenAI dialect definitions, sent only when non-empty) with
 * tool_choice 'auto'. SSE deltas, the finish chunk, the usage chunk (usage +
 * gateway.charge), and the raw [DONE] sentinel are all decoded defensively:
 * unknown chunk shapes are ignored, never crashed, and usage/charge only ever
 * come from chunks that actually carried them.
 *
 * v0.2 tool decoding: `delta.tool_calls` fragments (keyed by their `index`)
 * are accumulated across chunks — id and function.name are set once,
 * function.arguments is concatenated fragment by fragment — so
 * ChatResult.toolCalls holds complete calls by the time the stream ends.
 * Malformed fragments (no index, no name by the end) are dropped, never
 * invented.
 */

import type { SeloraClient } from '../client.js';
import { SeloraApiError } from '../errors.js';

export type ChatRole = 'user' | 'assistant' | 'system';

/** A tool call as it appears on the wire (assistant message / delta chunks). */
export interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** The OpenAI-dialect tool definition sent in the request body. */
export interface WireToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ChatMessage =
  | { role: 'user' | 'system'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: WireToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** A completed, decoded tool call: {id, name, arguments (raw JSON string)}. */
export interface DecodedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ChatResult {
  /** finish_reason from the finish chunk; '' when the stream never sent one. */
  finishReason: string;
  /**
   * True when the model ACTUALLY requested tools on the wire: any delta (or
   * non-streaming message) carried `tool_calls`, or the finish chunk's
   * finish_reason was 'tool_calls'. This is real detection — never
   * prompt-text guessing.
   */
  toolCallsRequested: boolean;
  /** The fully accumulated tool calls from this turn (empty when none). */
  toolCalls: DecodedToolCall[];
  /** Only set when a chunk actually carried a well-formed usage object. */
  usage: ChatUsage | undefined;
  /** Raw scale-6 decimal USD string from gateway.charge — the cost. */
  charge: string | undefined;
  requestId: string | undefined;
}

export interface ChatCallbacks {
  /** Content deltas (choices[0].delta.content), in arrival order. */
  onDelta: (text: string) => void;
  /** reasoning_content deltas — only invoked when the backend sends them. */
  onReasoning?: ((text: string) => void) | undefined;
}

export interface StreamChatOptions {
  model: string;
  messages: ChatMessage[];
  /**
   * Tool definitions for the agent loop — sent verbatim as the request body's
   * `tools` (with tool_choice 'auto') ONLY when non-empty. Plain chat/run
   * turns send no tools key at all.
   */
  tools?: readonly WireToolDefinition[];
  /** User abort (Ctrl+C). Rejects with kind 'cancelled'; the session survives. */
  signal?: AbortSignal | undefined;
  /** Time-to-first-byte timeout override (ms). */
  timeoutMs?: number | undefined;
  /** Pre-stream 429/5xx retry budget override. */
  retries?: number | undefined;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function finiteNum(recSrc: Record<string, unknown>, key: string): number | undefined {
  const v = Object.hasOwn(recSrc, key) ? recSrc[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function nonEmptyStr(recSrc: Record<string, unknown>, key: string): string | undefined {
  const v = Object.hasOwn(recSrc, key) ? recSrc[key] : undefined;
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** In-band stream error: headers already went out, so it arrives as a data event. */
function inBandError(errRaw: unknown): SeloraApiError {
  const e = rec(errRaw);
  const message = e !== null ? nonEmptyStr(e, 'message') : undefined;
  return new SeloraApiError({
    kind: 'http_error',
    // Backend message VERBATIM — 402 window resets live only in this text.
    message: message ?? 'The stream failed before completing.',
    reqId: e !== null ? nonEmptyStr(e, 'request_id') : undefined,
    apiMessage: message,
  });
}

/** A complete tool call from a non-streaming message.tool_calls array. */
function decodeCompleteCall(v: unknown): DecodedToolCall | null {
  const c = rec(v);
  if (c === null) return null;
  const fn = rec(c['function']);
  if (fn === null) return null;
  const id = nonEmptyStr(c, 'id');
  const name = nonEmptyStr(fn, 'name');
  if (id === undefined || name === undefined) return null;
  const args = Object.hasOwn(fn, 'arguments') && typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
  return { id, name, arguments: args };
}

export async function streamChat(
  client: SeloraClient,
  opts: StreamChatOptions,
  callbacks: ChatCallbacks,
): Promise<ChatResult> {
  const result: ChatResult = {
    finishReason: '',
    toolCallsRequested: false,
    toolCalls: [],
    usage: undefined,
    charge: undefined,
    requestId: undefined,
  };
  let done = false;
  // Tool-call fragments keyed by their wire `index`; assembled at stream end.
  const pending = new Map<number, { id: string | undefined; name: string | undefined; args: string }>();

  const accumulate = (callsRaw: unknown): void => {
    if (!Array.isArray(callsRaw)) return;
    for (const entry of callsRaw) {
      const c = rec(entry);
      if (c === null) continue;
      const fn = rec(c['function']);
      if (fn === null) continue;
      const index = finiteNum(c, 'index');
      const slot = index !== undefined ? index : pending.size;
      const cur = pending.get(slot) ?? { id: undefined, name: undefined, args: '' };
      // id/name arrive (whole) in the first fragment; later fragments only
      // extend arguments. Setting once guards against providers that repeat.
      if (cur.id === undefined) cur.id = nonEmptyStr(c, 'id');
      if (cur.name === undefined) cur.name = nonEmptyStr(fn, 'name');
      const args = Object.hasOwn(fn, 'arguments') && typeof fn['arguments'] === 'string' ? fn['arguments'] : '';
      if (args !== '') cur.args += args;
      pending.set(slot, cur);
    }
  };

  const onEvent = (data: string): void => {
    if (done) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // unrecognized payload — ignore, never crash
    }
    const root = rec(parsed);
    if (root === null) return;
    if (Object.hasOwn(root, 'error')) {
      throw inBandError(root['error']);
    }
    const choicesRaw = root['choices'];
    if (Array.isArray(choicesRaw)) {
      if (choicesRaw.length === 0) {
        // The usage chunk: empty choices + usage + gateway.
        decodeUsage(root['usage']);
        decodeGateway(root['gateway']);
        return;
      }
      const choice = rec(choicesRaw[0]);
      if (choice !== null) {
        const finish = nonEmptyStr(choice, 'finish_reason');
        if (finish !== undefined) {
          result.finishReason = finish;
          if (finish === 'tool_calls') result.toolCallsRequested = true;
        }
        const delta = rec(choice['delta']);
        if (delta !== null) {
          if (Object.hasOwn(delta, 'tool_calls')) {
            result.toolCallsRequested = true;
            accumulate(delta['tool_calls']);
          }
          const content = nonEmptyStr(delta, 'content');
          if (content !== undefined) callbacks.onDelta(content);
          const reasoning = nonEmptyStr(delta, 'reasoning_content');
          if (reasoning !== undefined) callbacks.onReasoning?.(reasoning);
        } else {
          // Non-streaming fallback shape: the whole completion in one payload.
          const message = rec(choice['message']);
          if (message !== null) {
            if (Object.hasOwn(message, 'tool_calls')) {
              result.toolCallsRequested = true;
              const calls = message['tool_calls'];
              if (Array.isArray(calls)) {
                for (const c of calls) {
                  const decoded = decodeCompleteCall(c);
                  if (decoded !== null) result.toolCalls.push(decoded);
                }
              }
            }
            const content = nonEmptyStr(message, 'content');
            if (content !== undefined) callbacks.onDelta(content);
          }
        }
      }
    }
    // usage/gateway ride the same chunk in the non-streaming shape (and the
    // finish chunk itself when the gateway sends gateway without usage).
    decodeUsage(root['usage']);
    decodeGateway(root['gateway']);
  };

  function decodeUsage(v: unknown): void {
    const u = rec(v);
    if (u === null) return;
    const promptTokens = finiteNum(u, 'prompt_tokens');
    const completionTokens = finiteNum(u, 'completion_tokens');
    const totalTokens = finiteNum(u, 'total_tokens');
    if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) {
      return; // malformed usage — never invent a footer
    }
    result.usage = { promptTokens, completionTokens, totalTokens };
  }

  function decodeGateway(v: unknown): void {
    const g = rec(v);
    if (g === null) return;
    const charge = nonEmptyStr(g, 'charge');
    if (charge !== undefined) result.charge = charge;
    const reqId = nonEmptyStr(g, 'request_id');
    if (reqId !== undefined) result.requestId = reqId;
  }

  const body: Record<string, unknown> = {
    model: opts.model,
    messages: opts.messages.map((m) => {
      if (m.role === 'tool') return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content };
      if (m.role === 'assistant') {
        const out: Record<string, unknown> = { role: 'assistant', content: m.content };
        if (m.tool_calls !== undefined && m.tool_calls.length > 0) {
          out['tool_calls'] = m.tool_calls.map((c) => ({
            id: c.id,
            type: 'function',
            function: { name: c.function.name, arguments: c.function.arguments },
          }));
        }
        return out;
      }
      return { role: m.role, content: m.content };
    }),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (opts.tools !== undefined && opts.tools.length > 0) {
    body['tools'] = opts.tools;
    body['tool_choice'] = 'auto';
  }

  await client.requestStream('/v1/chat/completions', {
    body,
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    onEvent,
  });

  // Assemble the accumulated fragments (index order). A call with no id or no
  // name by stream end is malformed — dropped, never guessed.
  const assembled: DecodedToolCall[] = [];
  for (const slot of [...pending.keys()].sort((a, b) => a - b)) {
    const cur = pending.get(slot)!;
    if (cur.id === undefined || cur.name === undefined) continue;
    assembled.push({ id: cur.id, name: cur.name, arguments: cur.args });
  }
  if (assembled.length > 0) {
    result.toolCalls = assembled;
    result.toolCallsRequested = true;
  }
  return result;
}
