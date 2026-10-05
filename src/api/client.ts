/**
 * SeloraClient — the single HTTP chokepoint. Every gateway call in the CLI
 * goes through here: headers, x-request-id, timeouts, retries, error mapping,
 * and debug logging (one printer, always redacted) all live in this file.
 */

import { randomUUID } from 'node:crypto';
import { classifyHttpError, networkError, timeoutError, SeloraApiError } from './errors.js';
import { redact } from './redact.js';

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

const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
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
      throw new SeloraApiError({ kind: 'auth', message: 'You are not logged in. Run: selora login' });
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

  private retryDelayMs(status: number, bodyText: string, headers: Headers, retriesUsed: number): number {
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
              const raw = Object.hasOwn(e, 'retry_after_seconds') ? e['retry_after_seconds'] : undefined;
              if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) fromBody = Math.ceil(raw);
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
