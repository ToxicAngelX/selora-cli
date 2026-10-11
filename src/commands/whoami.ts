/**
 * `selora whoami` — GET /v1/me rendered as account lines: email, name,
 * account status, plan (term kind + ends_at), trial state, and the wallet
 * balance line `Wallet $42.18 (plan purchases)` via exact integer money
 * formatting. --json keeps full-precision wire strings.
 */

import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { getMe } from '../api/endpoints/me.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';
import { themeFor } from '../ui/theme.js';
import { terminalTextWidth } from '../ui/terminal-text.js';

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

    const cfg = loadConfig();
    const theme = themeFor(cfg.theme, process.stdout.isTTY === true);

    const title = 'selora — account';
    const statusText = me.user.status !== '' ? me.user.status : 'unknown';
    const statusBadge = `[${statusText}]`;

    let planBadge = '[none]';
    let styledPlanBadge = theme.dim('[none]');
    if (me.plan_term !== null) {
      const term = me.plan_term;
      const planName = term.plan_name ?? me.plan?.name ?? 'plan';
      const ends = term.ends_at !== null ? ` · ends ${term.ends_at}` : '';
      planBadge = `[${planName} — ${term.kind}]${ends}`;
      styledPlanBadge = `[${theme.cyan(`${planName} — ${term.kind}`)}]${ends !== '' ? theme.dim(ends) : ''}`;
    }

    let trialLine: string | undefined;
    let styledTrialLine: string | undefined;
    if (me.user.trial_until !== null && me.user.trial_until !== '') {
      const verified = me.user.telegram_verified ? 'Telegram verified' : 'Telegram not verified';
      const trialBadge = me.user.trial_expired ? '[expired]' : '[active]';
      const styledTrialBadge = me.user.trial_expired
        ? theme.warning('[expired]')
        : theme.success('[active]');
      trialLine = `${trialBadge} until ${me.user.trial_until} · ${verified}`;
      styledTrialLine = `${styledTrialBadge} until ${me.user.trial_until} · ${theme.dim(verified)}`;
    } else if (me.plan_term === null) {
      trialLine = '[none]';
      styledTrialLine = theme.dim('[none]');
    }

    let walletLine: string | undefined;
    let styledWalletLine: string | undefined;
    if (me.wallet !== null && me.wallet.balance !== '') {
      const formatted = formatUsd(me.wallet.balance);
      walletLine = `[${formatted}] (plan purchases)`;
      styledWalletLine = `[${theme.star(formatted)}] ${theme.dim('(plan purchases)')}`;
    }

    const rows: Array<{ label: string; value: string; styledValue: string }> = [
      { label: 'Email', value: me.user.email, styledValue: me.user.email },
    ];
    if (me.user.name !== null && me.user.name !== '') {
      rows.push({ label: 'Name', value: me.user.name, styledValue: me.user.name });
    }
    rows.push({
      label: 'Account',
      value: statusBadge,
      styledValue: `[${statusText === 'active' ? theme.success(statusText) : statusText}]`,
    });
    rows.push({ label: 'Plan', value: planBadge, styledValue: styledPlanBadge });
    if (trialLine !== undefined && styledTrialLine !== undefined) {
      rows.push({ label: 'Trial', value: trialLine, styledValue: styledTrialLine });
    }
    if (walletLine !== undefined && styledWalletLine !== undefined) {
      rows.push({ label: 'Wallet', value: walletLine, styledValue: styledWalletLine });
    }

    const LABEL_PAD = 8;
    const innerRows = rows.map((row) => {
      const glyph = theme.cyan('❯');
      const plainGlyph = '❯';
      const label = theme.dim(row.label.padEnd(LABEL_PAD));
      const plainLabel = row.label.padEnd(LABEL_PAD);
      const text = `  ${glyph} ${label}  ${row.styledValue}`;
      const plainText = `  ${plainGlyph} ${plainLabel}  ${row.value}`;
      return { text, plainText, width: terminalTextWidth(plainText) };
    });

    const headerText = `✦ ${title}`;
    const minCardWidth = 52;
    const maxContentWidth = Math.max(
      terminalTextWidth(headerText) + 8,
      ...innerRows.map((r) => r.width),
    );
    const cardWidth = Math.max(minCardWidth, maxContentWidth + 4);

    const headerDashes = Math.max(2, cardWidth - 2 - terminalTextWidth(headerText) - 3);
    const topBorder = `${theme.dim('╭─ ')}${theme.cyan('✦')} ${theme.bold(title)} ${theme.dim(`${'─'.repeat(headerDashes)}╮`)}`;
    const emptyRow = `${theme.dim('│')}${' '.repeat(cardWidth - 2)}${theme.dim('│')}`;
    const bottomBorder = `${theme.dim(`╰${'─'.repeat(cardWidth - 2)}╯`)}`;

    r.line(topBorder);
    r.line(emptyRow);
    for (const row of innerRows) {
      const pad = ' '.repeat(Math.max(0, cardWidth - 2 - row.width));
      r.line(`${theme.dim('│')}${row.text}${pad}${theme.dim('│')}`);
    }
    r.line(emptyRow);
    r.line(bottomBorder);
  } catch (err) {
    r.renderError(err);
  }
}
