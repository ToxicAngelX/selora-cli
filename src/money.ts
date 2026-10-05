/**
 * Money handling for the Selora wire format: decimal strings at scale 6
 * ("42.180000" = $42.18). All math is BigInt integer arithmetic on micro-units
 * — never floats. Formatting truncates toward zero for display only; callers
 * needing full precision (--json) keep the original wire string.
 */

const SCALE = 6;
const MICRO = 10n ** BigInt(SCALE);

const MONEY_RE = /^(-?)(\d+)(?:\.(\d{1,20}))?$/;

/** Parse a scale-6 decimal string into micro-units (BigInt). null when malformed. */
export function parseMoneyMicro(raw: string): bigint | null {
  const m = MONEY_RE.exec(raw.trim());
  if (!m) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2]!);
  const fracRaw = m[3] ?? '';
  if (fracRaw.length > SCALE) {
    // More than 6 decimals is off-wire; truncate toward zero.
    return sign * (whole * MICRO + BigInt(fracRaw.slice(0, SCALE)));
  }
  const frac = BigInt(fracRaw.padEnd(SCALE, '0'));
  return sign * (whole * MICRO + frac);
}

/**
 * Format a scale-6 decimal string as `$1.23` (truncation toward zero, 2 dp).
 * Falls back to `$<raw>` when the string is not parseable — never throws,
 * never invents digits.
 */
export function formatUsd(raw: string): string {
  const micro = parseMoneyMicro(raw);
  if (micro === null) return `$${raw}`;
  return formatUsdMicro(micro);
}

/** Format micro-units (e.g. a BigInt sum) as `$1.23` — same rules as formatUsd. */
export function formatUsdMicro(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const dollars = abs / MICRO;
  const cents = (abs % MICRO) / 10000n; // truncation toward zero, display only
  const sign = negative ? '-' : '';
  return `${sign}$${dollars}.${cents.toString().padStart(2, '0')}`;
}

/** Render micro-units back to a scale-6 wire-style decimal string ("9.100000"). */
export function microToWireString(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padEnd(SCALE, '0').slice(0, SCALE);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
