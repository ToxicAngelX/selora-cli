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

// ---------------------------------------------------------------------------
// Phase 2: balance / windows / usage / models fixtures — all shaped EXACTLY
// per the wire reference (scale-6 decimal money strings, STRING numerics in
// usage summaries, ISO dates, resetsInMs in ms).
// ---------------------------------------------------------------------------

export const BALANCE_BODY = JSON.stringify({
  wallet: {
    balance: '42.180000',
    credit_balance: '4.970000',
    holds: '0.000000',
    available: '42.180000',
    credits_expires_at: null,
  },
});

/** session: $8.20 left of $10.00, resets in exactly 1h 12m (4_320_000 ms). */
export const WINDOWS_BODY = JSON.stringify({
  session: {
    usedUsd: '1.800000',
    limitUsd: '10.000000',
    remainingUsd: '8.200000',
    startedAt: '2026-10-05T10:00:00Z',
    resetsAt: '2026-10-05T14:00:00Z',
    resetsInMs: 4_320_000,
    requests: 12,
    enforced: true,
    exhausted: false,
    unlimited: false,
  },
  week: {
    usedUsd: '13.000000',
    limitUsd: '60.000000',
    remainingUsd: '47.000000',
    startedAt: '2026-09-29T00:00:00Z',
    resetsAt: '2026-10-06T00:00:00Z',
    resetsInMs: 86_400_000,
    requests: 1204,
    enforced: true,
    exhausted: false,
    unlimited: false,
  },
});

export const WINDOWS_BODY_EXHAUSTED = JSON.stringify({
  session: {
    usedUsd: '10.000000',
    limitUsd: '10.000000',
    remainingUsd: '0.000000',
    startedAt: '2026-10-05T10:00:00Z',
    resetsAt: '2026-10-05T14:00:00Z',
    resetsInMs: 4_320_000,
    requests: 57,
    enforced: true,
    exhausted: true,
    unlimited: false,
  },
  week: {
    usedUsd: '13.000000',
    limitUsd: '60.000000',
    remainingUsd: '47.000000',
    startedAt: '2026-09-29T00:00:00Z',
    resetsAt: '2026-10-06T00:00:00Z',
    resetsInMs: 86_400_000,
    requests: 1204,
    enforced: true,
    exhausted: false,
    unlimited: false,
  },
});

/**
 * Daily summary rows per days window. Multi-row bodies exercise the BigInt
 * summation; numerics are STRINGS on the wire. by_model is ALL-TIME data
 * (spend deliberately far from the period totals — the CLI must never mix
 * it in).
 */
const USAGE_ROWS: Record<number, Array<Record<string, string>>> = {
  1: [
    { date: '2026-10-05', total_requests: '183', total_input_tokens: '2800000', total_output_tokens: '1100000', total_spend: '1.420000' },
  ],
  7: [
    { date: '2026-10-05', total_requests: '204', total_input_tokens: '3100000', total_output_tokens: '1200000', total_spend: '1.600000' },
    { date: '2026-10-04', total_requests: '1000', total_input_tokens: '15000000', total_output_tokens: '6000000', total_spend: '7.500000' },
  ],
  30: [
    { date: '2026-10-05', total_requests: '204', total_input_tokens: '3100000', total_output_tokens: '1200000', total_spend: '1.600000' },
    { date: '2026-10-04', total_requests: '1000', total_input_tokens: '15000000', total_output_tokens: '6000000', total_spend: '7.500000' },
    { date: '2026-09-28', total_requests: '100', total_input_tokens: '2000000', total_output_tokens: '500000', total_spend: '0.800000' },
  ],
};

export const USAGE_BY_MODEL = [
  { model_id: 'glm-5.3-flash', requests: 5210, spend: '40.120000' },
  { model_id: 'gpt-5.2-mini', requests: 931, spend: '3.050000' },
];

export function usageBody(days: number): string {
  const rows = USAGE_ROWS[days] ?? [];
  return JSON.stringify({ summary: rows, by_model: USAGE_BY_MODEL, recent: [] });
}

export const USAGE_EMPTY_BODY = JSON.stringify({ summary: [], by_model: [], recent: [] });

/** Internal flavor: the ONLY one that carries pricing (no auth header sent). */
export const MODELS_BODY = JSON.stringify({
  models: [
    {
      id: 'claude-haiku-4.5',
      provider: 'anthropic',
      status: 'active',
      pricing: { input_per_1m: '1.000000', output_per_1m: '5.000000' },
      display_name: 'Claude Haiku 4.5',
    },
    {
      id: 'glm-5.3-flash',
      provider: 'openai',
      status: 'active',
      pricing: { input_per_1m: '0.300000', output_per_1m: '0.600000' },
      display_name: 'GLM 5.3 Flash',
      supports_1m_context: true,
    },
    {
      id: 'gpt-5.2-mini',
      provider: 'openai',
      status: 'active',
      pricing: { input_per_1m: '0.400000', output_per_1m: '1.600000' },
      display_name: 'GPT 5.2 Mini',
    },
    {
      id: 'kimi-k2',
      provider: 'openai',
      status: 'inactive',
      pricing: { input_per_1m: '0.600000', output_per_1m: '2.500000' },
      display_name: 'Kimi K2',
    },
  ],
});

/** Detail flavor: limits is raw JSONB ({} on the real gateway). */
export function modelDetailBody(id: string, limits: Record<string, unknown> = {}): string {
  const known: Record<string, { provider: string; status: string; input: string; output: string; display_name: string }> = {
    'glm-5.3-flash': { provider: 'openai', status: 'active', input: '0.300000', output: '0.600000', display_name: 'GLM 5.3 Flash' },
    'claude-haiku-4.5': { provider: 'anthropic', status: 'active', input: '1.000000', output: '5.000000', display_name: 'Claude Haiku 4.5' },
  };
  const m = known[id];
  return JSON.stringify({
    model: {
      id,
      provider: m?.provider ?? 'openai',
      status: m?.status ?? 'active',
      pricing: { input_per_1m: m?.input ?? '0.300000', output_per_1m: m?.output ?? '0.600000' },
      limits,
      metadata: {},
      display_name: m?.display_name ?? id,
    },
  });
}

export const MODEL_NOT_FOUND_404 = JSON.stringify({
  error: { code: 'not_found', message: 'Model not available', request_id: 'req_model_404' },
});

/** Keys list with a named key, an unnamed key, a revoked key, and a ghost (404 on delete). */
export const KEYS_LIST_BODY = JSON.stringify({
  keys: [
    {
      id: 'key_1',
      name: 'laptop',
      key_hint: 'ABCD',
      status: 'active',
      created_at: '2026-09-01T00:00:00Z',
      last_used_at: '2026-10-04T00:00:00Z',
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: 42,
    },
    {
      id: 'key_2',
      name: null,
      key_hint: 'WXYZ',
      status: 'active',
      created_at: '2026-09-02T00:00:00Z',
      last_used_at: null,
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: 0,
    },
    {
      id: 'key_3',
      name: 'old-laptop',
      key_hint: 'DEAD',
      status: 'revoked',
      created_at: '2026-08-01T00:00:00Z',
      last_used_at: '2026-08-20T00:00:00Z',
      revoked_at: '2026-09-10T00:00:00Z',
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: 7,
    },
    {
      id: 'key_4',
      name: 'ghost',
      key_hint: 'GOST',
      status: 'active',
      created_at: '2026-09-03T00:00:00Z',
      last_used_at: '2026-09-30T00:00:00Z',
      model_ids: [],
      rate_limit_rpm: null,
      emoji: null,
      color: null,
      request_count: 3,
    },
  ],
});

export const KEYS_EMPTY_BODY = JSON.stringify({ keys: [] });

export const DELETE_KEY_SOFT = DELETE_KEY_OK;
export const DELETE_KEY_HARD = JSON.stringify({ ok: true, id: 'key_2', deleted: true, deletion: 'hard' });

// ---------------------------------------------------------------------------
// Phase 3: chat streaming fixtures — shaped EXACTLY per the wire reference:
// role-only first chunk, delta chunks, finish chunk, usage chunk (choices: []
// + usage + gateway.charge decimal string), raw [DONE] sentinel, and
// `: keep-alive` comments.
// ---------------------------------------------------------------------------

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

const CHAT_ROLE_CHUNK = {
  id: 'chatcmpl_test',
  object: 'chat.completion.chunk',
  model: 'glm-5.3-flash',
  choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
};

/**
 * Full realistic stream: role chunk → keep-alive comment → one
 * reasoning_content delta → 2 content deltas → finish chunk → usage chunk
 * {prompt 4821, completion 1234, total 6055} + gateway {charge "0.018234",
 * request_id} → [DONE]. Reply text: "Hello, world!".
 */
export const CHAT_STREAM_FULL: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  ': keep-alive\n\n',
  sseData({ choices: [{ index: 0, delta: { reasoning_content: '(thinking about it)' }, finish_reason: null }] }),
  sseData({ choices: [{ index: 0, delta: { content: 'Hello, ' }, finish_reason: null }] }),
  sseData({ choices: [{ index: 0, delta: { content: 'world!' }, finish_reason: null }] }),
  sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  sseData({
    choices: [],
    usage: { prompt_tokens: 4821, completion_tokens: 1234, total_tokens: 6055 },
    gateway: { charge: '0.018234', request_id: 'req_chat_full' },
  }),
  'data: [DONE]\n\n',
];

/**
 * Same event sequence, but one content event is split mid-JSON across two
 * frames — the client parser must buffer across writes.
 */
export const CHAT_STREAM_SPLIT: string[] = (() => {
  const f = CHAT_STREAM_FULL;
  const target = f[3]!;
  const cut = Math.floor(target.length / 2);
  return [f[0]!, f[1]!, f[2]!, target.slice(0, cut), target.slice(cut), f[4]!, f[5]!, f[6]!, f[7]!];
})();

/** include_usage:false wire shape: a single finish chunk carrying only gateway. No footer. */
export const CHAT_STREAM_NO_USAGE: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  sseData({ choices: [{ index: 0, delta: { content: 'No footer for this one.' }, finish_reason: null }] }),
  sseData({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    gateway: { charge: '0.001000', request_id: 'req_chat_no_usage' },
  }),
  'data: [DONE]\n\n',
];

/** In-band error (headers already sent): a 402 window-exhausted message as a data event. */
export const CHAT_STREAM_INBAND_ERROR: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  sseData({ choices: [{ index: 0, delta: { content: 'partial ' }, finish_reason: null }] }),
  sseData({
    error: {
      code: 'insufficient_balance',
      message:
        'Your 4h plan usage limit is reached and your API credit balance is empty. Top up API credits to continue pay-as-you-go, or wait for the window to reset. Plan usage resumes at 2026-10-05T14:00:00Z.',
      request_id: 'req_chat_inband',
    },
  }),
];

/** Second-turn reply with different numbers (footer: Tokens: 150 · Cost: $0.001). */
export const CHAT_STREAM_SECOND: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  sseData({ choices: [{ index: 0, delta: { content: 'Second reply, ' }, finish_reason: null }] }),
  sseData({ choices: [{ index: 0, delta: { content: 'after the switch.' }, finish_reason: null }] }),
  sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  sseData({
    choices: [],
    usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
    gateway: { charge: '0.001000', request_id: 'req_chat_second' },
  }),
  'data: [DONE]\n\n',
];

/** Stream that emits one delta then hangs open (abort tests — pair with sseHang: true). */
export const CHAT_STREAM_HANG: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  sseData({ choices: [{ index: 0, delta: { content: 'Star' }, finish_reason: null }] }),
];

/**
 * Tool-call stream: content delta → a delta carrying `tool_calls` → finish
 * chunk with finish_reason 'tool_calls' → usage chunk → [DONE]. Exercises the
 * run command's REAL wire-based tool detection (never prompt-text guessing).
 * Usage {prompt 200, completion 40, total 240}, charge "0.002000".
 */
export const CHAT_STREAM_TOOL_CALLS: string[] = [
  sseData(CHAT_ROLE_CHUNK),
  sseData({ choices: [{ index: 0, delta: { content: 'I would read a file for that.' }, finish_reason: null }] }),
  sseData({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_TEST1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/index.ts"}' },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  }),
  sseData({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
  sseData({
    choices: [],
    usage: { prompt_tokens: 200, completion_tokens: 40, total_tokens: 240 },
    gateway: { charge: '0.002000', request_id: 'req_chat_tools' },
  }),
  'data: [DONE]\n\n',
];

/** Pre-stream 402: window exhausted, reset time ONLY inside the message text. */
export const WINDOW_EXHAUSTED_402 = JSON.stringify({
  error: {
    code: 'insufficient_balance',
    message:
      'Your 4h plan usage limit is reached and your API credit balance is empty. Top up API credits to continue pay-as-you-go, or wait for the window to reset. Plan usage resumes at 2026-10-05T14:00:00Z.',
    request_id: 'req_chat_402',
  },
});

/** Non-streaming 2xx fallback: a plain JSON completion with no event-stream content-type. */
export const CHAT_COMPLETION_NONSTREAM = JSON.stringify({
  id: 'chatcmpl_nonstream',
  object: 'chat.completion',
  created: 1760000000,
  model: 'glm-5.3-flash',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Plain completion reply.' },
      finish_reason: 'stop',
    },
  ],
  usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
  gateway: { charge: '0.000500', request_id: 'req_chat_nonstream' },
});
