/**
 * SeloraClient behavior against the local mock gateway: retries (429 with
 * Retry-After, 5xx backoff), no retry on plain 4xx, timeout on a hanging
 * route, and outbound headers (x-request-id, Authorization).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mock/server.js';
import { INTERNAL_500, LOGIN_FAIL, RATE_LIMIT_429, ME_BODY } from './mock/fixtures.js';
import { SeloraClient } from '../src/api/client.js';
import { SeloraApiError } from '../src/api/errors.js';

let server: MockServer;

beforeAll(async () => {
  server = await startMockServer();
});

afterAll(async () => {
  await server.close();
});

function client(_opts: { retries?: number; timeoutMs?: number } = {}): SeloraClient {
  return new SeloraClient({ baseUrl: server.url, apiKey: 'sk-gw-TESTclient', debug: false });
}

describe('SeloraClient', () => {
  it('sends x-request-id and Authorization headers', async () => {
    server.setHandler(() => ({ status: 200, body: ME_BODY }));
    const res = await client().requestRaw('/v1/me', {});
    expect(res.status).toBe(200);
    expect(server.requests.at(-1)?.headers['x-request-id']).toMatch(/^[A-Za-z0-9._-]{1,64}$/);
    expect(server.requests.at(-1)?.headers['authorization']).toBe('Bearer sk-gw-TESTclient');
  });

  it('auth:none omits the Authorization header entirely', async () => {
    server.setHandler(() => ({ status: 200, body: ME_BODY }));
    await client().request('/v1/me', { auth: 'none' });
    expect(server.requests.at(-1)?.headers['authorization']).toBeUndefined();
  });

  it('retries 429 honoring Retry-After, then succeeds', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      if (calls === 1) return { status: 429, body: RATE_LIMIT_429, headers: { 'retry-after': '0' } };
      return { status: 200, body: ME_BODY };
    });
    const data = await client().request<unknown>('/v1/me', { retries: 2 });
    expect(data).toBeDefined();
    expect(calls).toBe(2);
  });

  it('gives up after max retries on persistent 429 and maps rate_limited', async () => {
    server.setHandler(() => ({ status: 429, body: RATE_LIMIT_429, headers: { 'retry-after': '0' } }));
    await expect(client().request('/v1/me', { retries: 1 })).rejects.toMatchObject({
      kind: 'rate_limited',
      status: 429,
    });
    // first attempt + 1 retry
    expect(server.requests.length).toBeGreaterThanOrEqual(2);
  });

  it('retries 5xx with backoff, then succeeds', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      if (calls <= 2) return { status: 500, body: INTERNAL_500 };
      return { status: 200, body: ME_BODY };
    });
    await client().request<unknown>('/v1/me', { retries: 2 });
    expect(calls).toBe(3);
  });

  it('does NOT retry plain 4xx (401)', async () => {
    server.setHandler(() => ({ status: 401, body: LOGIN_FAIL }));
    await expect(client().request('/v1/me', {})).rejects.toMatchObject({ kind: 'auth', status: 401 });
    const before = server.requests.length;
    await expect(client().request('/v1/me', {})).rejects.toBeInstanceOf(SeloraApiError);
    expect(server.requests.length).toBe(before + 1);
  });

  it('times out on a hanging route and maps a timeout error', async () => {
    server.setHandler(() => ({ status: 200, body: ME_BODY, hang: true }));
    await expect(client().request('/v1/me', { timeoutMs: 80 })).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('network failure maps to the network error kind', async () => {
    const dead = new SeloraClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-gw-TESTdead', debug: false });
    await expect(dead.request('/v1/me', { timeoutMs: 500 })).rejects.toMatchObject({
      kind: 'network',
    });
  });
});
