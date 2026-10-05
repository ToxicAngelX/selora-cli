/**
 * `selora usage` — period totals from /v1/me/usage daily summary rows, summed
 * with BigInt (requests/tokens/spend are STRINGS on the wire). Flags map to
 * days: --today→1, --week→7, --month→30 — the API only supports days=N, no
 * arbitrary ranges. Default shows both Today and This week.
 *
 * Honesty rules pinned here:
 *  - by_model in the response is ALL-TIME, not period-filtered; it is never
 *    summed into range lines and only appears under the literal label
 *    `All-time by model` (via --by-model).
 *  - An empty summary is a real answer: `No usage recorded in this period.`,
 *    never a fake zero line.
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { getUsage, type UsageDay } from '../api/endpoints/me.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd, formatUsdMicro, microToWireString, parseMoneyMicro } from '../money.js';
import { formatCount, formatTokensCompact } from '../format.js';

export interface UsageFlags {
  today?: boolean | undefined;
  week?: boolean | undefined;
  month?: boolean | undefined;
  byModel?: boolean | undefined;
}

export interface UsageTotals {
  requests: bigint;
  inputTokens: bigint;
  outputTokens: bigint;
  spendMicro: bigint;
}

const DIGITS_RE = /^\d+$/;

/** Sum daily summary rows. Non-numeric strings contribute 0 (never NaN). */
export function sumUsageRows(rows: UsageDay[]): UsageTotals {
  let requests = 0n;
  let inputTokens = 0n;
  let outputTokens = 0n;
  let spendMicro = 0n;
  for (const row of rows) {
    if (DIGITS_RE.test(row.total_requests)) requests += BigInt(row.total_requests);
    if (DIGITS_RE.test(row.total_input_tokens)) inputTokens += BigInt(row.total_input_tokens);
    if (DIGITS_RE.test(row.total_output_tokens)) outputTokens += BigInt(row.total_output_tokens);
    spendMicro += parseMoneyMicro(row.total_spend) ?? 0n;
  }
  return { requests, inputTokens, outputTokens, spendMicro };
}

function usageLineValue(t: UsageTotals): string {
  return (
    `${formatCount(t.requests)} requests` +
    ` · ${formatTokensCompact(t.inputTokens)} in` +
    ` · ${formatTokensCompact(t.outputTokens)} out` +
    ` · ${formatUsdMicro(t.spendMicro)}`
  );
}

function totalsJson(t: UsageTotals): { requests: string; input_tokens: string; output_tokens: string; spend: string } {
  return {
    requests: t.requests.toString(),
    input_tokens: t.inputTokens.toString(),
    output_tokens: t.outputTokens.toString(),
    spend: microToWireString(t.spendMicro),
  };
}

export async function runUsage(ctx: CliContext, flags: UsageFlags): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({ baseUrl, apiKey: getStoredKey(), debug: ctx.debug, logger: ctx.io.err });

  const picked = [
    { on: flags.today === true, label: 'Today', days: 1 },
    { on: flags.week === true, label: 'This week', days: 7 },
    { on: flags.month === true, label: 'This month', days: 30 },
  ];
  if (picked.filter((p) => p.on).length > 1) {
    r.renderError(
      new SeloraApiError({
        kind: 'http_error',
        message: 'Pick one of --today, --week, or --month.',
        hint: 'The API only supports fixed day ranges (days=1/7/30) — no arbitrary date ranges.',
      }),
    );
    return;
  }
  const ranges = picked.some((p) => p.on)
    ? picked.filter((p) => p.on)
    : [
        { on: true, label: 'Today', days: 1 },
        { on: true, label: 'This week', days: 7 },
      ];

  try {
    const responses = await Promise.all(ranges.map((range) => getUsage(client, range.days)));
    const sums = responses.map((res) => sumUsageRows(res.summary));
    const allEmpty = responses.every((res) => res.summary.length === 0);

    if (ctx.json) {
      const out: Record<string, unknown> = { ok: true };
      if (ranges.length === 1) {
        out['days'] = ranges[0]!.days;
        out['totals'] = totalsJson(sums[0]!);
        out['summary'] = responses[0]!.summary;
      } else {
        out['ranges'] = ranges.map((range, i) => ({
          days: range.days,
          label: range.label,
          totals: totalsJson(sums[i]!),
          summary: responses[i]!.summary,
        }));
      }
      if (flags.byModel === true) {
        out['by_model'] = responses[0]!.by_model;
        out['by_model_scope'] = 'all-time';
      }
      r.jsonOut(out);
      return;
    }

    r.line('SELORA USAGE');
    r.divider();
    if (allEmpty) {
      r.line('No usage recorded in this period.');
    } else {
      ranges.forEach((range, i) => {
        const value = responses[i]!.summary.length === 0 ? 'no usage recorded' : usageLineValue(sums[i]!);
        r.field(range.label, value);
      });
    }

    if (flags.byModel === true) {
      const byModel = responses[0]!.by_model;
      if (byModel.length > 0) {
        r.line('');
        r.line('All-time by model');
        r.divider();
        const wModel = Math.max(6, ...byModel.map((m) => m.model_id.length)) + 2;
        const wReq = Math.max(9, ...byModel.map((m) => formatCount(BigInt(m.requests)).length)) + 2;
        r.gray(`${'MODEL'.padEnd(wModel)}${'REQUESTS'.padStart(wReq)} SPEND`);
        for (const m of byModel) {
          r.line(`${m.model_id.padEnd(wModel)}${formatCount(BigInt(m.requests)).padStart(wReq)} ${formatUsd(m.spend)}`);
        }
      }
    }
  } catch (err) {
    r.renderError(err);
  }
}
