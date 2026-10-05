/**
 * `selora balance` — one view of the money model: wallet (plan-purchase
 * funds, never inference), plan term with days left, and both rolling spend
 * windows with the resets-in countdown. Money stays decimal-string → BigInt
 * → formatUsd; empty/absent wire fields print `—`, never fake zeros.
 * `Updated` is the local clock when the responses arrived (the API sends no
 * timestamp — that is why the label says "Updated", not "Server time").
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { getBalance, getMe, getWindows, type MeResponse, type SpendWindow } from '../api/endpoints/me.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';
import { daysLeft, formatDurationCompact } from '../format.js';

const LABEL_WIDTH = 26;

function windowLine(w: SpendWindow, withReset: boolean): string {
  if (w.unlimited) return 'unlimited';
  if (w.remainingUsd === '' || w.limitUsd === '') return '—';
  if (w.exhausted) {
    const dur = formatDurationCompact(w.resetsInMs);
    return dur !== '' ? `exhausted — resets in ${dur}` : 'exhausted';
  }
  // enforced=false still shows the numbers — the gateway reports them either way.
  let value = `${formatUsd(w.remainingUsd)} of ${formatUsd(w.limitUsd)}`;
  if (withReset && w.resetsInMs > 0) {
    const dur = formatDurationCompact(w.resetsInMs);
    if (dur !== '') value += `  (resets in ${dur})`;
  }
  return value;
}

function planLine(me: MeResponse): string {
  const term = me.plan_term;
  if (term === null) return 'none';
  const name = term.kind === 'trial' ? 'Trial' : (term.plan_name ?? me.plan?.name ?? 'plan');
  const days = term.ends_at !== null ? daysLeft(term.ends_at) : null;
  if (days === null) return name;
  return `${name} — ${days} ${days === 1 ? 'day' : 'days'} left`;
}

function localTimeString(d: Date): string {
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function runBalance(ctx: CliContext): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({ baseUrl, apiKey: getStoredKey(), debug: ctx.debug, logger: ctx.io.err });

  try {
    const [wallet, windows, me] = await Promise.all([getBalance(client), getWindows(client), getMe(client)]);
    const fetchedAt = new Date();
    if (ctx.json) {
      r.jsonOut({
        ok: true,
        wallet,
        windows: { session: windows.session, week: windows.week },
        plan:
          me.plan_term !== null
            ? {
                name: me.plan_term.plan_name ?? me.plan?.name ?? null,
                kind: me.plan_term.kind,
                ends_at: me.plan_term.ends_at,
              }
            : null,
        fetched_at: fetchedAt.toISOString(),
      });
      return;
    }
    r.line('SELORA BALANCE');
    r.divider();
    r.field('Wallet (plan purchases)', wallet !== null && wallet.balance !== '' ? formatUsd(wallet.balance) : '—', LABEL_WIDTH);
    r.field('Plan', planLine(me), LABEL_WIDTH);
    r.field('4h window left', windowLine(windows.session, true), LABEL_WIDTH);
    r.field('Weekly window left', windowLine(windows.week, false), LABEL_WIDTH);
    r.field('Updated', localTimeString(fetchedAt), LABEL_WIDTH);
  } catch (err) {
    r.renderError(err);
  }
}
