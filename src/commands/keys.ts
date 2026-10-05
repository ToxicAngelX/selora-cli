/**
 * `selora keys [list|create|revoke]` — API-key management.
 *
 * THE one-time secret rule: `keys create` prints the full secret EXACTLY
 * once, in one green stdout line — the command's whole purpose, since the
 * backend returns the secret exactly once. It never appears in debug logs
 * (the debug channel passes through redact()), error paths, or anywhere
 * else. Everything else shows only the backend-masked key_hint (last 4).
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { createKey, deleteKey, listKeys, type ApiKey } from '../api/endpoints/me.js';
import { createPrompter, PromptClosedError } from '../auth/prompts.js';
import { suggestedKeyName } from '../auth/keyname.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatCount } from '../format.js';

const KEY_NAME_MAX = 120;
/** The backend one-time-secret warning, used when the response omits `note`. */
const SECRET_NOTE = 'Store this secret now — it cannot be retrieved again.';

export interface KeysFlags {
  name?: string | undefined;
  yes?: boolean | undefined;
}

function dateOnly(iso: string): string {
  return iso.length >= 10 ? iso.slice(0, 10) : (iso !== '' ? iso : '—');
}

function newClient(ctx: CliContext, baseUrl: string): SeloraClient {
  return new SeloraClient({ baseUrl, apiKey: getStoredKey(), debug: ctx.debug, logger: ctx.io.err });
}

export async function runKeys(
  ctx: CliContext,
  action: string | undefined,
  arg: string | undefined,
  flags: KeysFlags,
): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  if (action === undefined || action === 'list') {
    await keysList(ctx, r);
    return;
  }
  if (action === 'create') {
    await keysCreate(ctx, r, flags);
    return;
  }
  if (action === 'revoke') {
    if (arg === undefined || arg.trim() === '') {
      r.renderError(
        new SeloraApiError({
          kind: 'http_error',
          message: 'Usage: selora keys revoke <id|…hint>',
          hint: 'Find ids and hints with: selora keys list',
        }),
      );
      return;
    }
    await keysRevoke(ctx, r, arg.trim(), flags);
    return;
  }
  r.renderError(
    new SeloraApiError({
      kind: 'http_error',
      message: `Unknown keys action "${action}".`,
      hint: 'Use: selora keys [list|create|revoke]',
    }),
  );
}

async function keysList(ctx: CliContext, r: Renderer): Promise<void> {
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = newClient(ctx, baseUrl);
  try {
    const keys = await listKeys(client);
    if (ctx.json) {
      r.jsonOut({ ok: true, keys });
      return;
    }
    r.line('SELORA KEYS');
    r.divider();
    if (keys.length === 0) {
      r.line('No API keys — create one with: selora keys create');
      return;
    }
    const rows = keys.map((k) => ({
      name: k.name !== null && k.name !== '' ? k.name : '—',
      // EXACTLY what the backend returns (last 4) — never reconstructed.
      key: k.key_hint !== '' ? `…${k.key_hint}` : '—',
      status: k.status !== '' ? k.status : '—',
      created: dateOnly(k.created_at),
      used: k.last_used_at !== null && k.last_used_at !== '' ? dateOnly(k.last_used_at) : 'never',
      requests: formatCount(BigInt(k.request_count)),
    }));
    const wName = Math.max(4, ...rows.map((x) => x.name.length)) + 2;
    const wKey = Math.max(3, ...rows.map((x) => x.key.length)) + 2;
    const wStatus = Math.max(6, ...rows.map((x) => x.status.length)) + 2;
    const wCreated = Math.max(7, ...rows.map((x) => x.created.length)) + 2;
    const wUsed = Math.max(9, ...rows.map((x) => x.used.length)) + 2;
    r.gray(
      `${'NAME'.padEnd(wName)}${'KEY'.padEnd(wKey)}${'STATUS'.padEnd(wStatus)}${'CREATED'.padEnd(wCreated)}${'LAST USED'.padEnd(wUsed)}REQUESTS`,
    );
    for (const row of rows) {
      r.line(
        `${row.name.padEnd(wName)}${row.key.padEnd(wKey)}${row.status.padEnd(wStatus)}${row.created.padEnd(wCreated)}${row.used.padEnd(wUsed)}${row.requests}`,
      );
    }
    const revoked = keys.filter((k) => k.status === 'revoked' || k.revoked_at !== undefined);
    if (revoked.length > 0) {
      r.bullet(
        `${revoked.length} revoked ${revoked.length === 1 ? 'key' : 'keys'} — revoked keys can no longer authenticate.`,
      );
    }
  } catch (err) {
    r.renderError(err);
  }
}

async function keysCreate(ctx: CliContext, r: Renderer, flags: KeysFlags): Promise<void> {
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = newClient(ctx, baseUrl);
  const suggestion = suggestedKeyName();

  let name: string;
  if (flags.name !== undefined) {
    if (flags.name.trim() === '') {
      r.renderError(new SeloraApiError({ kind: 'http_error', message: '--name needs a value.' }));
      return;
    }
    name = flags.name.trim();
  } else if (!ctx.io.isTTY) {
    // Non-interactive without --name: use the suggestion (scriptable, no prompt).
    name = suggestion;
  } else {
    const prompter = createPrompter({ stdin: ctx.io.stdin, isTTY: ctx.io.isTTY, err: ctx.io.err });
    try {
      const answer = (await prompter.text(`Key name (${suggestion}):`)).trim();
      name = answer === '' ? suggestion : answer;
    } catch (err) {
      if (err instanceof PromptClosedError) {
        process.exitCode = 1;
        if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Cancelled.' } });
        else r.fail('Cancelled.');
        return;
      }
      throw err;
    } finally {
      prompter.close();
    }
  }
  if (name === '') {
    process.exitCode = 1;
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Cancelled.' } });
    else r.fail('Cancelled.');
    return;
  }
  name = name.slice(0, KEY_NAME_MAX);

  try {
    const created = await createKey(client, name);
    if (created.secret === '') {
      throw new SeloraApiError({ kind: 'http_error', message: 'Selora did not return the new key secret.' });
    }
    if (ctx.json) {
      // Machine consumers need the secret; it appears exactly once, here.
      r.jsonOut({ ok: true, key: created.api_key, secret: created.secret, note: created.note });
      return;
    }
    r.ok(`Key created: ${name}`);
    r.line('✰ THIS IS THE ONLY TIME THE FULL KEY IS SHOWN — copy it now:');
    r.green(`  ${created.secret}`);
    r.bullet(created.note !== '' ? created.note : SECRET_NOTE);
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 409) {
      process.exitCode = 1;
      if (ctx.json) {
        r.jsonOut({
          ok: false,
          error: {
            kind: 'http_error',
            message: err.apiMessage ?? 'Key limit reached.',
            hint: 'Revoke an old key at selora.lol → Keys, or run: selora keys revoke <id|…hint>',
          },
        });
        return;
      }
      r.fail(err.apiMessage ?? 'Key limit reached.');
      r.bullet('Revoke an old key at selora.lol → Keys, or run: selora keys revoke <id|…hint>');
      return;
    }
    r.renderError(err);
  }
}

async function keysRevoke(ctx: CliContext, r: Renderer, arg: string, flags: KeysFlags): Promise<void> {
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = newClient(ctx, baseUrl);

  let keys: ApiKey[];
  try {
    keys = await listKeys(client);
  } catch (err) {
    r.renderError(err);
    return;
  }

  // Resolve the argument: full id, or `…abcd` / `abcd` matching key_hint.
  let matches = keys.filter((k) => k.id === arg && k.id !== '');
  if (matches.length === 0) {
    const needle = arg.replace(/^(?:…|\.)+/u, '');
    matches = keys.filter((k) => k.key_hint !== '' && k.key_hint === needle && k.revoked_at === undefined);
  }
  if (matches.length === 0) {
    process.exitCode = 1;
    if (ctx.json) {
      r.jsonOut({ ok: false, error: { kind: 'http_error', message: `No key matches ${arg}.` } });
      return;
    }
    r.fail(`No key matches ${arg}.`);
    r.bullet('List keys with: selora keys list');
    return;
  }
  if (matches.length > 1) {
    process.exitCode = 1;
    if (ctx.json) {
      r.jsonOut({
        ok: false,
        error: { kind: 'http_error', message: `${matches.length} keys match ${arg} — refusing to guess.` },
      });
      return;
    }
    r.fail(`${matches.length} keys match ${arg} — refusing to guess.`);
    for (const k of matches) {
      r.bullet(`${k.name ?? 'unnamed'} · …${k.key_hint} · ${k.id}`);
    }
    return;
  }
  const target = matches[0]!;

  // Confirmation: TTY → y/N prompt (unless --yes); non-TTY → require --yes.
  if (flags.yes !== true) {
    if (!ctx.io.isTTY) {
      r.renderError(
        new SeloraApiError({
          kind: 'http_error',
          message: 'Refusing to revoke without confirmation.',
          hint: 'Re-run with --yes to revoke non-interactively.',
        }),
      );
      return;
    }
    const prompter = createPrompter({ stdin: ctx.io.stdin, isTTY: ctx.io.isTTY, err: ctx.io.err });
    try {
      const confirmed = await prompter.confirm(
        `Revoke the server key ending …${target.key_hint}? This cannot be undone.`,
      );
      if (!confirmed) {
        if (ctx.json) r.jsonOut({ ok: true, revoked: false, note: 'Declined.' });
        else r.bullet('Revocation skipped.');
        return;
      }
    } catch (err) {
      if (err instanceof PromptClosedError) {
        process.exitCode = 1;
        if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Cancelled.' } });
        else r.fail('Cancelled.');
        return;
      }
      throw err;
    } finally {
      prompter.close();
    }
  }

  try {
    const res = await deleteKey(client, target.id);
    if (ctx.json) {
      r.jsonOut({ ok: true, id: res.id, deleted: true, deletion: res.deletion });
      return;
    }
    const label = target.name !== null && target.name !== '' ? `"${target.name}"` : 'the key';
    r.ok(`Deleted ${label} (…${target.key_hint}) — ${res.deletion} delete`);
  } catch (err) {
    if (err instanceof SeloraApiError && err.status === 404) {
      if (ctx.json) r.jsonOut({ ok: true, deleted: false, note: 'Already gone from the server.' });
      else r.bullet('That key was already gone from the server — nothing to revoke.');
      return;
    }
    r.renderError(err);
  }
}
