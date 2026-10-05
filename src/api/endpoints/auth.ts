/**
 * POST /v1/auth/login. The token stays in memory for the duration of the
 * login flow and is never persisted. expires_at is Unix SECONDS (number) —
 * the one non-ISO date in the API.
 */

import type { SeloraClient } from '../client.js';
import { SeloraApiError } from '../errors.js';

export interface LoginUser {
  id: string;
  email: string;
  name: string | null;
  role: string;
  status: string;
}

export interface LoginResponse {
  user: LoginUser;
  token: string;
  expires_at: number;
}

export async function login(
  client: SeloraClient,
  email: string,
  password: string,
): Promise<LoginResponse> {
  const res = await client.request<unknown>('/v1/auth/login', {
    method: 'POST',
    body: { email, password },
    auth: 'none',
  });
  // Light decode guard: an off-wire response fails honestly instead of
  // producing an unusable token downstream.
  if (typeof res !== 'object' || res === null) throw decodeFailure();
  const rec = res as Record<string, unknown>;
  const token = Object.hasOwn(rec, 'token') ? rec['token'] : undefined;
  const user = Object.hasOwn(rec, 'user') ? rec['user'] : undefined;
  const expiresAt = Object.hasOwn(rec, 'expires_at') ? rec['expires_at'] : undefined;
  if (typeof token !== 'string' || token.length === 0) throw decodeFailure();
  if (typeof user !== 'object' || user === null) throw decodeFailure();
  const u = user as Record<string, unknown>;
  const emailOf = Object.hasOwn(u, 'email') && typeof u['email'] === 'string' ? u['email'] : '';
  if (emailOf === '') throw decodeFailure();
  return {
    user: {
      id: str(u, 'id'),
      email: emailOf,
      name: nullableStr(u, 'name'),
      role: str(u, 'role'),
      status: str(u, 'status'),
    },
    token,
    expires_at: typeof expiresAt === 'number' && Number.isFinite(expiresAt) ? expiresAt : 0,
  };
}

function str(rec: Record<string, unknown>, key: string): string {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : '';
}

function nullableStr(rec: Record<string, unknown>, key: string): string | null {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : null;
}

function decodeFailure(): SeloraApiError {
  return new SeloraApiError({
    kind: 'http_error',
    message: 'Selora returned an unexpected login response.',
    hint: '(run with --debug for details)',
  });
}
