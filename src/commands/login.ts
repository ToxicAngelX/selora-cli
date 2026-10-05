/**
 * `selora login` — two paths.
 *
 * Path A (default): prompt email + password → POST /v1/auth/login (session
 * token stays in MEMORY ONLY) → POST /v1/me/keys {name: "selora-cli-<host>"}
 * authorized by that token → capture the one-time secret → validate it with
 * GET /v1/me → store it. The secret is never printed.
 *
 * Path B (--key): key from flag, hidden prompt, or piped stdin; validated
 * with GET /v1/me BEFORE storing.
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { login } from '../api/endpoints/auth.js';
import { createKey, getMe } from '../api/endpoints/me.js';
import { createPrompter, PromptClosedError } from '../auth/prompts.js';
import { suggestedKeyName } from '../auth/keyname.js';
import { keyStorePath, storeKey, storedKeySource } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { redact } from '../api/redact.js';

export interface LoginFlags {
  /** `--key` with optional value: string when given, true when bare. */
  key?: string | boolean | undefined;
}

function clientFor(ctx: CliContext, baseUrl: string, apiKey?: string): SeloraClient {
  return new SeloraClient({ baseUrl, apiKey, debug: ctx.debug, logger: ctx.io.err });
}

export async function runLogin(ctx: CliContext, flags: LoginFlags): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const prompter = createPrompter({ stdin: ctx.io.stdin, isTTY: ctx.io.isTTY, err: ctx.io.err });

  try {
    if (typeof flags.key === 'string') {
      const key = flags.key.trim();
      if (key === '') {
        r.fail('That key was not accepted by the Selora API.');
        r.bullet('--key needs a value, or run: selora login --key');
        process.exitCode = 1;
        return;
      }
      await loginWithKey(ctx, r, baseUrl, key);
      return;
    }
    if (flags.key === true) {
      // `selora login --key` with the value omitted: hidden prompt (TTY) or
      // read the key from piped stdin.
      const key = ctx.io.isTTY
        ? (await prompter.password('API key:')).trim()
        : (await prompter.text('')).trim();
      if (key === '') {
        cancelled(r);
        return;
      }
      await loginWithKey(ctx, r, baseUrl, key);
      return;
    }
    // Path A: email + password. Non-TTY stdin supplies two plain lines.
    const email = (await prompter.text('Email:')).trim();
    if (email === '') {
      cancelled(r);
      return;
    }
    const password = await prompter.password('Password:');
    if (password === '') {
      cancelled(r);
      return;
    }
    await loginWithPassword(ctx, r, baseUrl, email, password);
  } catch (err) {
    if (err instanceof PromptClosedError) {
      cancelled(r);
      return;
    }
    r.renderError(err);
  } finally {
    prompter.close();
  }
}

/** Path B: validate a caller-supplied key, then store it. */
async function loginWithKey(
  ctx: CliContext,
  r: Renderer,
  baseUrl: string,
  key: string,
): Promise<void> {
  const client = clientFor(ctx, baseUrl, key);
  let email: string;
  try {
    const me = await getMe(client);
    email = me.user.email;
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 401) {
      process.exitCode = 1;
      const hint = err.apiMessage;
      if (ctx.json) {
        r.jsonOut({
          ok: false,
          error: {
            kind: 'auth',
            message: 'That key was not accepted by the Selora API.',
            ...(hint !== undefined ? { hint: redact(hint) } : {}),
          },
        });
        return;
      }
      r.fail('That key was not accepted by the Selora API.');
      if (hint !== undefined) r.bullet(redact(hint));
      return;
    }
    throw err;
  }
  const wasEnv = storedKeySource() === 'env';
  storeKey(key);
  if (ctx.json) {
    r.jsonOut({ ok: true, email, keyValidated: true, keyStored: true });
    return;
  }
  r.ok(`Logged in as ${email}`);
  r.ok('Key validated — stored locally');
  r.bullet(`API key stored at ${keyStorePath()} (chmod 600; v0.1 has no OS keyring).`);
  if (wasEnv) {
    r.bullet('SELORA_API_KEY is set in your environment — it still overrides the stored key.');
  }
}

/** Path A: full email + password flow. */
async function loginWithPassword(
  ctx: CliContext,
  r: Renderer,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  const unauthClient = clientFor(ctx, baseUrl);
  let loginRes;
  try {
    loginRes = await login(unauthClient, email, password);
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 401) {
      // Backend cannot distinguish wrong password from Google-only account.
      throw new SeloraApiError({
        kind: 'auth',
        message: 'Login failed: Invalid email or password.',
        hint: 'If your account uses Google sign-in, create a key at selora.lol → Keys, then run: selora login --key',
        status: 401,
      });
    }
    if (err instanceof SeloraApiError && err.status === 403) {
      throw new SeloraApiError({
        kind: 'http_error',
        message: err.apiMessage ?? 'Login failed: your account is not active.',
        status: 403,
      });
    }
    if (err instanceof SeloraApiError && err.status === 429) {
      throw new SeloraApiError({
        kind: 'rate_limited',
        message: err.apiMessage ?? err.message,
        hint:
          err.retryAfterSeconds !== undefined
            ? `Wait ${err.retryAfterSeconds}s before trying again.`
            : 'Try again in a moment.',
        status: 429,
      });
    }
    throw err;
  }

  // Create a dedicated CLI key, authorized by the in-memory session token.
  const name = suggestedKeyName();
  const tokenClient = clientFor(ctx, baseUrl);
  let created;
  try {
    created = await createKey(tokenClient, name, { token: loginRes.token });
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 409) {
      throw new SeloraApiError({
        kind: 'http_error',
        message: err.apiMessage ?? 'Key limit reached.',
        hint: 'Revoke an old key at selora.lol → Keys, then run: selora login again.',
        status: 409,
      });
    }
    throw err;
  }
  const secret = created.secret;
  if (secret === '') {
    throw new SeloraApiError({
      kind: 'http_error',
      message: 'Selora did not return the new key secret.',
    });
  }

  // Confirm the secret works before storing it.
  const keyClient = clientFor(ctx, baseUrl, secret);
  const me = await getMe(keyClient);
  const confirmedEmail = me.user.email !== '' ? me.user.email : loginRes.user.email;

  storeKey(secret);
  if (ctx.json) {
    r.jsonOut({ ok: true, email: confirmedEmail, keyName: name, keyStored: true });
    return;
  }
  r.ok(`Logged in as ${confirmedEmail}`);
  r.ok(`CLI key created: ${name}`);
  r.bullet(
    `API key stored at ${keyStorePath()} (chmod 600; v0.1 has no OS keyring). It is shown once and never printed again.`,
  );
  r.bullet('Your session token was used in memory only — nothing else was written to disk.');
}

function cancelled(r: Renderer): void {
  if (r.json) {
    r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Cancelled.' } });
  } else {
    r.fail('Cancelled.');
  }
  process.exitCode = 1;
}
