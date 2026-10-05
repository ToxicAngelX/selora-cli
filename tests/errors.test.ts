import { describe, expect, it } from 'vitest';
import { classifyHttpError, decodeErrorEnvelope, networkError, timeoutError, SeloraApiError } from '../src/api/errors.js';

const RID = 'req_test_1';

function envelope(code: string, message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ error: { code, message, request_id: RID, ...extra } });
}

describe('error classification', () => {
  it('401 unauthorized → auth kind with login guidance', () => {
    const err = classifyHttpError({ status: 401, bodyText: envelope('unauthorized', 'Invalid email or password') });
    expect(err.kind).toBe('auth');
    expect(err.message).toBe('You are not logged in. Run: selora login');
    expect(err.reqId).toBe(RID);
    expect(err.status).toBe(401);
    // apiMessage preserves the verbatim backend message for special-casing
    expect(err.apiMessage).toBe('Invalid email or password');
  });

  it('401 api_key_revoked → auth_revoked, message verbatim (rotation hint inside)', () => {
    const msg =
      'This API key was revoked on 2026-10-01. If you rotated it, your client is still sending the OLD key — update the key everywhere it is configured, then fully restart the app.';
    const err = classifyHttpError({ status: 401, bodyText: envelope('api_key_revoked', msg) });
    expect(err.kind).toBe('auth_revoked');
    expect(err.message).toBe(msg);
  });

  it('402 no plan → no_plan + trial hint', () => {
    const err = classifyHttpError({
      status: 402,
      bodyText: envelope('insufficient_balance', 'No API credits remaining. Purchase a plan to continue.'),
    });
    expect(err.kind).toBe('no_plan');
    expect(err.message).toBe('No API credits remaining. Purchase a plan to continue.');
    expect(err.hint).toBe('Start the free trial at selora.lol');
  });

  it('402 window exhausted → window_exhausted, verbatim (resetsAt inside message)', () => {
    const msg =
      'Your 4h plan usage limit is reached and your API credit balance is empty. Top up API credits to continue pay-as-you-go, or wait for the window to reset. Plan usage resumes at 2026-10-05T14:00:00Z.';
    const err = classifyHttpError({ status: 402, bodyText: envelope('insufficient_balance', msg) });
    expect(err.kind).toBe('window_exhausted');
    expect(err.message).toBe(msg);
    expect(err.hint).toBeUndefined();
  });

  it('402 plan buffer → plan_buffer, verbatim', () => {
    const msg =
      'No spendable API credits right now — your plan allowance refills shortly. Top up API credits to continue immediately.';
    const err = classifyHttpError({ status: 402, bodyText: envelope('insufficient_balance', msg) });
    expect(err.kind).toBe('plan_buffer');
    expect(err.message).toBe(msg);
  });

  it('429 → rate_limited, verbatim + retry hint from retry_after_seconds', () => {
    const err = classifyHttpError({
      status: 429,
      bodyText: envelope('rate_limited', 'Rate limit exceeded. Retry in 30s.', { retryable: true, retry_after_seconds: 30 }),
    });
    expect(err.kind).toBe('rate_limited');
    expect(err.message).toBe('Rate limit exceeded. Retry in 30s.');
    expect(err.hint).toBe('Wait 30s before trying again.');
    expect(err.retryAfterSeconds).toBe(30);
  });

  it('429 retry hint prefers the Retry-After header when the body lacks it', () => {
    const err = classifyHttpError({
      status: 429,
      bodyText: envelope('rate_limited', 'Rate limit exceeded. Retry in 2s.'),
      retryAfterSeconds: 2,
    });
    expect(err.hint).toBe('Wait 2s before trying again.');
  });

  it('5xx → server kind with generic message', () => {
    const err = classifyHttpError({ status: 502, bodyText: envelope('internal_error', 'boom') });
    expect(err.kind).toBe('server');
    expect(err.message).toBe('Selora is having trouble — please try again.');
  });

  it('other 4xx → http_error with backend message verbatim', () => {
    const err = classifyHttpError({ status: 400, bodyText: envelope('bad_request', 'days must be 1-365') });
    expect(err.kind).toBe('http_error');
    expect(err.message).toBe('days must be 1-365');
  });

  it('unknown envelope shape → generic fallback, raw body kept for --debug', () => {
    const err = classifyHttpError({ status: 400, bodyText: '{"oops": true}' });
    expect(err.kind).toBe('http_error');
    expect(err.message).toBe('Request failed (HTTP 400).');
    expect(err.body).toContain('"oops"');
  });

  it('non-JSON body → generic fallback, no crash', () => {
    const err = classifyHttpError({ status: 500, bodyText: '<html>gateway died</html>' });
    expect(err.kind).toBe('server');
  });

  it('402 with unknown message text → http_error fallback (never a fabricated kind)', () => {
    const err = classifyHttpError({ status: 402, bodyText: envelope('insufficient_balance', 'Something else') });
    expect(err.kind).toBe('http_error');
    expect(err.message).toBe('Something else');
  });

  it('network/timeout errors carry honest messages + debug hint', () => {
    expect(networkError().message).toBe('Unable to connect to Selora — check your connection or try again.');
    expect(networkError().hint).toBe('(run with --debug for details)');
    expect(timeoutError(1000).kind).toBe('timeout');
    expect(timeoutError(1000).message).toContain('timed out');
  });

  it('redacts keys inside the raw body kept for --debug', () => {
    const err = classifyHttpError({
      status: 400,
      bodyText: '{"error":{"code":"x","message":"bad key sk-gw-TESTSECRETVALUE"}}',
    });
    expect(err.body).toContain('sk-gw-…redacted');
    expect(err.body).not.toContain('sk-gw-TESTSECRETVALUE');
  });

  it('decodeErrorEnvelope guards non-object and missing error field', () => {
    expect(decodeErrorEnvelope('[]')).toEqual({ code: undefined, message: undefined, retryAfterSeconds: undefined, reqId: undefined });
    expect(decodeErrorEnvelope('{"no_error": 1}').code).toBeUndefined();
    expect(decodeErrorEnvelope('not json').message).toBeUndefined();
    expect(decodeErrorEnvelope('{"error": "string not object"}').code).toBeUndefined();
  });

  it('SeloraApiError.toJson omits undefined fields', () => {
    const err = new SeloraApiError({ kind: 'auth', message: 'x' });
    expect(err.toJson()).toEqual({ kind: 'auth', message: 'x' });
    const rich = new SeloraApiError({ kind: 'http_error', message: 'x', status: 409, reqId: 'r1', hint: 'h' });
    expect(rich.toJson()).toEqual({ kind: 'http_error', message: 'x', hint: 'h', reqId: 'r1', status: 409 });
  });
});
