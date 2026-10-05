/**
 * Canned wire fixtures matching the Selora wire reference EXACTLY (scale-6
 * decimal money strings, ISO dates, login expires_at as unix seconds).
 * FAKE keys/JWT only — everything starts with sk-gw-TEST / testsession.TEST,
 * which the no-leak test whitelists.
 */

export const FAKE_JWT = 'testsession.TESTfakejwt0000000000000000000000';

export const EMAIL = 'user@test.example';
export const NAME = 'Test User';

export const LOGIN_SUCCESS = JSON.stringify({
  user: {
    id: 'usr_1',
    email: EMAIL,
    name: NAME,
    role: 'user',
    status: 'active',
  },
  token: FAKE_JWT,
  expires_at: Math.floor(Date.now() / 1000) + 12 * 3600,
});

export const LOGIN_FAIL = JSON.stringify({
  error: { code: 'unauthorized', message: 'Invalid email or password', request_id: 'req_login_fail' },
});

/** The one-time secret returned by POST /v1/me/keys (43 url-safe chars). */
export const FAKE_KEY_CREATED = `sk-gw-TEST${'A'.repeat(43)}`;
/** A pre-existing key supplied by the user (login --key). */
export const FAKE_KEY_USER = `sk-gw-TEST${'B'.repeat(43)}`;
export const FAKE_KEY_INVALID = `sk-gw-TEST${'C'.repeat(43)}`;
export const FAKE_KEY_REVOKED = `sk-gw-TEST${'D'.repeat(43)}`;

export const ME_BODY = JSON.stringify({
  user: {
    id: 'usr_1',
    email: EMAIL,
    name: NAME,
    role: 'user',
    status: 'active',
    plan_id: 'plan_nova',
    referral_code: 'ABC123',
    telegram_handle: '@tester',
    telegram_verified: true,
    telegram_channel_joined: true,
    trial_activated_at: '2026-09-01T00:00:00Z',
    trial_until: '2026-10-01T00:00:00Z',
    trial_expired: true,
    created_at: '2026-09-01T00:00:00Z',
  },
  plan: {
    id: 'plan_nova',
    name: 'Nova',
    tagline: 'Starter plan',
    monthlyPrice: 5,
    upfront: false,
    window4hUsd: 5,
    windowWeeklyUsd: 30,
    credits: 5,
    rateLimitRpm: 60,
    concurrent: 2,
    keyLimit: 3,
    models: 'all',
    tier: 'nova',
    features: ['chat'],
    ctaLabel: 'Start',
  },
  plan_term: {
    kind: 'paid',
    plan_name: 'Nova',
    started_at: '2026-09-16T12:00:00Z',
    ends_at: '2026-10-16T12:00:00Z',
  },
  credit_split: { plan_allowance: '4.970000', pay_per_use: '0.000000' },
  wallet: {
    balance: '42.180000',
    credit_balance: '4.970000',
    holds: '0.000000',
    available: '42.180000',
    credits_expires_at: null,
  },
});

export const ME_BODY_TRIAL = JSON.stringify({
  user: {
    id: 'usr_2',
    email: 'trial@test.example',
    name: null,
    role: 'user',
    status: 'active',
    plan_id: null,
    referral_code: null,
    telegram_handle: null,
    telegram_verified: false,
    telegram_channel_joined: false,
    trial_activated_at: '2026-09-20T00:00:00Z',
    trial_until: '2026-10-20T00:00:00Z',
    trial_expired: false,
    created_at: '2026-09-20T00:00:00Z',
  },
  plan: null,
  plan_term: { kind: 'trial', plan_name: null, started_at: '2026-09-20T00:00:00Z', ends_at: null },
  credit_split: { plan_allowance: '0.250000', pay_per_use: '0.000000' },
  wallet: {
    balance: '0.000000',
    credit_balance: '0.250000',
    holds: '0.000000',
    available: '0.000000',
    credits_expires_at: '2026-09-24T00:00:00Z',
  },
});

export function keysBody(hints: string[]): string {
  return JSON.stringify({
    keys: hints.map((h, i) => ({
      id: `key_${i + 1}`,
      name: `Key ${i + 1}`,
      key_hint: h,
      status: 'active',
      created_at: '2026-09-01T00:00:00Z',
      last_used_at: null,
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: i,
    })),
  });
}

export function createKeyBody(secret: string): string {
  return JSON.stringify({
    api_key: {
      id: 'key_new',
      name: 'selora-cli-testhost',
      key_hint: secret.slice(-4),
      status: 'active',
      created_at: '2026-10-05T00:00:00Z',
      last_used_at: null,
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: 0,
    },
    secret,
    note: 'Store this secret now — it cannot be retrieved again.',
  });
}

export const KEY_LIMIT_409 = JSON.stringify({
  error: { code: 'key_limit_reached', message: 'Key limit reached for this plan', request_id: 'req_409' },
});

export const KEY_NOT_FOUND_404 = JSON.stringify({
  error: { code: 'not_found', message: 'API key not found', request_id: 'req_404' },
});

export const DELETE_KEY_OK = JSON.stringify({ ok: true, id: 'key_1', deleted: true, deletion: 'soft' });

export const RATE_LIMIT_429 = JSON.stringify({
  error: {
    code: 'rate_limited',
    message: 'Rate limit exceeded. Retry in 1s.',
    retryable: true,
    retry_after_seconds: 1,
    request_id: 'req_429',
  },
});

export const REVOKED_KEY_401 = JSON.stringify({
  error: {
    code: 'api_key_revoked',
    message:
      'This API key was revoked on 2026-10-01. If you rotated it, your client is still sending the OLD key — update the key everywhere it is configured, then fully restart the app.',
    request_id: 'req_revoked',
  },
});

export const INVALID_KEY_401 = JSON.stringify({
  error: { code: 'unauthorized', message: 'Invalid API key', request_id: 'req_invalid' },
});

export const INTERNAL_500 = JSON.stringify({
  error: { code: 'internal_error', message: 'Unexpected gateway error', request_id: 'req_500' },
});

export const last4 = (key: string): string => key.slice(-4);
