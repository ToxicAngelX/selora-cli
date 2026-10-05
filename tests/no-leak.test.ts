/**
 * THE no-leak rule, pinned. Runs the credential-carrying command flows in
 * DEBUG mode (the worst case — debug logs request AND response bodies) and
 * scans every captured byte of stdout+stderr for real-looking secrets.
 *
 * Rules enforced:
 *  - No output may match /sk-gw-(?!TEST)/ — a real-looking Selora key.
 *    (Fake fixtures all start with sk-gw-TEST; only they are allowed.)
 *  - No output may contain the fake session JWT value (redaction must have
 *    caught it inside the login response body debug dump).
 *  - No output may contain "Bearer <any fixture key>" unredacted.
 *  - Debug mode must actually have run (redacted placeholders must appear),
 *    so this test can't pass by never exercising the debug path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  EMAIL,
  FAKE_JWT,
  FAKE_KEY_CREATED,
  FAKE_KEY_USER,
  LOGIN_SUCCESS,
  ME_BODY,
  createKeyBody,
  keysBody,
  last4,
  DELETE_KEY_OK,
} from './mock/fixtures.js';
import { capturedIo, cleanup, freshEnv, pipedStdin, useApiUrl, type TempEnv } from './helpers/env.js';
import { runLogin } from '../src/commands/login.js';
import { runLogout } from '../src/commands/logout.js';
import { runWhoami } from '../src/commands/whoami.js';
import { runKeys } from '../src/commands/keys.js';
import type { CliContext } from '../src/context.js';

const PASSWORD = 'correct-horse-battery-staple';
/** A real-looking (non-TEST) key: must never appear in ANY output. */
const REAL_LOOKING_KEY = 'sk-gw-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGhI';

let server: MockServer;
let env: TempEnv;

function debugCtx(stdin: string[]): { c: CliContext; cap: { all(): string } } {
  const { io, cap } = capturedIo();
  return {
    c: { debug: true, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin(stdin) } },
    cap,
  };
}

function installRoutes(): void {
  server.setHandler((req) => {
    const auth = req.headers['authorization'] ?? '';
    if (req.method === 'POST' && req.path === '/v1/auth/login') {
      const body = JSON.parse(req.body) as { password?: unknown };
      return body.password === PASSWORD ? { status: 200, body: LOGIN_SUCCESS } : { status: 401, body: LOGIN_SUCCESS };
    }
    if (req.method === 'POST' && req.path === '/v1/me/keys') {
      // The server briefly sees the session token; the response carries the
      // one-time secret (matched by the key-redaction pattern).
      return { status: 201, body: createKeyBody(FAKE_KEY_CREATED) };
    }
    if (req.method === 'GET' && req.path === '/v1/me/keys') {
      return { status: 200, body: keysBody([last4(FAKE_KEY_USER)]) };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_1') {
      return { status: 200, body: DELETE_KEY_OK };
    }
    if (req.method === 'GET' && req.path === '/v1/me') {
      // 200 for both valid keys; anything else falls through to 401 below.
      if (auth === `Bearer ${FAKE_KEY_USER}` || auth === `Bearer ${FAKE_KEY_CREATED}`) {
        return { status: 200, body: ME_BODY };
      }
      return { status: 401, body: ME_BODY };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
}

function assertNoLeak(output: string, label: string): void {
  const realKeyMatch = output.match(/sk-gw-(?!TEST)/);
  expect(realKeyMatch, `${label}: real-looking key leaked`).toBeNull();
  expect(output.includes(FAKE_JWT), `${label}: session JWT leaked`).toBe(false);
  expect(output.includes(`Bearer ${FAKE_KEY_USER}`), `${label}: Bearer key leaked`).toBe(false);
  expect(output.includes(`Bearer ${FAKE_KEY_CREATED}`), `${label}: Bearer created key leaked`).toBe(false);
  expect(output.includes(REAL_LOOKING_KEY), `${label}: synthetic real key leaked`).toBe(false);
}

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
  useApiUrl(server.url);
});

afterAll(async () => {
  cleanup(env.dir);
  await server.close();
});

describe('no-leak (hard rule: credentials never appear in output, even in debug mode)', () => {
  it('login Path A in debug mode: token, password, and secret all redacted', async () => {
    installRoutes();
    const { c, cap } = debugCtx([EMAIL, PASSWORD]);
    await runLogin(c, {});
    const text = cap.all();
    // debug actually ran: request lines exist, and the login request body's
    // password + response body's session token were redacted (the one-time
    // secret sits past the 200-char debug truncation, so it never prints).
    expect(text).toContain('→');
    expect(text).toContain('"password":"…redacted"');
    expect(text).toContain('"token":"…redacted"');
    assertNoLeak(text, 'login path A');
  });

  it('login --key in debug mode: the supplied key never echoes', async () => {
    installRoutes();
    const { c, cap } = debugCtx([]);
    await runLogin(c, { key: FAKE_KEY_USER });
    assertNoLeak(cap.all(), 'login --key');
  });

  it('whoami + logout --revoke in debug mode: no leaks', async () => {
    installRoutes();
    const { c: cL, cap: capL } = debugCtx([]);
    await runLogin(cL, { key: FAKE_KEY_USER });
    assertNoLeak(capL.all(), 'setup login');

    const { c: cW, cap: capW } = debugCtx([]);
    await runWhoami(cW);
    assertNoLeak(capW.all(), 'whoami');

    const { c: cO, cap: capO } = debugCtx([]);
    await runLogout(cO, { revoke: true, yes: true });
    assertNoLeak(capO.all(), 'logout --revoke');
  });

  it('invalid key error in debug mode: the offending key value never prints', async () => {
    server.setHandler(() => ({ status: 401, body: ME_BODY }));
    const { c, cap } = debugCtx([]);
    process.exitCode = undefined;
    await runLogin(c, { key: REAL_LOOKING_KEY });
    const text = cap.all();
    expect(process.exitCode).toBe(1);
    expect(text).toContain('not accepted');
    assertNoLeak(text, 'invalid key');
  });

  it('keys list in debug mode: only the backend-masked hint appears, no leaks', async () => {
    installRoutes();
    const { c: cL, cap: capL } = debugCtx([]);
    await runLogin(cL, { key: FAKE_KEY_USER });
    assertNoLeak(capL.all(), 'setup login');

    const { c, cap } = debugCtx([]);
    await runKeys(c, 'list', undefined, {});
    const text = cap.all();
    expect(text).toContain('…' + last4(FAKE_KEY_USER));
    assertNoLeak(text, 'keys list');
  });

  it('keys create in debug mode: the one-time secret appears EXACTLY ONCE in the combined output and ZERO times on stderr (the debug channel)', async () => {
    installRoutes();
    const { c: cL, cap: capL } = debugCtx([]);
    await runLogin(cL, { key: FAKE_KEY_USER });
    assertNoLeak(capL.all(), 'setup login');

    const { c, cap } = debugCtx([]);
    await runKeys(c, 'create', undefined, {});
    const text = cap.all();
    const stdout = cap.out.join('\n');
    const stderr = cap.err.join('\n');
    // the deliberate one-time print: exactly once overall, once on stdout,
    // and never on the stderr/debug channel.
    expect(text.split(FAKE_KEY_CREATED).length - 1).toBe(1);
    expect(stdout.split(FAKE_KEY_CREATED).length - 1).toBe(1);
    expect(stderr.includes(FAKE_KEY_CREATED)).toBe(false);
    assertNoLeak(text, 'keys create');
  });
});
