/**
 * The context meter (v1.2): token accounting + the rendered `ctx` bar.
 *
 * Estimates are cheap and honest: ~4 chars per token for text (a deliberate
 * mid-point of the 3–5 range for mixed English/code/tool-output content),
 * plus tool-call JSON skeleton overhead. Real usage numbers (the usage chunk
 * from the gateway) ALWAYS win when present — estimateTokens is the fallback
 * between chunks, never the source of truth when the truth arrived.
 *
 * The bar renders in three zones: filled cells colored by ratio (theme
 * gradient when healthy, warning at ≥75%, error at ≥90%), then the plain
 * ratio + token numbers. `compactBarFor` produces the same bar with a pulse
 * suffix for the animated "context critical" state (TTY only).
 */

import type { ChatMessage } from '../api/endpoints/chat.js';
import { formatCount } from '../format.js';

/** Chars per token for the estimate — calibrated mid-point, never a claim. */
const CHARS_PER_TOKEN = 4;
/** Base overhead per tool-call JSON envelope (id/name/arguments brackets). */
const TOOL_CALL_OVERHEAD = 16;

/** Default context budget when the model detail carries no explicit limit:
 *  the smallest commonly-routed window on Selora rails. Config via
 *  selora.json agent.contextTokens. */
export const DEFAULT_CONTEXT_TOKENS = 30_000;
/** Where the bar turns warning-colored. */
export const WARN_RATIO = 0.75;
/** Where the bar turns error-colored AND compaction triggers. */
export const CRITICAL_RATIO = 0.9;

/** Rough token count for one message (pure, injectable nowhere needed). */
export function estimateTokensMessage(msg: ChatMessage): number {
  if (msg.role === 'user') {
    return typeof msg.content === 'string'
      ? Math.ceil(msg.content.length / CHARS_PER_TOKEN)
      : Math.ceil(JSON.stringify(msg.content).length / CHARS_PER_TOKEN);
  }
  if (msg.role === 'system') {
    return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
  }
  if (msg.role === 'assistant') {
    const text = msg.content === null ? 0 : msg.content.length;
    const calls = (msg.tool_calls ?? []).reduce(
      (n, c) => n + TOOL_CALL_OVERHEAD + c.function.arguments.length,
      0,
    );
    return Math.ceil((text + calls) / CHARS_PER_TOKEN);
  }
  // tool role — the result content string
  return Math.ceil(msg.content.length / CHARS_PER_TOKEN);
}

/** Estimated tokens for a whole history. */
export function estimateTokensHistory(messages: readonly ChatMessage[]): number {
  return messages.reduce((n, m) => n + estimateTokensMessage(m), 0);
}

export interface ContextBarTheme {
  /** Wrap text in warning color (or return as-is at level 0). */
  warning: (s: string) => string;
  error: (s: string) => string;
  /** Color one bar cell at position i of total. */
  gradientAt: (s: string, i: number, total: number) => string;
  dim: (s: string) => string;
}

export interface ContextBarOptions {
  width?: number;
  /** Total budget in tokens (default DEFAULT_CONTEXT_TOKENS). */
  tokens?: number;
}

/** Filled/empty bar cells — block glyphs, 8 cells default. */
const BAR_CELLS = 8;
const FILLED = '▰';
const EMPTY = '▱';

/** Ratio clamped to [0, 1]. */
function ratioOf(used: number, total: number): number {
  if (total <= 0) return 0;
  const r = used / total;
  return Number.isNaN(r) || r < 0 ? 0 : r > 1 ? 1 : r;
}

/**
 * The bar for a prompt-status line: `ctx ▰▰▰▱▱▱▱▱ 62% · 18.2k/30k`.
 * Uncolored when theme is undefined (tests, NO_COLOR).
 */
export function contextBar(
  used: number,
  opts: ContextBarOptions = {},
  theme?: ContextBarTheme,
): string {
  const total = opts.tokens ?? DEFAULT_CONTEXT_TOKENS;
  const ratio = ratioOf(used, total);
  const filled = Math.round(ratio * BAR_CELLS);
  let cells = '';
  for (let i = 0; i < BAR_CELLS; i += 1) {
    const glyph = i < filled ? FILLED : EMPTY;
    if (theme !== undefined && i < filled) {
      // colored fill: gradient while healthy, warning ≥75%, error ≥90%
      if (ratio >= CRITICAL_RATIO) cells += theme.error(glyph);
      else if (ratio >= WARN_RATIO) cells += theme.warning(glyph);
      else cells += theme.gradientAt(glyph, i, BAR_CELLS);
    } else {
      cells += theme !== undefined && i >= filled ? theme.dim(glyph) : glyph;
    }
  }
  const pct = `${Math.round(ratio * 100)}%`;
  const nums = `${formatCount(BigInt(Math.max(0, Math.round(used))))}/${formatCount(BigInt(total))}`;
  return `ctx ${cells} ${pct} · ${nums}`;
}

/**
 * The pulse suffix for the animated critical bar: one of `frame` frames,
 * caller animates by advancing frames. Plain at level 0.
 */
export const PULSE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

/** Animated critical line: bar + pulsing "compacting soon" marker. */
export function compactBarFor(
  used: number,
  frame: number,
  opts: ContextBarOptions = {},
  theme?: ContextBarTheme,
): string {
  const base = contextBar(used, opts, theme);
  const spinner = PULSE_FRAMES[frame % PULSE_FRAMES.length]!;
  const label = ' compaction threshold';
  return `${base} ${theme !== undefined ? theme.error(spinner + label) : spinner + label}`;
}
