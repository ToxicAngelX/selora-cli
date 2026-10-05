/**
 * SeloraClient — the single HTTP chokepoint. Every gateway call in the CLI
 * goes through here: headers, x-request-id, timeouts, retries, error mapping,
 * and debug logging (one printer, always redacted) all live in this file.
 */

import { randomUUID } from 'node:crypto';
import { classifyHttpError, networkError, timeoutError, SeloraApiError } from './errors.js';
import { redact } from './redact.js';
import { createSseParser } from './sse.js';

export type DebugLogger = (line: string) => void;

export interface SeloraClientOptions {
  baseUrl: string;
  apiKey?: string | undefined;
  debug?: boolean;
  /** Injectable for tests; defaults to console.error. */
  logger?: DebugLogger | undefined;
}

export type AuthMode = 'none' | 'key' | 'token';

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
  auth?: AuthMode | undefined;
  /** Session token for auth:'token'. */
  token?: string | undefined;
  timeoutMs?: number | undefined;
  /** Max additional attempts after the first (default 2). */
  retries?: number | undefined;
}

export interface RequestResult<T> {
  data: T;
  status: number;
  headers: Headers;
}

export interface StreamRequestOptions {
  body?: unknown;
  /** User abort (e.g. Ctrl+C mid-stream). Aborts cleanly with a 'cancelled' error. */
  signal?: AbortSignal | undefined;
  /** Receives each SSE `data:` payload as a string — including '[DONE]'. */
  onEvent: (data: string) => void;
  /** Time-to-first-byte timeout in ms (default 60s). No timeout while streaming. */
  timeoutMs?: number | undefined;
  /** Max additional attempts after the first for pre-stream 429/5xx (default 2). */
  retries?: number | undefined;
}

export interface StreamResult {
  status: number;
  headers: Headers;
  /** True when the 2xx response was an SSE stream; false for the non-streaming fallback. */
  sse: boolean;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Streams only time out waiting for the response to START, never mid-data. */
const DEFAULT_TTFB_TIMEOUT_MS = 60_000;
const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 500;
/** Retry-After can legitimately be long; never sleep the CLI for minutes. */
const MAX_RETRY_AFTER_MS = 10_000;

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Distinguishable abort result: the command layer keeps the session. */
function streamCancelled(): SeloraApiError {
  return new SeloraApiError({ kind: 'cancelled', message: 'Request cancelled.' });
}

function parseRetryAfterSeconds(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const n = Number(headerValue.trim());
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

export class SeloraClient {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly debug: boolean;
  private readonly log: DebugLogger;

  constructor(opts: SeloraClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    this.debug = opts.debug === true;
    this.log = opts.logger ?? ((line) => console.error(line));
  }

  /** The single debug printer. All lines pass through redact(). */
  private debugLog(line: string): void {
    if (!this.debug) return;
    this.log(redact(line));
  }

  /** Parsed JSON on success; throws SeloraApiError otherwise. */
  async request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
    return (await this.requestRaw<T>(path, opts)).data;
  }

  /** Like request(), but exposes status and response headers. */
  async requestRaw<T>(path: string, opts: RequestOptions = {}): Promise<RequestResult<T>> {
    const method = opts.method ?? 'GET';
    const auth: AuthMode = opts.auth ?? 'key';
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxRetries = Math.min(opts.retries ?? MAX_RETRIES, MAX_RETRIES);

    const authHeader = this.authorizationFor(auth, opts.token);

    let attemptsLeft = maxRetries;
    let retriesUsed = 0;

    for (let attempt = 1; ; attempt++) {
      const requestId = this.newRequestId();
      const headers: Record<string, string> = { 'x-request-id': requestId };
      let bodyText: string | undefined;
      if (opts.body !== undefined) {
        bodyText = JSON.stringify(opts.body);
        headers['Content-Type'] = 'application/json';
      }
      if (authHeader !== undefined) headers['Authorization'] = authHeader;

      const url = `${this.baseUrl}${path}`;
      this.debugLog(
        `→ ${method} ${path} (attempt ${attempt})` +
          (bodyText !== undefined ? ` ${truncate(bodyText, 200)}` : ''),
      );

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const started = Date.now();

      const init: RequestInit = {
        method,
        headers,
        signal: controller.signal,
        redirect: 'error',
      };
      if (bodyText !== undefined) init.body = bodyText;

      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        clearTimeout(timer);
        const elapsed = Date.now() - started;
        if (err instanceof Error && err.name === 'AbortError') {
          this.debugLog(`← timeout (${elapsed}ms) (retries: ${retriesUsed})`);
          throw timeoutError(timeoutMs);
        }
        this.debugLog(
          `← network error (${elapsed}ms) (retries: ${retriesUsed}) ${String(err instanceof Error ? err.message : err)}`,
        );
        throw networkError(err);
      }
      clearTimeout(timer);

      const elapsed = Date.now() - started;
      const resReqId = res.headers.get('x-request-id');

      const text = await res.text();

      if (res.ok) {
        this.debugLog(
          `← ${res.status} (${elapsed}ms) x-request-id: ${resReqId ?? '—'} (retries: ${retriesUsed})` +
            (text.length > 0 ? ` ${truncate(text, 200)}` : ''),
        );
        return { data: this.parseJson<T>(text), status: res.status, headers: res.headers };
      }

      this.debugLog(
        `← ${res.status} (${elapsed}ms) x-request-id: ${resReqId ?? '—'} (retries: ${retriesUsed})` +
          (text.length > 0 ? ` ${truncate(text, 200)}` : ''),
      );

      if (attemptsLeft > 0 && this.shouldRetry(res.status)) {
        attemptsLeft -= 1;
        await sleep(this.retryDelayMs(res.status, text, res.headers, retriesUsed));
        retriesUsed += 1;
        continue;
      }

      throw classifyHttpError({
        status: res.status,
        bodyText: text,
        reqId: resReqId ?? undefined,
        retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('retry-after')),
      });
    }
  }

  /**
   * POST a request and stream its SSE response: each `data:` payload (raw
   * string, including '[DONE]') is handed to opts.onEvent as it arrives.
   *
   * Pre-stream failures behave exactly like request(): non-2xx responses are
   * read, retried on 429/5xx, and mapped via classifyHttpError. A 2xx without
   * `text/event-stream` is read whole and delivered to onEvent as a single
   * JSON payload (the non-streaming fallback — the caller decodes the
   * completion shape). Aborting opts.signal at any point rejects with a
   * 'cancelled' SeloraApiError so callers can keep the session alive.
   */
  async requestStream(path: string, opts: StreamRequestOptions): Promise<StreamResult> {
    const method = 'POST';
    // Chat is API-key-only on the gateway; authorizationFor throws the
    // standard auth error when no key is stored.
    const authHeader = this.authorizationFor('key');
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS;
    const maxRetries = Math.min(opts.retries ?? MAX_RETRIES, MAX_RETRIES);

    const bodyText = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;
    let attemptsLeft = maxRetries;
    let retriesUsed = 0;

    for (let attempt = 1; ; attempt++) {
      const requestId = this.newRequestId();
      const headers: Record<string, string> = {
        'x-request-id': requestId,
        Accept: 'text/event-stream',
      };
      if (bodyText !== undefined) headers['Content-Type'] = 'application/json';
      if (authHeader !== undefined) headers['Authorization'] = authHeader;

      const url = `${this.baseUrl}${path}`;
      this.debugLog(
        `→ ${method} ${path} (attempt ${attempt})` +
          (bodyText !== undefined ? ` ${truncate(bodyText, 200)}` : ''),
      );

      const ttfbController = new AbortController();
      const userSignal = opts.signal;
      const signal =
        userSignal === undefined
          ? ttfbController.signal
          : AbortSignal.any([ttfbController.signal, userSignal]);
      const timer = setTimeout(() => ttfbController.abort(), timeoutMs);
      const started = Date.now();

      const init: RequestInit = {
        method,
        headers,
        signal,
        redirect: 'error',
      };
      if (bodyText !== undefined) init.body = bodyText;

      let res: Response;
      try {
        res = await fetch(url, init);
      } catch (err) {
        clearTimeout(timer);
        throw this.toStreamAbortError(err, userSignal, timeoutMs, started, retriesUsed);
      }
      // Response headers arrived = first byte: the TTFB window is over.
      clearTimeout(timer);
      // After this point the timer is dead, so an abort can only be the user's.
      if (userSignal !== undefined && userSignal.aborted) {
        throw streamCancelled();
      }

      const elapsed = Date.now() - started;
      const resReqId = res.headers.get('x-request-id');

      if (!res.ok) {
        const text = await res.text();
        this.debugLog(
          `← ${res.status} (${elapsed}ms) x-request-id: ${resReqId ?? '—'} (retries: ${retriesUsed})` +
            (text.length > 0 ? ` ${truncate(text, 200)}` : ''),
        );
        if (attemptsLeft > 0 && this.shouldRetry(res.status)) {
          attemptsLeft -= 1;
          await sleep(this.retryDelayMs(res.status, text, res.headers, retriesUsed));
          retriesUsed += 1;
          continue;
        }
        throw classifyHttpError({
          status: res.status,
          bodyText: text,
          reqId: resReqId ?? undefined,
          retryAfterSeconds: parseRetryAfterSeconds(res.headers.get('retry-after')),
        });
      }

      this.debugLog(
        `← ${res.status} (${elapsed}ms) x-request-id: ${resReqId ?? '—'} (retries: ${retriesUsed})`,
      );

      const contentType = res.headers.get('content-type') ?? '';
      if (!contentType.includes('text/event-stream')) {
        // Honest fallback: a plain JSON completion, not a stream.
        const text = await res.text();
        const data = this.parseJson<unknown>(text);
        const payload = JSON.stringify(data);
        this.debugLog(`  (non-streaming completion) ${truncate(payload, 200)}`);
        opts.onEvent(payload);
        return { status: res.status, headers: res.headers, sse: false };
      }

      await this.pipeSse(res, opts, userSignal);
      return { status: res.status, headers: res.headers, sse: true };
    }
  }

  /** Read res.body through the SSE parser into opts.onEvent. */
  private async pipeSse(
    res: Response,
    opts: StreamRequestOptions,
    userSignal: AbortSignal | undefined,
  ): Promise<void> {
    const reader = res.body?.getReader();
    if (reader === undefined) {
      // No body at all (HEAD-like edge): nothing to stream.
      return;
    }
    const decoder = new TextDecoder();
    const parser = createSseParser(opts.onEvent);
    // Cancel the reader on user abort so a pending read() cannot hang forever.
    const onAbort = (): void => {
      void reader.cancel().catch(() => {});
    };
    if (userSignal !== undefined) {
      userSignal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser(decoder.decode(value, { stream: true }));
      }
      // A user abort can make read() resolve {done:true} instead of rejecting
      // — that is a cancellation, not a clean stream end.
      if (userSignal !== undefined && userSignal.aborted) {
        throw streamCancelled();
      }
      parser(decoder.decode()); // flush the decoder's internal tail
      parser.flush(); // trailing event without a final blank line
    } catch (err) {
      if (err instanceof SeloraApiError) throw err; // in-band errors thrown from onEvent
      throw this.toStreamAbortError(err, userSignal, undefined, Date.now(), 0);
    } finally {
      if (userSignal !== undefined) userSignal.removeEventListener('abort', onAbort);
    }
  }

  /** Map a fetch/read failure to cancelled / timeout / network. */
  private toStreamAbortError(
    err: unknown,
    userSignal: AbortSignal | undefined,
    timeoutMs: number | undefined,
    started: number,
    retriesUsed: number,
  ): SeloraApiError {
    const elapsed = Date.now() - started;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      if (userSignal?.aborted === true) {
        this.debugLog(`← cancelled by user (${elapsed}ms) (retries: ${retriesUsed})`);
        return streamCancelled();
      }
      this.debugLog(`← timeout (${elapsed}ms) (retries: ${retriesUsed})`);
      return timeoutError(timeoutMs ?? DEFAULT_TTFB_TIMEOUT_MS);
    }
    this.debugLog(`← network error (${elapsed}ms) (retries: ${retriesUsed})`);
    return networkError(err);
  }

  private authorizationFor(auth: AuthMode, token?: string): string | undefined {
    if (auth === 'none') return undefined;
    if (auth === 'token') {
      if (token === undefined || token === '') {
        throw new SeloraApiError({ kind: 'http_error', message: 'No session token available.' });
      }
      return `Bearer ${token}`;
    }
    if (this.apiKey === undefined || this.apiKey === '') {
      // Matches the 401 'auth' shape so callers render the login guidance.
      throw new SeloraApiError({
        kind: 'auth',
        message: 'You are not logged in. Run: selora login',
      });
    }
    return `Bearer ${this.apiKey}`;
  }

  private newRequestId(): string {
    const id = randomUUID();
    if (!REQUEST_ID_RE.test(id)) {
      throw new SeloraApiError({ kind: 'http_error', message: 'Failed to generate a request id.' });
    }
    return id;
  }

  private shouldRetry(status: number): boolean {
    if (status === 429) return true;
    return status >= 500;
  }

  private retryDelayMs(
    status: number,
    bodyText: string,
    headers: Headers,
    retriesUsed: number,
  ): number {
    if (status === 429) {
      const fromHeader = parseRetryAfterSeconds(headers.get('retry-after'));
      let fromBody: number | undefined;
      try {
        const parsed: unknown = JSON.parse(bodyText);
        if (typeof parsed === 'object' && parsed !== null) {
          const rec = parsed as Record<string, unknown>;
          if (Object.hasOwn(rec, 'error')) {
            const err = rec['error'];
            if (typeof err === 'object' && err !== null) {
              const e = err as Record<string, unknown>;
              const raw = Object.hasOwn(e, 'retry_after_seconds')
                ? e['retry_after_seconds']
                : undefined;
              if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0)
                fromBody = Math.ceil(raw);
            }
          }
        }
      } catch {
        // fall through
      }
      const seconds = fromHeader ?? fromBody;
      if (seconds !== undefined) {
        return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
      }
      return MAX_BACKOFF_MS;
    }
    // 5xx: exponential backoff 500ms / 1000ms by retry index.
    return MAX_BACKOFF_MS * 2 ** (retriesUsed % 2);
  }

  private parseJson<T>(text: string): T {
    if (text.length === 0) {
      return undefined as T;
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SeloraApiError({
        kind: 'http_error',
        message: 'Selora returned an unreadable response — please try again.',
        body: redact(truncate(text, 2000)),
      });
    }
  }
}
