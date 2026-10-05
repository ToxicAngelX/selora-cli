/**
 * Pure display formatters for Phase 2 data commands: compact token counts
 * (512 / 940K / 2.8M), comma-grouped counts, compact "resets in" durations,
 * and days-left from ISO dates. All arithmetic is integer/BigInt — never
 * floats. Formatters never throw; unparseable input degrades honestly.
 */

const DAY_MS = 86_400_000;

/** Comma-group an integer count: 183 → "183", 1204 → "1,204". */
export function formatCount(n: bigint): string {
  if (n < 0n) return `-${formatCount(-n)}`;
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Compact token counts, truncating toward zero for display (same philosophy
 * as money formatting): 512 → "512", 940000 → "940K", 2800000 → "2.8M",
 * 18100000 → "18.1M". One decimal at most, never a trailing ".0".
 */
export function formatTokensCompact(n: bigint): string {
  if (n < 0n) return `-${formatTokensCompact(-n)}`;
  if (n < 1000n) return n.toString();
  const units: ReadonlyArray<readonly [bigint, string]> = [
    [10n ** 12n, 'T'],
    [10n ** 9n, 'B'],
    [10n ** 6n, 'M'],
    [10n ** 3n, 'K'],
  ];
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      const whole = n / scale;
      const tenths = (n % scale) * 10n / scale; // truncate toward zero
      return tenths === 0n ? `${whole}${suffix}` : `${whole}.${tenths}${suffix}`;
    }
  }
  return n.toString();
}

/**
 * Compact "resets in" duration from milliseconds: "1h 12m", "2d 5h", "45s".
 * At most two units (largest first). ms <= 0 → '' (caller decides whether to
 * show anything); sub-second → "under 1s" (never a fake "0s").
 */
export function formatDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 1) return 'under 1s';
  const d = Math.floor(totalSec / 86_400);
  const h = Math.floor((totalSec % 86_400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0) parts.push(`${s}s`);
  return parts.slice(0, 2).join(' ');
}

/**
 * Whole days from now until an ISO date (ceil, clamped at 0), or null when
 * the date is absent/unparseable — callers must not invent a number then.
 */
export function daysLeft(endsAt: string, now: number = Date.now()): number | null {
  if (endsAt.trim() === '') return null;
  const end = Date.parse(endsAt);
  if (Number.isNaN(end)) return null;
  const diff = end - now;
  if (diff <= 0) return 0;
  return Math.ceil(diff / DAY_MS);
}
