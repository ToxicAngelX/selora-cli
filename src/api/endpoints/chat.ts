/**
 * POST /v1/chat/completions (streaming) — the API-KEY-ONLY route (session
 * JWTs are refused by the gateway). Body: {model, messages, stream:true,
 * stream_options:{include_usage:true}}. SSE deltas, the finish chunk, the
 * usage chunk (usage + gateway.charge), and the raw [DONE] sentinel are all
 * decoded defensively: unknown chunk shapes are ignored, never crashed, and
 * usage/charge only ever come from chunks that actually carried them.
 */

import type { SeloraClient } from '../client.js';
import { SeloraApiError } from '../errors.js';

export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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

export async function streamChat(
  client: SeloraClient,
  opts: StreamChatOptions,
  callbacks: ChatCallbacks,
): Promise<ChatResult> {
  const result: ChatResult = {
    finishReason: '',
    toolCallsRequested: false,
    usage: undefined,
    charge: undefined,
    requestId: undefined,
  };
  let done = false;

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
          if (Object.hasOwn(delta, 'tool_calls')) result.toolCallsRequested = true;
          const content = nonEmptyStr(delta, 'content');
          if (content !== undefined) callbacks.onDelta(content);
          const reasoning = nonEmptyStr(delta, 'reasoning_content');
          if (reasoning !== undefined) callbacks.onReasoning?.(reasoning);
        } else {
          // Non-streaming fallback shape: the whole completion in one payload.
          const message = rec(choice['message']);
          if (message !== null) {
            if (Object.hasOwn(message, 'tool_calls')) result.toolCallsRequested = true;
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

  await client.requestStream('/v1/chat/completions', {
    body: {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      stream: true,
      stream_options: { include_usage: true },
    },
    signal: opts.signal,
    timeoutMs: opts.timeoutMs,
    retries: opts.retries,
    onEvent,
  });

  return result;
}
