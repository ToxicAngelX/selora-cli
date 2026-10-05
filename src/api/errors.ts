/**
 * Error taxonomy for the Selora CLI. Every failure surfaced to the user is a
 * SeloraApiError with a machine-readable `kind`, a human message (backend
 * verbatims where the spec demands), an optional hint, and raw details kept
 * for --debug (already redacted where it matters).
 */

import { redact } from './redact.js';

export type ApiErrorKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'auth_revoked'
  | 'no_plan'
  | 'window_exhausted'
  | 'plan_buffer'
  | 'rate_limited'
  | 'server'
  | 'http_error'
  | 'cancelled'
  | 'internal';

export interface SeloraApiErrorInit {
  kind: ApiErrorKind;
  message: string;
  hint?: string | undefined;
  reqId?: string | undefined;
  status?: number | undefined;
  /** Verbatim backend message from the error envelope (may differ from message). */
  apiMessage?: string | undefined;
  /** Raw response body text, already redacted, for --debug. */
  body?: string | undefined;
  retryAfterSeconds?: number | undefined;
}

/** Uniform error type thrown by the API client and commands. */
export class SeloraApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly hint: string | undefined;
  readonly reqId: string | undefined;
  readonly status: number | undefined;
  readonly apiMessage: string | undefined;
  readonly body: string | undefined;
  readonly retryAfterSeconds: number | undefined;

  constructor(init: SeloraApiErrorInit) {
    super(init.message);
    this.name = 'SeloraApiError';
    this.kind = init.kind;
    this.hint = init.hint;
    this.reqId = init.reqId;
    this.status = init.status;
    this.apiMessage = init.apiMessage;
    this.body = init.body;
    this.retryAfterSeconds = init.retryAfterSeconds;
  }

  /** JSON shape for --json mode — undefined fields omitted, never null. */
  toJson(): { kind: ApiErrorKind; message: string; hint?: string; reqId?: string; status?: number } {
    const out: { kind: ApiErrorKind; message: string; hint?: string; reqId?: string; status?: number } = {
      kind: this.kind,
      message: this.message,
    };
    if (this.hint !== undefined) out.hint = this.hint;
    if (this.reqId !== undefined) out.reqId = this.reqId;
    if (this.status !== undefined) out.status = this.status;
    return out;
  }
}

/** Defensive error-envelope decode: `{error:{code,message,...}}` or unknown. */
export interface ErrorEnvelope {
  code: string | undefined;
  message: string | undefined;
  retryAfterSeconds: number | undefined;
  reqId: string | undefined;
}

export function decodeErrorEnvelope(bodyText: string): ErrorEnvelope {
  const empty: ErrorEnvelope = {
    code: undefined,
    message: undefined,
    retryAfterSeconds: undefined,
    reqId: undefined,
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return empty;
  }
  if (typeof parsed !== 'object' || parsed === null || !Object.hasOwn(parsed, 'error')) return empty;
  const err = (parsed as Record<string, unknown>)['error'];
  if (typeof err !== 'object' || err === null) return empty;
  const rec = err as Record<string, unknown>;
  const code = Object.hasOwn(rec, 'code') && typeof rec['code'] === 'string' ? rec['code'] : undefined;
  const message =
    Object.hasOwn(rec, 'message') && typeof rec['message'] === 'string' ? rec['message'] : undefined;
  const retryRaw = Object.hasOwn(rec, 'retry_after_seconds') ? rec['retry_after_seconds'] : undefined;
  const retryAfterSeconds =
    typeof retryRaw === 'number' && Number.isFinite(retryRaw) && retryRaw > 0
      ? Math.ceil(retryRaw)
      : undefined;
  const reqIdRaw = Object.hasOwn(rec, 'request_id') ? rec['request_id'] : undefined;
  const reqId = typeof reqIdRaw === 'string' && reqIdRaw.length > 0 ? reqIdRaw : undefined;
  return { code, message, retryAfterSeconds, reqId };
}

export interface ClassifyInput {
  status: number;
  bodyText: string;
  /** x-request-id response header, when present. */
  reqId?: string | undefined;
  /** Retry-After response header in seconds (already parsed), when present. */
  retryAfterSeconds?: number | undefined;
}

const HINT_DEBUG = '(run with --debug for details)';

/**
 * Map an HTTP failure status to a SeloraApiError. Verbatim backend messages
 * are preserved where the spec requires pass-through; unknown envelope shapes
 * degrade to generic messages with the raw body kept for --debug.
 */
export function classifyHttpError(input: ClassifyInput): SeloraApiError {
  const { status } = input;
  const env = decodeErrorEnvelope(input.bodyText);
  const message = env.message;
  const reqId = env.reqId ?? input.reqId;
  const retryAfterSeconds = env.retryAfterSeconds ?? input.retryAfterSeconds;

  const verbatim = (): string => message ?? `Request failed (HTTP ${status}).`;

  const init: SeloraApiErrorInit = {
    kind: 'http_error',
    message: verbatim(),
    reqId,
    status,
    apiMessage: message,
    body: redact(input.bodyText),
    retryAfterSeconds,
  };

  if (status === 401) {
    if (env.code === 'api_key_revoked' && message) {
      init.kind = 'auth_revoked';
      init.message = message; // contains the rotation hint — pass through VERBATIM
      return new SeloraApiError(init);
    }
    init.kind = 'auth';
    init.message = 'You are not logged in. Run: selora login';
    return new SeloraApiError(init);
  }

  if (status === 402 && env.code === 'insufficient_balance' && message) {
    if (message.startsWith('No API credits remaining')) {
      init.kind = 'no_plan';
      init.message = message;
      init.hint = 'Start the free trial at selora.lol';
      return new SeloraApiError(init);
    }
    if (message.includes('plan usage limit is reached')) {
      // resetsAt lives inside the message text — never fabricate a countdown.
      init.kind = 'window_exhausted';
      init.message = message;
      return new SeloraApiError(init);
    }
    if (message.includes('No spendable API credits right now')) {
      init.kind = 'plan_buffer';
      init.message = message;
      return new SeloraApiError(init);
    }
  }

  if (status === 429) {
    init.kind = 'rate_limited';
    init.message = verbatim();
    init.hint =
      retryAfterSeconds !== undefined
        ? `Wait ${retryAfterSeconds}s before trying again.`
        : 'Try again in a moment.';
    return new SeloraApiError(init);
  }

  if (status >= 500) {
    init.kind = 'server';
    init.message = 'Selora is having trouble — please try again.';
    return new SeloraApiError(init);
  }

  init.kind = 'http_error';
  init.message = message ?? `Request failed (HTTP ${status}).`;
  return new SeloraApiError(init);
}

export function networkError(_cause?: unknown): SeloraApiError {
  return new SeloraApiError({
    kind: 'network',
    message: 'Unable to connect to Selora — check your connection or try again.',
    hint: HINT_DEBUG,
  });
}

export function timeoutError(_timeoutMs: number): SeloraApiError {
  return new SeloraApiError({
    kind: 'timeout',
    message: 'Selora did not respond in time — the request timed out. Try again.',
    hint: HINT_DEBUG,
  });
}
