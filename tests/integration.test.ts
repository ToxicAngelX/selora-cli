/**
 * Command-level integration tests: login (both paths), logout (local +
 * --revoke hint matching), whoami — all against the local mock gateway via
 * the real command handlers with injected I/O. Never touches prod.
 */

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  EMAIL,
  FAKE_JWT,
  FAKE_KEY_CREATED,
  FAKE_KEY_USER,
  LOGIN_FAIL,
  LOGIN_SUCCESS,
  ME_BODY,
  REVOKED_KEY_401,
  INVALID_KEY_401,
  createKeyBody,
  keysBody,
  last4,
  DELETE_KEY_OK,
} from './mock/fixtures.js';
import { capturedIo, cleanup, freshEnv, pipedStdin, useApiUrl, type TempEnv } from './helpers/env.js';
import { configPath, saveConfig } from '../src/config/index.js';
import { runLogin } from '../src/commands/login.js';
import { runLogout } from '../src/commands/logout.js';
import { runWhoami } from '../src/commands/whoami.js';
import type { CliContext } from '../src/context.js';

const PASSWORD = 'correct-horse-battery-staple';

let server: MockServer;
let env: TempEnv;

/** Route mock requests by method/path/Authorization, like the real gateway. */
function installRoutes(opts: { loginPassword?: string } = {}): void {
  const loginPassword = opts.loginPassword ?? PASSWORD;
  server.setHandler((req) => {
    const auth = req.headers['authorization'] ?? '';
    if (req.method === 'POST' && req.path === '/v1/auth/login') {
      const body = JSON.parse(req.body) as { password?: unknown };
      return body.password === loginPassword
        ? { status: 200, body: LOGIN_SUCCESS }
        : { status: 401, body: LOGIN_FAIL };
    }
    if (req.method === 'POST' && req.path === '/v1/me/keys') {
      if (auth === `Bearer ${FAKE_JWT}`) return { status: 201, body: createKeyBody(FAKE_KEY_CREATED) };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'GET' && req.path === '/v1/me/keys') {
      if (auth === `Bearer ${FAKE_KEY_USER}`) return { status: 200, body: keysBody([last4(FAKE_KEY_USER)]) };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_1') {
      return { status: 200, body: DELETE_KEY_OK };
    }
    if (req.method === 'GET' && req.path === '/v1/me') {
      if (auth === `Bearer ${FAKE_KEY_USER}` || auth === `Bearer ${FAKE_KEY_CREATED}`) {
        return { status: 200, body: ME_BODY };
      }
      if (auth === `Bearer ${FAKE_JWT}`) return { status: 401, body: INVALID_KEY_401 };
      return { status: 401, body: INVALID_KEY_401 };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
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

describe('login', () => {
  it('Path A: password → creates CLI key, stores it, never prints the secret', async () => {
    installRoutes();
    const { io, cap } = capturedIo();
    const c: CliContext = {
      debug: false,
      json: false,
      apiUrl: server.url,
      io: { ...io, stdin: pipedStdin([EMAIL, PASSWORD]) },
    };
    process.exitCode = undefined;
    await runLogin(c, {});
    const text = cap.all();
    expect(text).toContain(EMAIL);
    expect(text).toContain('CLI key created');
    expect(text).not.toContain(FAKE_KEY_CREATED);
    expect(text).not.toContain(FAKE_JWT);
    // key creation was authorized by the in-memory session token
    const keysReq = server.requests.find((r) => r.method === 'POST' && r.path === '/v1/me/keys');
    expect(keysReq?.headers['authorization']).toBe(`Bearer ${FAKE_JWT}`);
    // the new key was validated via /v1/me before storing
    const meReq = server.requests.filter((r) => r.method === 'GET' && r.path === '/v1/me').at(-1);
    expect(meReq?.headers['authorization']).toBe(`Bearer ${FAKE_KEY_CREATED}`);
    // stored in the 0600 config file
    const stored = readFileSync(configPath(), 'utf8');
    expect(stored).toContain(FAKE_KEY_CREATED);
    expect(stored).not.toContain(FAKE_JWT);
    expect(process.exitCode).toBeUndefined();
  });

  it('Path A wrong password: honest hint mentions login --key; nothing stored', async () => {
    installRoutes({ loginPassword: 'different' });
    // start from a clean config so "nothing stored" is unambiguous
    saveConfig({});
    const { io, cap } = capturedIo();
    const c: CliContext = {
      debug: false,
      json: false,
      apiUrl: server.url,
      io: { ...io, stdin: pipedStdin([EMAIL, 'wrong-password']) },
    };
    process.exitCode = undefined;
    await runLogin(c, {});
    const text = cap.all();
    expect(text).toContain('Invalid email or password');
    expect(text).toContain('selora login --key');
    expect(text).toContain('Google sign-in');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('sk-gw-');
    expect(process.exitCode).toBe(1);
  });

  it('Path B --key: validates via /v1/me, then stores', async () => {
    installRoutes();
    const { io, cap } = capturedIo();
    const c: CliContext = {
      debug: false,
      json: false,
      apiUrl: server.url,
      io: { ...io, stdin: pipedStdin([]) },
    };
    await runLogin(c, { key: FAKE_KEY_USER });
    const text = cap.all();
    expect(text).toContain(EMAIL);
    expect(text).toContain('Key validated');
    expect(readFileSync(configPath(), 'utf8')).toContain(FAKE_KEY_USER);
  });

  it('Path B --key invalid: not stored, clean error', async () => {
    installRoutes();
    const { io, cap } = capturedIo();
    const c: CliContext = {
      debug: false,
      json: false,
      apiUrl: server.url,
      io: { ...io, stdin: pipedStdin([]) },
    };
    process.exitCode = undefined;
    await runLogin(c, { key: 'sk-gw-TESTinvalidkey00000000000000000000000000000000' });
    const text = cap.all();
    expect(text).toContain('not accepted');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('sk-gw-TESTinvalidkey');
    expect(process.exitCode).toBe(1);
  });

  it('--json prints machine-readable output only', async () => {
    installRoutes();
    const { io, cap } = capturedIo();
    const c: CliContext = {
      debug: false,
      json: true,
      apiUrl: server.url,
      io: { ...io, stdin: pipedStdin([]) },
    };
    await runLogin(c, { key: FAKE_KEY_USER });
    const parsed = JSON.parse(cap.out.join('\n')) as { ok: boolean; email: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.email).toBe(EMAIL);
  });
});

describe('whoami', () => {
  it('renders email, plan term, and wallet from /v1/me', async () => {
    installRoutes();
    // store a key first (login --key path already proven; do it directly)
    const { io: ioL, cap: capL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );
    expect(capL.all()).toContain(EMAIL);

    const { io, cap } = capturedIo();
    await runWhoami({ debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } });
    const text = cap.all();
    expect(text).toContain(EMAIL);
    expect(text).toContain('Nova');
    expect(text).toContain('paid');
    expect(text).toContain('$42.18');
  });

  it('revoked key: passes the backend rotation hint through verbatim', async () => {
    server.setHandler(() => ({ status: 401, body: REVOKED_KEY_401 }));
    const { io, cap } = capturedIo();
    process.exitCode = undefined;
    await runWhoami({ debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } });
    const text = cap.all();
    expect(text).toContain('This API key was revoked on 2026-10-01');
    expect(text).toContain('restart the app');
    expect(process.exitCode).toBe(1);
  });

  it('--json keeps full-precision wire money strings', async () => {
    installRoutes();
    // ensure the stored key is the valid one
    const { io: ioL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );
    const { io: ioW, cap: capW } = capturedIo();
    await runWhoami({ debug: false, json: true, apiUrl: server.url, io: { ...ioW, stdin: pipedStdin([]) } });
    const parsed = JSON.parse(capW.out.join('\n')) as { ok: boolean; wallet?: { balance?: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.wallet?.balance).toBe('42.180000');
  });
});

describe('logout', () => {
  it('local: clears the stored key', async () => {
    installRoutes();
    const { io: ioL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );
    expect(readFileSync(configPath(), 'utf8')).toContain(FAKE_KEY_USER);

    const { io, cap } = capturedIo();
    await runLogout({ debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } }, {});
    expect(cap.all()).toContain('Logged out');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('sk-gw-');
  });

  it('--revoke --yes: matches by key hint and DELETEs the right key id', async () => {
    installRoutes();
    const { io: ioL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );

    const { io, cap } = capturedIo();
    await runLogout(
      { debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } },
      { revoke: true, yes: true },
    );
    const text = cap.all();
    expect(text).toContain('Revoked');
    expect(text).toContain(last4(FAKE_KEY_USER));
    const delReq = server.requests.find((r) => r.method === 'DELETE' && r.path.startsWith('/v1/me/keys/'));
    expect(delReq?.path).toBe('/v1/me/keys/key_1');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('sk-gw-');
  });

  it('--revoke --yes with no matching server key: nothing revoked, local still cleared', async () => {
    installRoutes();
    const { io: ioL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );
    // server now returns keys with a different hint
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path === '/v1/me/keys') {
        return { status: 200, body: keysBody(['ZZZZ']) };
      }
      return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
    });
    const { io, cap } = capturedIo();
    await runLogout(
      { debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } },
      { revoke: true, yes: true },
    );
    const text = cap.all();
    expect(text).toContain('nothing revoked');
    expect(text).toContain('Logged out');
    expect(readFileSync(configPath(), 'utf8')).not.toContain('sk-gw-');
  });

  it('--revoke without --yes in non-TTY: refuses and keeps the key', async () => {
    installRoutes();
    // store a key first so logout actually has something to refuse to revoke
    const { io: ioL } = capturedIo();
    await runLogin(
      { debug: false, json: false, apiUrl: server.url, io: { ...ioL, stdin: pipedStdin([]) } },
      { key: FAKE_KEY_USER },
    );
    const { io, cap } = capturedIo();
    await runLogout(
      { debug: false, json: false, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } },
      { revoke: true, yes: false },
    );
    expect(cap.all()).toContain('Refusing to revoke');
    expect(readFileSync(configPath(), 'utf8')).toContain(FAKE_KEY_USER);
  });
});
