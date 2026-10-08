/**
 * Live usage-windows status for the chat REPL (v1.6): the prompt footer's
 * spend-cap segment (`$4.12/$10.00 · resets 2h 14m · week 38%`) and the
 * `/windows` detail block share ONE implementation here — the poll tracker,
 * the money formatting, and the reset countdown.
 *
 * Money law: BigInt micro-units via money.ts — never floats. Values ≥ $1
 * render exactly like formatUsdMicro (2 decimals, truncation toward zero —
 * the wire's 6-decimal string loses its trailing zeros beyond the 2nd
 * decimal); sub-dollar non-zero values keep 4 decimals (trailing zeros
 * trimmed, min 2) so a small window spend never collapses to "$0.03"
 * (same philosophy as chat-footer's sub-dime rule, one digit deeper).
 *
 * The tracker polls getWindows at REPL idle only: a 60s timer whose tick is
 * SKIPPED while a reply streams, plus an immediate refresh after every reply
 * (a reply just consumed budget — stale numbers are lies). Failures never
 * surface in the footer: the segment is omitted, the first failure per
 * streak is reported via onFirstError (the caller logs it at debug level),
 * and last-known-good data keeps rendering until a success replaces it.
 * Wire data is untrusted: unparseable fields degrade to "omit the segment",
 * never throw in the render path.
 */

import type { SpendWindow, WindowsResponse } from '../api/endpoints/me.js';
import { formatUsd, formatUsdMicro, parseMoneyMicro } from '../money.js';
import { formatCount } from '../format.js';

const MICRO = 1_000_000n;

/** Footer width breakpoints: below 60 cols drop the week %, below 40 the resets. */
export const WIDTH_DROP_WEEK = 60;
export const WIDTH_DROP_RESETS = 40;

/** Default idle poll cadence for the tracker. */
export const WINDOWS_POLL_MS = 60_000;

/**
 * Window money: `$4.12`, `$10.00` (≥ $1 — exactly 2 decimals, truncation
 * toward zero) or `$0.0381`, `$0.50` (sub-dollar non-zero — 4 decimals
 * truncated, trailing zeros trimmed, min 2).
 */
export function formatWindowUsdMicro(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  if (abs !== 0n && abs < MICRO) {
    const scaled = (abs * 10_000n) / MICRO; // 4 decimals, truncation toward zero
    const whole = scaled / 10_000n;
    let frac = (scaled % 10_000n).toString().padStart(4, '0');
    frac = frac.replace(/0+$/, '');
    if (frac.length < 2) frac = frac.padEnd(2, '0');
    return `${negative ? '-' : ''}$${whole}.${frac}`;
  }
  return formatUsdMicro(micro);
}

/** Parse a wire decimal string and format it for the windows UI. */
export function formatWindowUsd(raw: string): string {
  const micro = parseMoneyMicro(raw);
  if (micro === null) return formatUsd(raw); // honest fallback, never throws
  return formatWindowUsdMicro(micro);
}

/**
 * Reset countdown from milliseconds: `2h 14m`, `36h 05m` (hours can exceed
 * a day — week resets do — and minutes zero-pad when hours show), `45m`
 * under an hour, `<1m` under a minute. ms <= 0 (or non-finite) → '' and the
 * caller omits the countdown entirely.
 */
export function formatResetsIn(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const totalSec = Math.floor(ms / 1000);
  if (totalSec < 60) return '<1m';
  const totalMin = Math.floor(totalSec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m.toString().padStart(2, '0')}m`;
}

/**
 * Week window used/limit as a whole percent, rounded to nearest (BigInt,
 * half-up). null when the week window is unlimited, the limit is <= 0, or
 * either wire string is unparseable — the caller omits the `week N%` part.
 */
export function windowPercent(w: SpendWindow): number | null {
  if (w.unlimited) return null;
  const used = parseMoneyMicro(w.usedUsd);
  const limit = parseMoneyMicro(w.limitUsd);
  if (used === null || limit === null || limit <= 0n) return null;
  const pct = ((used * 200n) / limit + 1n) / 2n;
  return Number(pct < 0n ? 0n : pct);
}

/** The one color the footer segment needs (exhausted = warn). */
export interface WindowSegmentTheme {
  warning: (s: string) => string;
}

/**
 * The footer segment for line 1 (`$4.12/$10.00 · resets 2h 14m · week 38%`),
 * or '' when there is nothing honest to show: no data, the window is
 * unlimited (pulsar), or enforcement is off. An exhausted cap renders in the
 * theme's warning color as `cap reached · resets 2h 14m`. Narrow terminals
 * shed detail: week % below WIDTH_DROP_WEEK cols, the countdown below
 * WIDTH_DROP_RESETS — the used/limit pair always stays.
 */
export function windowFooterSegment(
  w: WindowsResponse,
  cols: number,
  theme?: WindowSegmentTheme,
): string {
  const s = w.session;
  if (s.unlimited || !s.enforced) return '';
  const resets = formatResetsIn(s.resetsInMs);
  if (s.exhausted) {
    const text = resets !== '' ? `cap reached · resets ${resets}` : 'cap reached';
    return theme !== undefined ? theme.warning(text) : text;
  }
  const used = parseMoneyMicro(s.usedUsd);
  const limit = parseMoneyMicro(s.limitUsd);
  if (used === null || limit === null) return ''; // untrusted wire → omit
  const parts = [`${formatWindowUsdMicro(used)}/${formatWindowUsdMicro(limit)}`];
  if (cols >= WIDTH_DROP_RESETS && resets !== '') parts.push(`resets ${resets}`);
  if (cols >= WIDTH_DROP_WEEK) {
    const pct = windowPercent(w.week);
    if (pct !== null) parts.push(`week ${pct}%`);
  }
  return parts.join(' · ');
}

/** resetsAt as local `YYYY-MM-DD HH:MM`, or null when absent/unparseable. */
function localDateTime(iso: string): string | null {
  if (iso.trim() === '') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const p = (n: number): string => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** The flags as human words: `enforced · not exhausted`, `unlimited`, … */
function windowFlagWords(w: SpendWindow): string {
  const words = [w.enforced ? 'enforced' : 'not enforced'];
  if (w.unlimited) words.push('unlimited');
  else words.push(w.exhausted ? 'exhausted' : 'not exhausted');
  return words.join(' · ');
}

function windowDetailBlock(label: string, w: SpendWindow): string[] {
  const lines = [`${label}:`];
  if (w.unlimited) {
    lines.push('  unlimited — no cap');
  } else {
    const used = parseMoneyMicro(w.usedUsd);
    const limit = parseMoneyMicro(w.limitUsd);
    if (used !== null && limit !== null) {
      const parts = [`  used ${formatWindowUsdMicro(used)} of ${formatWindowUsdMicro(limit)}`];
      const remaining = parseMoneyMicro(w.remainingUsd);
      if (remaining !== null) parts.push(`remaining ${formatWindowUsdMicro(remaining)}`);
      parts.push(`${formatCount(BigInt(w.requests))} requests`);
      lines.push(parts.join(' · '));
    } else {
      lines.push('  (no window data reported)');
    }
    const when = localDateTime(w.resetsAt);
    const resets = formatResetsIn(w.resetsInMs);
    if (when !== null || resets !== '') {
      let line = '  resets';
      if (when !== null) line += ` at ${when} local`;
      if (resets !== '') line += ` (in ${resets})`;
      lines.push(line);
    }
  }
  lines.push(`  ${windowFlagWords(w)}`);
  return lines;
}

/**
 * The `/windows` detail block: both windows with used/limit/remaining,
 * request counts, the reset clock in local time, and the flags as words.
 */
export function windowDetailLines(w: WindowsResponse): string[] {
  return [
    ...windowDetailBlock('Session (4h) window', w.session),
    ...windowDetailBlock('Week window', w.week),
  ];
}

export interface WindowsTrackerDeps {
  /** The one fetch implementation — getWindows(client, { signal }) in the REPL. */
  fetch: (signal: AbortSignal) => Promise<WindowsResponse>;
  /** true while a reply streams or a `!` command runs — ticks skip then. */
  isBusy: () => boolean;
  /** Fresh state landed — redraw the footer. */
  onChange?: () => void;
  /** First failure since the last success (log once at debug, not per retry). */
  onFirstError?: (err: unknown) => void;
  /** Poll cadence (default WINDOWS_POLL_MS). */
  intervalMs?: number;
}

/**
 * The idle poller behind the footer segment. start() fetches immediately so
 * the first prompt can already carry the segment; the 60s timer then ticks
 * only at idle. notifyIdle() is the post-reply refresh — a reply just
 * consumed budget, so the numbers are refreshed the moment the stream ends,
 * never mid-stream. Concurrent calls share one in-flight fetch, and stop()
 * aborts it so an exiting REPL never waits on a hung gateway.
 */
export class WindowsTracker {
  private state: WindowsResponse | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inflight:
    | { promise: Promise<WindowsResponse>; abort: () => void }
    | undefined;
  private failureLogged = false;
  private stopped = true;

  constructor(private readonly deps: WindowsTrackerDeps) {}

  /** Last-known-good state, or null when nothing has ever landed. */
  get current(): WindowsResponse | null {
    return this.state;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.poll();
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.inflight?.abort();
  }

  /** A reply just completed — refresh now (the budget moved). */
  notifyIdle(): void {
    if (this.stopped) return;
    void this.poll();
  }

  /** `/windows`: a fresh fetch whose errors propagate to the command. */
  fetchNow(): Promise<WindowsResponse> {
    return this.run();
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      // Never fetch mid-stream — the post-reply notifyIdle catches up.
      if (!this.deps.isBusy()) void this.poll();
      this.arm();
    }, this.deps.intervalMs ?? WINDOWS_POLL_MS);
    this.timer.unref?.();
  }

  private async poll(): Promise<void> {
    try {
      await this.run();
      this.failureLogged = false;
    } catch (err) {
      // The footer is additive, never a failure surface: keep rendering
      // last-known-good (or nothing), log once per failure streak. A stop()
      // abort is a shutdown, not a failure.
      if (this.stopped) return;
      if (!this.failureLogged) {
        this.failureLogged = true;
        this.deps.onFirstError?.(err);
      }
    }
  }

  private run(): Promise<WindowsResponse> {
    if (this.inflight !== undefined) return this.inflight.promise;
    const controller = new AbortController();
    const promise = this.deps.fetch(controller.signal).then(
      (w) => {
        if (this.inflight?.promise === promise) this.inflight = undefined;
        this.state = w;
        this.deps.onChange?.();
        return w;
      },
      (err: unknown) => {
        if (this.inflight?.promise === promise) this.inflight = undefined;
        throw err;
      },
    );
    this.inflight = { promise, abort: () => controller.abort() };
    return promise;
  }
}
