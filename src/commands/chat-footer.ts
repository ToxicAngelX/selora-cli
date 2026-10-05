/**
 * Shared per-reply footer for `chat` and `run` (one implementation, not a
 * copy): the gray `  Tokens: N · Cost: $X` line appears ONLY when the usage
 * chunk actually arrived — real numbers only, never invented. Sub-dime costs
 * keep 3 decimals because formatUsd's 2 decimals would collapse a typical
 * per-message charge ("0.018234") to a meaningless "$0.01" (same
 * truncation-toward-zero rule). Math is BigInt micro-units via the existing
 * money helpers — never floats.
 */

import type { ChatUsage } from '../api/endpoints/chat.js';
import { formatCount } from '../format.js';
import { formatUsd, formatUsdMicro, parseMoneyMicro } from '../money.js';

export function formatChatCost(charge: string): string {
  const micro = parseMoneyMicro(charge);
  if (micro === null) return formatUsd(charge);
  const abs = micro < 0n ? -micro : micro;
  if (abs !== 0n && abs < 100_000n) {
    const mills = abs / 1000n; // truncate toward zero
    return `$0.${mills.toString().padStart(3, '0')}`;
  }
  return formatUsdMicro(micro);
}

/**
 * The footer line (leading two spaces) for a completed reply, or undefined
 * when the stream never sent a usage chunk — the caller must print nothing.
 */
export function chatFooterLine(usage: ChatUsage | undefined, charge: string | undefined): string | undefined {
  if (usage === undefined) return undefined;
  const parts = [`Tokens: ${formatCount(BigInt(usage.totalTokens))}`];
  if (charge !== undefined && charge !== '') {
    parts.push(`Cost: ${formatChatCost(charge)}`);
  }
  return `  ${parts.join(' · ')}`;
}
