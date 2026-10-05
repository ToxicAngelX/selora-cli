/**
 * `selora whoami` — GET /v1/me rendered as account lines: email, name,
 * account status, plan (term kind + ends_at), trial state, and the wallet
 * balance line `Wallet $42.18 (plan purchases)` via exact integer money
 * formatting. --json keeps full-precision wire strings.
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { getMe } from '../api/endpoints/me.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';

export async function runWhoami(ctx: CliContext): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const key = getStoredKey();
  const client = new SeloraClient({ baseUrl, apiKey: key, debug: ctx.debug, logger: ctx.io.err });

  try {
    const me = await getMe(client);
    if (ctx.json) {
      r.jsonOut({
        ok: true,
        user: me.user,
        plan: me.plan,
        plan_term: me.plan_term,
        wallet: me.wallet,
      });
      return;
    }
    r.line('selora — account');
    r.divider();
    r.field('Email', me.user.email);
    if (me.user.name !== null && me.user.name !== '') r.field('Name', me.user.name);
    r.field('Account', me.user.status !== '' ? me.user.status : 'unknown');
    if (me.plan_term !== null) {
      const term = me.plan_term;
      const planName = term.plan_name ?? me.plan?.name ?? 'plan';
      const ends = term.ends_at !== null ? `, ends ${term.ends_at}` : '';
      r.field('Plan', `${planName} — ${term.kind}${ends}`);
    } else {
      r.field('Plan', 'none');
    }
    if (me.user.trial_until !== null && me.user.trial_until !== '') {
      const verified = me.user.telegram_verified ? 'Telegram verified' : 'Telegram not verified';
      const expired = me.user.trial_expired ? ' (expired)' : '';
      r.field('Trial', `active until ${me.user.trial_until}${expired} · ${verified}`);
    } else if (me.plan_term === null) {
      r.field('Trial', 'none');
    }
    if (me.wallet !== null && me.wallet.balance !== '') {
      r.field('Wallet', `${formatUsd(me.wallet.balance)} (plan purchases)`);
    }
  } catch (err) {
    r.renderError(err);
  }
}
