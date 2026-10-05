/**
 * /v1/me family — typed wrappers decoded defensively (Object.hasOwn guards +
 * fallbacks) because the shape is large and open-ended. Money on this family
 * is decimal strings EXCEPT plan.*, which the gateway emits as numbers.
 */

import type { SeloraClient } from '../client.js';

export interface MeUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
  plan_id: string | null;
  referral_code: string | null;
  telegram_handle: string | null;
  telegram_verified: boolean;
  telegram_channel_joined: boolean;
  trial_activated_at: string | null;
  trial_until: string | null;
  trial_expired: boolean;
  created_at: string | null;
}

export interface MePlan {
  id: string;
  name: string;
  tagline: string;
  monthlyPrice: number;
  upfront: boolean;
  window4hUsd: number;
  windowWeeklyUsd: number;
  credits: number;
  rateLimitRpm: number;
  concurrent: number;
  keyLimit: number;
  models: string;
  tier: string;
  features: string[];
  highlight: boolean;
  ctaLabel: string;
}

export interface PlanTerm {
  kind: 'paid' | 'trial';
  plan_name: string | null;
  started_at: string;
  ends_at: string | null;
}

export interface Wallet {
  balance: string;
  credit_balance: string;
  holds: string;
  available: string;
  credits_expires_at: string | null;
}

export interface CreditSplit {
  plan_allowance: string;
  pay_per_use: string;
}

export interface MeResponse {
  user: MeUser;
  plan: MePlan | null;
  plan_term: PlanTerm | null;
  credit_split: CreditSplit | null;
  wallet: Wallet | null;
}

export interface SpendWindow {
  usedUsd: string;
  limitUsd: string;
  remainingUsd: string;
  startedAt: string;
  resetsAt: string;
  resetsInMs: number;
  requests: number;
  enforced: boolean;
  exhausted: boolean;
  unlimited: boolean;
}

export interface WindowsResponse {
  session: SpendWindow;
  week: SpendWindow;
}

export interface UsageDay {
  date: string;
  total_requests: string;
  total_input_tokens: string;
  total_output_tokens: string;
  total_spend: string;
}

export interface UsageByModel {
  model_id: string;
  requests: number;
  spend: string;
}

export interface UsageResponse {
  summary: UsageDay[];
  by_model: UsageByModel[];
  recent: unknown[];
}

export interface ApiKey {
  id: string;
  name: string | null;
  key_hint: string;
  status: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | undefined;
  model_ids: string[];
  rate_limit_rpm: number | null;
  emoji: string | null;
  color: string | null;
  request_count: number;
}

export interface KeysResponse {
  keys: ApiKey[];
}

export interface CreateKeyResponse {
  api_key: ApiKey;
  secret: string;
  /** Backend one-time-secret warning, passed through when present. */
  note: string;
}

export interface DeleteKeyResponse {
  ok: boolean;
  id: string;
  deleted: boolean;
  deletion: 'hard' | 'soft';
}

function str(rec: Record<string, unknown>, key: string, fallback = ''): string {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : fallback;
}

function nullableStr(rec: Record<string, unknown>, key: string): string | null {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : null;
}

function bool(rec: Record<string, unknown>, key: string): boolean {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return v === true;
}

function num(rec: Record<string, unknown>, key: string): number {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function strArray(rec: Record<string, unknown>, key: string): string[] {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

export async function getMe(client: SeloraClient): Promise<MeResponse> {
  const res = await client.request<unknown>('/v1/me', { auth: 'key' });
  const root = rec(res);
  if (root === null) return emptyMe();
  const user = rec(Object.hasOwn(root, 'user') ? root['user'] : undefined);
  if (user === null) return emptyMe();
  const planRec = rec(Object.hasOwn(root, 'plan') ? root['plan'] : undefined);
  const termRec = rec(Object.hasOwn(root, 'plan_term') ? root['plan_term'] : undefined);
  const splitRec = rec(Object.hasOwn(root, 'credit_split') ? root['credit_split'] : undefined);
  const walletRec = rec(Object.hasOwn(root, 'wallet') ? root['wallet'] : undefined);
  return {
    user: {
      id: str(user, 'id'),
      email: str(user, 'email'),
      name: nullableStr(user, 'name'),
      role: str(user, 'role'),
      status: str(user, 'status'),
      plan_id: nullableStr(user, 'plan_id'),
      referral_code: nullableStr(user, 'referral_code'),
      telegram_handle: nullableStr(user, 'telegram_handle'),
      telegram_verified: bool(user, 'telegram_verified'),
      telegram_channel_joined: bool(user, 'telegram_channel_joined'),
      trial_activated_at: nullableStr(user, 'trial_activated_at'),
      trial_until: nullableStr(user, 'trial_until'),
      trial_expired: bool(user, 'trial_expired'),
      created_at: nullableStr(user, 'created_at'),
    },
    plan:
      planRec === null
        ? null
        : {
            id: str(planRec, 'id'),
            name: str(planRec, 'name'),
            tagline: str(planRec, 'tagline'),
            monthlyPrice: num(planRec, 'monthlyPrice'),
            upfront: bool(planRec, 'upfront'),
            window4hUsd: num(planRec, 'window4hUsd'),
            windowWeeklyUsd: num(planRec, 'windowWeeklyUsd'),
            credits: num(planRec, 'credits'),
            rateLimitRpm: num(planRec, 'rateLimitRpm'),
            concurrent: num(planRec, 'concurrent'),
            keyLimit: num(planRec, 'keyLimit'),
            models: str(planRec, 'models'),
            tier: str(planRec, 'tier'),
            features: strArray(planRec, 'features'),
            highlight: bool(planRec, 'highlight'),
            ctaLabel: str(planRec, 'ctaLabel'),
          },
    plan_term:
      termRec === null
        ? null
        : {
            kind: str(termRec, 'kind') === 'trial' ? 'trial' : 'paid',
            plan_name: nullableStr(termRec, 'plan_name'),
            started_at: str(termRec, 'started_at'),
            ends_at: nullableStr(termRec, 'ends_at'),
          },
    credit_split:
      splitRec === null
        ? null
        : {
            plan_allowance: str(splitRec, 'plan_allowance'),
            pay_per_use: str(splitRec, 'pay_per_use'),
          },
    wallet:
      walletRec === null
        ? null
        : {
            balance: str(walletRec, 'balance'),
            credit_balance: str(walletRec, 'credit_balance'),
            holds: str(walletRec, 'holds'),
            available: str(walletRec, 'available'),
            credits_expires_at: nullableStr(walletRec, 'credits_expires_at'),
          },
  };
}

function emptyMe(): MeResponse {
  return {
    user: {
      id: '',
      email: '',
      name: null,
      role: '',
      status: '',
      plan_id: null,
      referral_code: null,
      telegram_handle: null,
      telegram_verified: false,
      telegram_channel_joined: false,
      trial_activated_at: null,
      trial_until: null,
      trial_expired: false,
      created_at: null,
    },
    plan: null,
    plan_term: null,
    credit_split: null,
    wallet: null,
  };
}

export async function getBalance(client: SeloraClient): Promise<Wallet | null> {
  const res = await client.request<unknown>('/v1/me/balance', { auth: 'key' });
  const root = rec(res);
  if (root === null) return null;
  const w = rec(Object.hasOwn(root, 'wallet') ? root['wallet'] : undefined);
  if (w === null) return null;
  return {
    balance: str(w, 'balance'),
    credit_balance: str(w, 'credit_balance'),
    holds: str(w, 'holds'),
    available: str(w, 'available'),
    credits_expires_at: nullableStr(w, 'credits_expires_at'),
  };
}

function decodeWindow(v: unknown): SpendWindow {
  const w = rec(v);
  if (w === null) {
    return {
      usedUsd: '',
      limitUsd: '',
      remainingUsd: '',
      startedAt: '',
      resetsAt: '',
      resetsInMs: 0,
      requests: 0,
      enforced: false,
      exhausted: false,
      unlimited: false,
    };
  }
  return {
    usedUsd: str(w, 'usedUsd'),
    limitUsd: str(w, 'limitUsd'),
    remainingUsd: str(w, 'remainingUsd'),
    startedAt: str(w, 'startedAt'),
    resetsAt: str(w, 'resetsAt'),
    resetsInMs: num(w, 'resetsInMs'),
    requests: num(w, 'requests'),
    enforced: bool(w, 'enforced'),
    exhausted: bool(w, 'exhausted'),
    unlimited: bool(w, 'unlimited'),
  };
}

export async function getWindows(client: SeloraClient): Promise<WindowsResponse> {
  const res = await client.request<unknown>('/v1/me/windows', { auth: 'key' });
  const root = rec(res);
  return {
    session: decodeWindow(root === null ? undefined : root['session']),
    week: decodeWindow(root === null ? undefined : root['week']),
  };
}

export async function getUsage(client: SeloraClient, days = 30): Promise<UsageResponse> {
  const res = await client.request<unknown>(`/v1/me/usage?days=${days}`, { auth: 'key' });
  const root = rec(res);
  const summaryRaw = root === null ? undefined : root['summary'];
  const byModelRaw = root === null ? undefined : root['by_model'];
  const recentRaw = root === null ? undefined : root['recent'];
  const summary: UsageDay[] = Array.isArray(summaryRaw)
    ? summaryRaw
        .map((row) => {
          const r = rec(row);
          if (r === null) return null;
          return {
            date: str(r, 'date'),
            total_requests: str(r, 'total_requests'),
            total_input_tokens: str(r, 'total_input_tokens'),
            total_output_tokens: str(r, 'total_output_tokens'),
            total_spend: str(r, 'total_spend'),
          };
        })
        .filter((x): x is UsageDay => x !== null)
    : [];
  const by_model: UsageByModel[] = Array.isArray(byModelRaw)
    ? byModelRaw
        .map((row) => {
          const r = rec(row);
          if (r === null) return null;
          return { model_id: str(r, 'model_id'), requests: num(r, 'requests'), spend: str(r, 'spend') };
        })
        .filter((x): x is UsageByModel => x !== null)
    : [];
  return { summary, by_model, recent: Array.isArray(recentRaw) ? recentRaw : [] };
}

export async function listKeys(client: SeloraClient): Promise<ApiKey[]> {
  const res = await client.request<unknown>('/v1/me/keys', { auth: 'key' });
  const root = rec(res);
  const keysRaw = root === null ? undefined : root['keys'];
  if (!Array.isArray(keysRaw)) return [];
  return keysRaw
    .map((row) => {
      const r = rec(row);
      if (r === null) return null;
      return {
        id: str(r, 'id'),
        name: nullableStr(r, 'name'),
        key_hint: str(r, 'key_hint'),
        status: str(r, 'status'),
        created_at: str(r, 'created_at'),
        last_used_at: nullableStr(r, 'last_used_at'),
        revoked_at: nullableStr(r, 'revoked_at') ?? undefined,
        model_ids: strArray(r, 'model_ids'),
        rate_limit_rpm:
          Object.hasOwn(r, 'rate_limit_rpm') && typeof r['rate_limit_rpm'] === 'number'
            ? r['rate_limit_rpm']
            : null,
        emoji: nullableStr(r, 'emoji'),
        color: nullableStr(r, 'color'),
        request_count: num(r, 'request_count'),
      };
    })
    .filter((x): x is ApiKey => x !== null);
}

export async function createKey(
  client: SeloraClient,
  name: string,
  auth: { token?: string | undefined } = {},
): Promise<CreateKeyResponse> {
  const res = await client.request<unknown>('/v1/me/keys', {
    method: 'POST',
    body: { name },
    auth: auth.token !== undefined ? 'token' : 'key',
    token: auth.token,
  });
  const root = rec(res);
  const apiKey = rec(root === null ? undefined : root['api_key']);
  const secret = root === null ? undefined : root['secret'];
  const note = root === null ? undefined : root['note'];
  return {
    api_key:
      apiKey === null
        ? {
            id: '',
            name: null,
            key_hint: '',
            status: '',
            created_at: '',
            last_used_at: null,
            revoked_at: undefined,
            model_ids: [],
            rate_limit_rpm: null,
            emoji: null,
            color: null,
            request_count: 0,
          }
        : {
            id: str(apiKey, 'id'),
            name: nullableStr(apiKey, 'name'),
            key_hint: str(apiKey, 'key_hint'),
            status: str(apiKey, 'status'),
            created_at: str(apiKey, 'created_at'),
            last_used_at: nullableStr(apiKey, 'last_used_at'),
            revoked_at: nullableStr(apiKey, 'revoked_at') ?? undefined,
            model_ids: strArray(apiKey, 'model_ids'),
            rate_limit_rpm:
              Object.hasOwn(apiKey, 'rate_limit_rpm') && typeof apiKey['rate_limit_rpm'] === 'number'
                ? apiKey['rate_limit_rpm']
                : null,
            emoji: nullableStr(apiKey, 'emoji'),
            color: nullableStr(apiKey, 'color'),
            request_count: num(apiKey, 'request_count'),
          },
    secret: typeof secret === 'string' ? secret : '',
    note: typeof note === 'string' ? note : 'Store this secret now — it cannot be retrieved again.',
  };
}

export async function deleteKey(
  client: SeloraClient,
  id: string,
): Promise<DeleteKeyResponse> {
  const res = await client.request<unknown>(`/v1/me/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    auth: 'key',
  });
  const root = rec(res);
  return {
    ok: root !== null && bool(root, 'ok'),
    id: root === null ? id : str(root, 'id', id),
    deleted: root === null ? false : bool(root, 'deleted'),
    deletion: root !== null && str(root, 'deletion') === 'soft' ? 'soft' : 'hard',
  };
}
