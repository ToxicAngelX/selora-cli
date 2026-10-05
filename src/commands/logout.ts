/**
 * `selora logout` — clears the locally stored key. With --revoke, also
 * deletes the server-side key whose key_hint matches the stored key's LAST 4
 * CHARS (honest match: zero or multiple matches → nothing revoked, local
 * key still cleared). Non-TTY revocation requires --yes.
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { deleteKey, listKeys, type ApiKey } from '../api/endpoints/me.js';
import { createPrompter, PromptClosedError } from '../auth/prompts.js';
import { clearStoredKey, getStoredKey, storedKeySource } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';

export interface LogoutFlags {
  revoke?: boolean | undefined;
  yes?: boolean | undefined;
}

export async function runLogout(ctx: CliContext, flags: LogoutFlags): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const key = getStoredKey();
  const source = storedKeySource();

  if (key === undefined) {
    if (ctx.json) {
      r.jsonOut({ ok: true, loggedOut: false, note: 'No stored API key.' });
    } else {
      r.bullet('No stored API key — nothing to log out.');
    }
    return;
  }

  if (flags.revoke === true) {
    await logoutWithRevoke(ctx, r, baseUrl, key, flags.yes === true);
    return;
  }

  clearStoredKey();
  if (ctx.json) {
    r.jsonOut({ ok: true, loggedOut: true, revoked: false });
    return;
  }
  r.ok('Logged out');
  if (source === 'env') {
    r.bullet('SELORA_API_KEY is set in your environment — it still overrides stored keys.');
  }
}

async function logoutWithRevoke(
  ctx: CliContext,
  r: Renderer,
  baseUrl: string,
  key: string,
  yes: boolean,
): Promise<void> {
  const last4 = key.slice(-4);

  // Confirmation: TTY → y/N prompt (unless --yes); non-TTY → require --yes.
  if (!yes) {
    if (!ctx.io.isTTY) {
      const err = new SeloraApiError({
        kind: 'http_error',
        message: 'Refusing to revoke without confirmation.',
        hint: 'Re-run with --yes to revoke non-interactively.',
      });
      r.renderError(err);
      return;
    }
    const prompter = createPrompter({ stdin: ctx.io.stdin, isTTY: ctx.io.isTTY, err: ctx.io.err });
    try {
      const confirmed = await prompter.confirm(
        `Revoke the server key ending …${last4}? This cannot be undone.`,
      );
      prompter.close();
      if (!confirmed) {
        if (ctx.json) r.jsonOut({ ok: true, loggedOut: false, revoked: false, note: 'Declined.' });
        else r.bullet('Revocation skipped — the local key is still stored.');
        return;
      }
    } catch (err) {
      prompter.close();
      if (err instanceof PromptClosedError) {
        if (ctx.json) {
          r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Cancelled.' } });
        } else {
          r.fail('Cancelled.');
        }
        process.exitCode = 1;
        return;
      }
      throw err;
    }
  }

  const client = new SeloraClient({ baseUrl, apiKey: key, debug: ctx.debug, logger: ctx.io.err });

  let keys: ApiKey[];
  try {
    keys = await listKeys(client);
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 401) {
      // The key is already dead/revoked server-side — still honor logout.
      clearStoredKey();
      if (ctx.json) {
        r.jsonOut({ ok: true, loggedOut: true, revoked: false, note: 'Key no longer valid server-side.' });
      } else {
        r.fail(err.apiMessage ?? err.message);
        r.bullet('Cleared the local key — it is no longer accepted by the Selora API.');
      }
      return;
    }
    r.renderError(err);
    return;
  }

  const matches = keys.filter((k) => k.key_hint === last4 && k.revoked_at === undefined);

  if (matches.length === 0) {
    clearStoredKey();
    if (ctx.json) {
      r.jsonOut({
        ok: true,
        loggedOut: true,
        revoked: false,
        note: `No server key matches hint …${last4}.`,
      });
      return;
    }
    r.bullet(`No key on the server matches …${last4} — nothing revoked.`);
    r.ok('Logged out');
    return;
  }

  if (matches.length > 1) {
    clearStoredKey();
    if (ctx.json) {
      r.jsonOut({
        ok: true,
        loggedOut: true,
        revoked: false,
        note: `${matches.length} server keys match hint …${last4}; none revoked.`,
      });
      return;
    }
    r.bullet(
      `${matches.length} keys on the server match …${last4} — refusing to guess; nothing revoked.`,
    );
    r.ok('Logged out');
    return;
  }

  const target = matches[0]!;
  try {
    await deleteKey(client, target.id);
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 404) {
      clearStoredKey();
      if (ctx.json) {
        r.jsonOut({ ok: true, loggedOut: true, revoked: false, note: 'Already gone server-side.' });
        return;
      }
      r.bullet('That key was already gone from the server — nothing to revoke.');
      r.ok('Logged out');
      return;
    }
    r.renderError(err);
    return;
  }

  clearStoredKey();
  if (ctx.json) {
    r.jsonOut({ ok: true, loggedOut: true, revoked: true, keyName: target.name, keyHint: last4 });
    return;
  }
  const label = target.name !== null ? `"${target.name}"` : 'the key';
  r.ok(`Revoked ${label} (…${last4}) from the server`);
  r.ok('Logged out');
}
