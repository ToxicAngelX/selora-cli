/**
 * Phase 2 data-command integration tests: balance, usage, models, model,
 * keys — against the local mock gateway via the real command handlers with
 * injected I/O. Never touches prod.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  BALANCE_BODY,
  DELETE_KEY_HARD,
  DELETE_KEY_OK,
  FAKE_KEY_CREATED,
  FAKE_KEY_USER,
  KEYS_EMPTY_BODY,
  KEYS_LIST_BODY,
  KEY_LIMIT_409,
  KEY_NOT_FOUND_404,
  ME_BODY,
  MODELS_BODY,
  MODEL_NOT_FOUND_404,
  USAGE_EMPTY_BODY,
  WINDOWS_BODY,
  WINDOWS_BODY_EXHAUSTED,
  createKeyBody,
  modelDetailBody,
  usageBody,
} from './mock/fixtures.js';
import { capturedIo, cleanup, freshEnv, pipedStdin, useApiUrl, type TempEnv } from './helpers/env.js';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { storeKey } from '../src/auth/storage.js';
import { runBalance } from '../src/commands/balance.js';
import { runUsage } from '../src/commands/usage.js';
import { runModels } from '../src/commands/models.js';
import { runModel } from '../src/commands/model.js';
import { runKeys } from '../src/commands/keys.js';
import type { CliContext } from '../src/context.js';

let server: MockServer;
let env: TempEnv;

const AUTH_OK = `Bearer ${FAKE_KEY_USER}`;

const INVALID_KEY_401 = JSON.stringify({
  error: { code: 'unauthorized', message: 'Invalid API key', request_id: 'req_invalid' },
});

interface RouteOpts {
  usageBodyFor?: (days: number) => string;
  windowsBody?: string;
  modelsBody?: string;
}

function installRoutes(opts: RouteOpts = {}): void {
  const usageFor = opts.usageBodyFor ?? usageBody;
  const windows = opts.windowsBody ?? WINDOWS_BODY;
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path === '/v1/me') {
      if (req.headers['authorization'] === AUTH_OK) return { status: 200, body: ME_BODY };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'GET' && req.path === '/v1/me/balance') {
      if (req.headers['authorization'] === AUTH_OK) return { status: 200, body: BALANCE_BODY };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'GET' && req.path === '/v1/me/windows') {
      if (req.headers['authorization'] === AUTH_OK) return { status: 200, body: windows };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'GET' && req.path === '/v1/me/usage') {
      if (req.headers['authorization'] !== AUTH_OK) return { status: 401, body: INVALID_KEY_401 };
      const days = Number(new URL(req.url, 'http://mock').searchParams.get('days'));
      return { status: 200, body: usageFor(Number.isFinite(days) && days > 0 ? days : 30) };
    }
    if (req.method === 'GET' && req.path === '/v1/models') {
      // Public route; the internal flavor (with pricing) requires NO auth header.
      if (req.headers['authorization'] !== undefined) return { status: 401, body: INVALID_KEY_401 };
      return { status: 200, body: opts.modelsBody ?? MODELS_BODY };
    }
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.path.slice('/v1/models/'.length));
      if (id === 'no-such-model') return { status: 404, body: MODEL_NOT_FOUND_404 };
      if (req.headers['authorization'] !== undefined) return { status: 401, body: INVALID_KEY_401 };
      return { status: 200, body: modelDetailBody(id, id === 'claude-haiku-4.5' ? { max_output_tokens: 65536 } : {}) };
    }
    if (req.method === 'GET' && req.path === '/v1/me/keys') {
      if (req.headers['authorization'] === AUTH_OK) return { status: 200, body: KEYS_LIST_BODY };
      return { status: 401, body: INVALID_KEY_401 };
    }
    if (req.method === 'POST' && req.path === '/v1/me/keys') {
      if (req.headers['authorization'] === AUTH_OK) return { status: 201, body: createKeyBody(FAKE_KEY_CREATED) };
      return { status: 409, body: KEY_LIMIT_409 };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_1') {
      return { status: 200, body: DELETE_KEY_OK };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_2') {
      return { status: 200, body: DELETE_KEY_HARD };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_3') {
      return { status: 404, body: KEY_NOT_FOUND_404 };
    }
    if (req.method === 'DELETE' && req.path === '/v1/me/keys/key_4') {
      return { status: 404, body: KEY_NOT_FOUND_404 };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
}

function run(cmd: (c: CliContext) => Promise<void>, json = false, debug = false) {
  const { io, cap } = capturedIo();
  const c: CliContext = { debug, json, apiUrl: server.url, io: { ...io, stdin: pipedStdin([]) } };
  return { promise: cmd(c), cap };
}

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
  useApiUrl(server.url);
  storeKey(FAKE_KEY_USER);
});

afterAll(async () => {
  cleanup(env.dir);
  await server.close();
});

describe('balance', () => {
  it('renders wallet, plan, both windows, and the resets-in countdown', async () => {
    installRoutes();
    const { promise, cap } = run(runBalance);
    await promise;
    const text = cap.all();
    expect(text).toContain('SELORA BALANCE');
    expect(text).toContain('Wallet (plan purchases)');
    expect(text).toContain('$42.18');
    expect(text).toMatch(/Plan\s+Nova — \d+ days left/);
    expect(text).toContain('$8.20 of $10.00');
    // fixture resetsInMs is a fixed 4_320_000 → exactly "1h 12m"
    expect(text).toContain('resets in 1h 12m');
    expect(text).toContain('$47.00 of $60.00');
    expect(text).toMatch(/Updated\s+\d{2}:\d{2}:\d{2}/);
  });

  it('exhausted session → "exhausted — resets in …"', async () => {
    installRoutes({ windowsBody: WINDOWS_BODY_EXHAUSTED });
    const { promise, cap } = run(runBalance);
    await promise;
    expect(cap.all()).toContain('exhausted — resets in 1h 12m');
  });

  it('no auth → standard login error path', async () => {
    installRoutes();
    delete process.env['SELORA_API_KEY'];
    // config still has the key; force the env-var-less file path by pointing XDG at a fresh dir
    const { dir } = { dir: env.dir };
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = `${dir}-none`;
    process.exitCode = undefined;
    const { promise, cap } = run(runBalance);
    await promise;
    process.env['XDG_CONFIG_HOME'] = savedXdg;
    expect(cap.all()).toContain('You are not logged in. Run: selora login');
    expect(process.exitCode).toBe(1);
  });

  it('--json preserves raw wire strings and records fetched_at', async () => {
    installRoutes();
    const { promise, cap } = run(runBalance, true);
    await promise;
    const parsed = JSON.parse(cap.out.join('\n')) as {
      ok: boolean;
      wallet?: { balance?: string };
      windows?: { session?: { remainingUsd?: string; resetsInMs?: number }; week?: { remainingUsd?: string } };
      plan?: { name?: string; kind?: string; ends_at?: string };
      fetched_at?: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.wallet?.balance).toBe('42.180000');
    expect(parsed.windows?.session?.remainingUsd).toBe('8.200000');
    expect(parsed.windows?.session?.resetsInMs).toBe(4_320_000);
    expect(parsed.windows?.week?.remainingUsd).toBe('47.000000');
    expect(parsed.plan?.name).toBe('Nova');
    expect(parsed.plan?.kind).toBe('paid');
    expect(parsed.plan?.ends_at).toBe('2026-10-16T12:00:00Z');
    expect(Number.isNaN(Date.parse(parsed.fetched_at ?? ''))).toBe(false);
  });
});

describe('usage', () => {
  it('default: Today AND This week lines, summed with BigInt over string rows', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, {}));
    await promise;
    const text = cap.all();
    expect(text).toMatch(/Today\s+183 requests · 2\.8M in · 1\.1M out · \$1\.42/);
    expect(text).toMatch(/This week\s+1,204 requests · 18\.1M in · 7\.2M out · \$9\.10/);
  });

  it('--week: single line, no Today line', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, { week: true }));
    await promise;
    const text = cap.all();
    expect(text).toMatch(/This week\s+1,204 requests · 18\.1M in · 7\.2M out · \$9\.10/);
    expect(text).not.toContain('Today');
  });

  it('--month: 30-day sums', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, { month: true }));
    await promise;
    expect(cap.all()).toMatch(/This month\s+1,304 requests · 20\.1M in · 7\.7M out · \$9\.90/);
  });

  it('conflicting flags → honest error naming the API limitation', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, { today: true, week: true }));
    await promise;
    expect(cap.all()).toContain('Pick one of --today, --week, or --month');
    expect(cap.all()).toContain('no arbitrary date ranges');
  });

  it('empty summary → the honest message, not a fake zero line', async () => {
    installRoutes({ usageBodyFor: () => USAGE_EMPTY_BODY });
    const { promise, cap } = run((c) => runUsage(c, {}));
    await promise;
    expect(cap.all()).toContain('No usage recorded in this period.');
  });

  it('--by-model: separate "All-time by model" table, never mixed into range lines', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, { byModel: true }));
    await promise;
    const text = cap.all();
    expect(text).toContain('All-time by model');
    expect(text).toContain('glm-5.3-flash');
    expect(text).toContain('5,210');
    expect(text).toContain('$40.12');
    // period lines keep the period sums, not the all-time ones
    expect(text).toMatch(/This week\s+1,204 requests · 18\.1M in · 7\.2M out · \$9\.10/);
    expect(text).not.toContain('$40.12 requests');
  });

  it('--json (flag mode): days, totals as strings, raw summary rows', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, { today: true }), true);
    await promise;
    const parsed = JSON.parse(cap.out.join('\n')) as {
      ok: boolean;
      days?: number;
      totals?: { requests?: string; input_tokens?: string; output_tokens?: string; spend?: string };
      summary?: Array<{ date: string }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.days).toBe(1);
    expect(parsed.totals?.requests).toBe('183');
    expect(parsed.totals?.input_tokens).toBe('2800000');
    expect(parsed.totals?.output_tokens).toBe('1100000');
    expect(parsed.totals?.spend).toBe('1.420000');
    expect(parsed.summary?.[0]?.date).toBe('2026-10-05');
  });

  it('--json (default mode): both ranges', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runUsage(c, {}), true);
    await promise;
    const parsed = JSON.parse(cap.out.join('\n')) as {
      ok: boolean;
      ranges?: Array<{ days?: number; totals?: { requests?: string } }>;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.ranges?.map((rr) => rr.days)).toEqual([1, 7]);
    expect(parsed.ranges?.[0]?.totals?.requests).toBe('183');
    expect(parsed.ranges?.[1]?.totals?.requests).toBe('1204');
  });
});

describe('models', () => {
  it('table sorted by id with pricing, status, display names, and the 1m tag', async () => {
    installRoutes();
    const { promise, cap } = run(runModels);
    await promise;
    const text = cap.all();
    expect(text).toContain('SELORA MODELS');
    expect(text).toContain('ID');
    expect(text).toContain('PROVIDER');
    expect(text).toContain('$/M IN');
    expect(text).toContain('$/M OUT');
    expect(text).toContain('STATUS');
    // sorted by id
    const iClaude = text.indexOf('claude-haiku-4.5');
    const iGlm = text.indexOf('glm-5.3-flash');
    const iGpt = text.indexOf('gpt-5.2-mini');
    const iKimi = text.indexOf('kimi-k2');
    expect(iClaude).toBeGreaterThan(-1);
    expect(iClaude).toBeLessThan(iGlm);
    expect(iGlm).toBeLessThan(iGpt);
    expect(iGpt).toBeLessThan(iKimi);
    expect(text).toContain('glm-5.3-flash 1m');
    expect(text).toContain('$0.30');
    expect(text).toContain('$0.60');
    expect(text).toContain('inactive');
    expect(text).toContain('GLM 5.3 Flash');
    // no invented columns
    expect(text).not.toContain('CONTEXT');
    expect(text).not.toContain('VISION');
  });

  it('CRITICAL: the request carries NO authorization header (auth:none)', async () => {
    installRoutes();
    const before = server.requests.length;
    const { promise } = run(runModels);
    await promise;
    const req = server.requests.slice(before).find((r) => r.path === '/v1/models');
    expect(req).toBeDefined();
    expect(req!.headers['authorization']).toBeUndefined();
  });

  it('--json: raw decoded list', async () => {
    installRoutes();
    const { promise, cap } = run(runModels, true);
    await promise;
    const parsed = JSON.parse(cap.out.join('\n')) as {
      ok: boolean;
      models?: Array<{ id: string; pricing?: { input_per_1m: string }; supports_1m_context?: boolean }>;
    };
    expect(parsed.ok).toBe(true);
    const glm = parsed.models?.find((m) => m.id === 'glm-5.3-flash');
    expect(glm?.pricing?.input_per_1m).toBe('0.300000');
    expect(glm?.supports_1m_context).toBe(true);
  });
});

describe('model', () => {
  it('no arg: shows the display-time fallback and how to change it (nothing written)', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runModel(c, undefined, {}));
    await promise;
    expect(cap.all()).toContain('glm-5.3-flash');
    expect(cap.all()).toContain('selora model <id>');
    expect(loadConfig().defaultModel).toBeUndefined();
  });

  it('with id: renders the detail view and SAVES it as the default', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runModel(c, 'glm-5.3-flash', {}));
    await promise;
    const text = cap.all();
    expect(text).toContain('ID');
    expect(text).toContain('GLM 5.3 Flash');
    expect(text).toContain('openai');
    expect(text).toContain('$/M in');
    expect(text).toContain('$0.30');
    expect(text).toMatch(/Limits\s+—/);
    expect(text).toContain('✓ Default model set to glm-5.3-flash');
    expect(loadConfig().defaultModel).toBe('glm-5.3-flash');
  });

  it('limits render as key: value rows when present', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runModel(c, 'claude-haiku-4.5', {}));
    await promise;
    expect(cap.all()).toContain('max_output_tokens');
    expect(cap.all()).toContain('65536');
  });

  it('detail request also carries NO authorization header', async () => {
    installRoutes();
    const before = server.requests.length;
    const { promise } = run((c) => runModel(c, 'glm-5.3-flash', {}));
    await promise;
    const req = server.requests.slice(before).find((r) => r.path === '/v1/models/glm-5.3-flash');
    expect(req).toBeDefined();
    expect(req!.headers['authorization']).toBeUndefined();
  });

  it('unknown id → honest 404 from the backend ("Model not available")', async () => {
    installRoutes();
    // isolate the default-model assertion without wiping the stored key
    const cfg = loadConfig();
    delete cfg.defaultModel;
    saveConfig(cfg);
    process.exitCode = undefined;
    const { promise, cap } = run((c) => runModel(c, 'no-such-model', {}));
    await promise;
    expect(cap.all()).toContain('Model not available');
    expect(process.exitCode).toBe(1);
    expect(loadConfig().defaultModel).toBeUndefined();
  });

  it('--unset clears the stored default', async () => {
    installRoutes();
    const { promise: pSet } = run((c) => runModel(c, 'glm-5.3-flash', {}));
    await pSet;
    expect(loadConfig().defaultModel).toBe('glm-5.3-flash');
    const { promise, cap } = run((c) => runModel(c, undefined, { unset: true }));
    await promise;
    expect(cap.all()).toContain('Default model cleared');
    expect(loadConfig().defaultModel).toBeUndefined();
  });
});

describe('keys', () => {
  it('list: masked table (hint only), dates, never, request counts, revoked bullet', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runKeys(c, 'list', undefined, {}));
    await promise;
    const text = cap.all();
    expect(text).toContain('SELORA KEYS');
    expect(text).toContain('NAME');
    expect(text).toContain('…ABCD');
    expect(text).toContain('…WXYZ');
    expect(text).toContain('…DEAD');
    expect(text).toContain('laptop');
    expect(text).toContain('—');
    expect(text).toContain('2026-09-01');
    expect(text).toContain('never');
    expect(text).toContain('42');
    expect(text).toContain('revoked');
    // the full key never appears anywhere — only the 4-char hint
    expect(text).not.toContain(FAKE_KEY_USER);
  });

  it('list with no keys: honest empty state', async () => {
    server.setHandler((req) => {
      if (req.method === 'GET' && req.path === '/v1/me/keys') return { status: 200, body: KEYS_EMPTY_BODY };
      return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
    });
    const { promise, cap } = run((c) => runKeys(c, undefined, undefined, {}));
    await promise;
    expect(cap.all()).toContain('No API keys');
  });

  it('create: prints the secret EXACTLY ONCE (stdout only, never stderr)', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runKeys(c, 'create', undefined, {}));
    await promise;
    const out = cap.out.join('\n');
    const err = cap.err.join('\n');
    expect(out).toContain('✓ Key created:');
    expect(out).toContain('THIS IS THE ONLY TIME THE FULL KEY IS SHOWN');
    expect(out.split(FAKE_KEY_CREATED).length - 1).toBe(1);
    expect(err).not.toContain(FAKE_KEY_CREATED);
    expect(cap.all()).toContain('Store this secret now — it cannot be retrieved again.');
  });

  it('create --name: uses the given name; 409 → backend message + revoke hint', async () => {
    installRoutes();
    server.setHandler((req) => {
      if (req.method === 'POST' && req.path === '/v1/me/keys') return { status: 409, body: KEY_LIMIT_409 };
      return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
    });
    process.exitCode = undefined;
    const { promise, cap } = run((c) => runKeys(c, 'create', undefined, { name: 'my-key' }));
    await promise;
    const text = cap.all();
    expect(text).toContain('Key limit reached for this plan');
    expect(text).toContain('selora.lol');
    expect(text).toContain('selora keys revoke');
    expect(process.exitCode).toBe(1);
  });

  it('revoke by hint: non-TTY without --yes refuses, nothing deleted', async () => {
    installRoutes();
    const before = server.requests.length;
    process.exitCode = undefined;
    const { promise, cap } = run((c) => runKeys(c, 'revoke', 'ABCD', {}));
    await promise;
    expect(cap.all()).toContain('Refusing to revoke without confirmation');
    expect(server.requests.slice(before).some((r) => r.method === 'DELETE')).toBe(false);
  });

  it('revoke by full id with --yes: reports soft honestly', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runKeys(c, 'revoke', 'key_1', { yes: true }));
    await promise;
    expect(cap.all()).toContain('soft delete');
    const del = server.requests.find((r) => r.method === 'DELETE' && r.path === '/v1/me/keys/key_1');
    expect(del).toBeDefined();
  });

  it('revoke by …hint with --yes: hard delete reported honestly', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runKeys(c, 'revoke', '…WXYZ', { yes: true }));
    await promise;
    expect(cap.all()).toContain('hard delete');
    expect(server.requests.some((r) => r.method === 'DELETE' && r.path === '/v1/me/keys/key_2')).toBe(true);
  });

  it('revoke 404 → already-gone message', async () => {
    installRoutes();
    const { promise, cap } = run((c) => runKeys(c, 'revoke', 'GOST', { yes: true }));
    await promise;
    expect(cap.all()).toContain('already gone');
  });

  it('revoke with no matches → honest failure', async () => {
    installRoutes();
    process.exitCode = undefined;
    const { promise, cap } = run((c) => runKeys(c, 'revoke', 'ZZZZ', { yes: true }));
    await promise;
    expect(cap.all()).toContain('No key matches ZZZZ');
    expect(process.exitCode).toBe(1);
  });

  it('requires login: no stored key → standard auth error', async () => {
    installRoutes();
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = `${env.dir}-nokey`;
    process.exitCode = undefined;
    const { promise, cap } = run((c) => runKeys(c, 'list', undefined, {}));
    await promise;
    process.env['XDG_CONFIG_HOME'] = savedXdg;
    expect(cap.all()).toContain('You are not logged in. Run: selora login');
    expect(process.exitCode).toBe(1);
  });
});
