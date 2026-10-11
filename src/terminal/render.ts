/**
 * Terminal renderer: modern, sleek presentation with truecolor theme palettes
 * (Neon Violet, Electric Cyan, Mint Green, Warm Amber, Coral Red, Slate Gray),
 * rounded box panels, step indicators, cards, and badges. Respects NO_COLOR /
 * TERM=dumb / non-TTY and --json mode with 100% backward compatibility.
 *
 * All writers are injectable so tests can capture output. This module is the
 * only place commands write user-facing text.
 */

import stringWidth from 'string-width';
import { SeloraApiError } from '../api/errors.js';
import { redact } from '../api/redact.js';
import { Theme, GALAXY_PALETTE, colorLevelFor, type ColorLevel } from '../ui/theme.js';

export type Writer = (s: string) => void;

export interface RenderOptions {
  /** Write normal output (default: process.stdout via console.log). */
  out?: Writer | undefined;
  /** Write errors/prompts (default: process.stderr via console.error). */
  err?: Writer | undefined;
  /** Raw stdout write with NO trailing newline (streamed chat deltas). */
  rawOut?: Writer | undefined;
  /** Raw stderr write with NO trailing newline (chat prompt, streamed reasoning). */
  rawErr?: Writer | undefined;
  /** --json mode: only JSON on stdout, errors as {ok:false,...}. */
  json?: boolean | undefined;
  /** --debug: extra raw detail on errors. */
  debug?: boolean | undefined;
  /** Explicitly force or disable color (defaults to environment & TTY detection). */
  color?: boolean | undefined;
  /** Optional custom theme. */
  theme?: Theme | undefined;
}

/** Theme palette colors (truecolor hex). */
export const PALETTE = {
  primary: '#a855f7', // Neon Violet
  secondary: '#22d3ee', // Electric Cyan
  success: '#34d399', // Mint Green
  warning: '#fbbf24', // Warm Amber
  error: '#fb7185', // Coral Red
  slate: '#6b7280', // Slate gray
} as const;

export function resolveColor(c?: string | undefined): string {
  if (!c) return PALETTE.secondary;
  const lower = c.toLowerCase();
  if (lower === 'primary' || lower === 'violet') return PALETTE.primary;
  if (lower === 'secondary' || lower === 'cyan' || lower === 'info') return PALETTE.secondary;
  if (lower === 'success' || lower === 'green') return PALETTE.success;
  if (lower === 'warning' || lower === 'amber' || lower === 'yellow') return PALETTE.warning;
  if (lower === 'error' || lower === 'danger' || lower === 'red') return PALETTE.error;
  if (lower === 'dim' || lower === 'gray' || lower === 'slate') return PALETTE.slate;
  if (c.startsWith('#')) return c;
  return PALETTE.secondary;
}

export function colorsEnabled(streamIsTTY: boolean): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return streamIsTTY;
}

interface BoxOptions {
  title?: string | undefined;
  lines: string[];
  color?: string | undefined;
  theme: Theme;
  hasColor: boolean;
  minWidth?: number | undefined;
}

function renderBox(opts: BoxOptions): string[] {
  const { title, lines, color = PALETTE.secondary, theme, hasColor, minWidth = 14 } = opts;

  const titleLen = title ? stringWidth(title) : 0;
  let maxContentLen = 0;
  for (const line of lines) {
    const w = stringWidth(line);
    if (w > maxContentLen) maxContentLen = w;
  }

  // Inner width: visual width between '│ ' and ' │'
  const innerWidth = Math.max(maxContentLen, title ? titleLen + 4 : 0, minWidth);

  const wrapBorder = (s: string): string => (hasColor ? theme.wrap(color, s) : s);
  const _wrapTitle = (s: string): string => (hasColor ? theme.wrap(color, s, { bold: true }) : s);

  const result: string[] = [];

  // Top border
  if (title) {
    // ╭─── <title> ────...╮
    // Total outer width is innerWidth + 4:
    // '╭─── ' (5) + title (titleLen) + ' ' (1) + dashes + '╮' (1)
    // dashes = innerWidth + 4 - 7 - titleLen = innerWidth - titleLen - 3
    const rightDashes = Math.max(1, innerWidth - titleLen - 3);
    const top = wrapBorder(`╭─── ${title} ${'─'.repeat(rightDashes)}╮`);
    result.push(top);
  } else {
    const top = wrapBorder(`╭${'─'.repeat(innerWidth + 2)}╮`);
    result.push(top);
  }

  // Content lines
  for (const line of lines) {
    const lineWidth = stringWidth(line);
    const pad = Math.max(0, innerWidth - lineWidth);
    const middle = `${wrapBorder('│')} ${line}${' '.repeat(pad)} ${wrapBorder('│')}`;
    result.push(middle);
  }

  // Bottom border
  const bottom = `${wrapBorder('╰')}${wrapBorder('─'.repeat(innerWidth + 2))}${wrapBorder('╯')}`;
  result.push(bottom);

  return result;
}

export class Renderer {
  private readonly out: Writer;
  private readonly err: Writer;
  private readonly rawOut: Writer;
  private readonly rawErr: Writer;
  readonly json: boolean;
  readonly debug: boolean;
  readonly outColor: boolean;
  readonly errColor: boolean;
  readonly outTheme: Theme;
  readonly errTheme: Theme;

  constructor(opts: RenderOptions = {}) {
    this.out = opts.out ?? ((s) => process.stdout.write(`${s}\n`));
    this.err = opts.err ?? ((s) => process.stderr.write(`${s}\n`));
    this.rawOut = opts.rawOut ?? ((s) => process.stdout.write(s));
    this.rawErr = opts.rawErr ?? ((s) => process.stderr.write(s));
    this.json = opts.json === true;
    this.debug = opts.debug === true;

    if (opts.color !== undefined) {
      const allowed = process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';
      this.outColor = opts.color && allowed;
      this.errColor = opts.color && allowed;
    } else {
      this.outColor = colorsEnabled(process.stdout.isTTY === true);
      this.errColor = colorsEnabled(process.stderr.isTTY === true);
    }

    const outLevel: ColorLevel = this.outColor ? colorLevelFor(true) : 0;
    const errLevel: ColorLevel = this.errColor ? colorLevelFor(true) : 0;

    this.outTheme = opts.theme ?? new Theme(GALAXY_PALETTE, outLevel);
    this.errTheme = opts.theme ?? new Theme(GALAXY_PALETTE, errLevel);
  }

  /** Green ✓ line (stdout). */
  ok(message: string): void {
    const mark = this.outColor ? this.outTheme.success('✓') : '✓';
    this.out(`${mark} ${message}`);
  }

  /** Red ✗ line (stderr in human mode). */
  fail(message: string): void {
    const mark = this.errColor ? this.errTheme.error('✗') : '✗';
    this.err(`${mark} ${message}`);
  }

  /** Gray `·` bullet line (stderr). */
  bullet(message: string): void {
    const mark = this.errColor ? this.errTheme.dim('·') : '·';
    this.err(`${mark} ${message}`);
  }

  /** Plain line to stdout. */
  line(text = ''): void {
    this.out(text);
  }

  /** Hairline divider, width 40. */
  divider(): void {
    const line = '─'.repeat(40);
    this.out(this.outColor ? this.outTheme.dim(line) : line);
  }

  /** Label/value row: gray label padded to `width` (default 12). */
  field(label: string, value: string, width = 12): void {
    const pad = label.length >= width ? '' : ' '.repeat(width - label.length);
    const labelStr = this.outColor ? this.outTheme.dim(`${label}${pad}`) : `${label}${pad}`;
    this.out(`${labelStr}${value}`);
  }

  /** Plain gray stdout line (table headers, secondary labels). */
  gray(text: string): void {
    this.out(this.outColor ? this.outTheme.dim(text) : text);
  }

  /**
   * Plain green stdout line. Used ONLY for the one-time key-secret print in
   * `keys create` — the single deliberate exception to never-print-keys.
   */
  green(text: string): void {
    this.out(this.outColor ? this.outTheme.success(text) : text);
  }

  /** Raw stdout write — NO trailing newline. Streamed chat content deltas. */
  writeRaw(text: string): void {
    this.rawOut(text);
  }

  /** Raw gray stderr write — NO trailing newline. REPL prompt, streamed reasoning. */
  writeRawGray(text: string): void {
    this.rawErr(this.errColor ? this.errTheme.dim(text) : text);
  }

  /**
   * Render a command failure and set exitCode 1. Human mode:
   * When colors are enabled: a sleek rounded error box in coral red.
   * When colors are disabled: plain `✗ <message>` + optional `· <hint>`.
   * Indented raw detail is printed on stderr when debug is active.
   * JSON mode: a single {ok:false, error:{...}} object on stdout.
   */
  renderError(err: unknown): void {
    process.exitCode = 1;
    if (this.json) {
      const error =
        err instanceof SeloraApiError
          ? err.toJson()
          : {
              kind: 'internal',
              message: 'Unexpected CLI error.',
              hint: '(run with --debug for details)',
            };
      this.out(JSON.stringify({ ok: false, error }, null, 2));
      if (this.debug) this.debugDetail(err);
      return;
    }

    const message = err instanceof SeloraApiError ? err.message : 'Unexpected CLI error.';
    const hint = err instanceof SeloraApiError ? err.hint : '(run with --debug for details)';

    if (this.errColor) {
      const msgParts = message.split('\n');
      const lines: string[] = [
        this.errTheme.error(`✗ ${msgParts[0]}`),
        ...msgParts.slice(1).map((p) => `  ${p}`),
      ];
      if (hint !== undefined) {
        const hintParts = hint.split('\n');
        lines.push(
          this.errTheme.dim(`· ${hintParts[0]}`),
          ...hintParts.slice(1).map((p) => `  ${p}`),
        );
      }

      const box = renderBox({
        title: 'Error',
        lines,
        color: PALETTE.error,
        theme: this.errTheme,
        hasColor: true,
        minWidth: 11,
      });

      for (const line of box) {
        this.err(line);
      }
      if (this.debug) this.debugDetail(err);
      return;
    }

    if (err instanceof SeloraApiError) {
      this.fail(err.message);
      if (err.hint !== undefined) this.bullet(err.hint);
      if (this.debug) this.debugDetail(err);
      return;
    }

    this.fail('Unexpected CLI error.');
    this.bullet('(run with --debug for details)');
    if (this.debug) this.debugDetail(err);
  }

  /**
   * Render a sleek rounded card containing structured key-value pairs to stdout.
   */
  card(title: string, fields: [string, string][]): void {
    const hasColor = this.outColor;
    const theme = this.outTheme;

    let maxLabelWidth = 0;
    for (const [k] of fields) {
      const w = stringWidth(k);
      if (w > maxLabelWidth) maxLabelWidth = w;
    }
    const labelWidth = Math.max(10, maxLabelWidth);

    const lines: string[] = [];
    for (const [k, v] of fields) {
      const pad = ' '.repeat(Math.max(0, labelWidth - stringWidth(k)));
      const labelStr = hasColor ? theme.dim(`${k}${pad}`) : `${k}${pad}`;
      lines.push(`  ${labelStr}  ${v}`);
    }

    const box = renderBox({
      title,
      lines: lines.length > 0 ? lines : [''],
      color: PALETTE.primary,
      theme,
      hasColor,
      minWidth: 32,
    });

    for (const line of box) {
      this.out(line);
    }
  }

  /**
   * Render a rounded bordered panel with a title and content.
   */
  panel(
    title: string,
    content: string | string[],
    color?: 'error' | 'warning' | 'success' | 'info' | 'dim',
  ): void {
    const isError = color === 'error';
    const write = isError ? this.err : this.out;
    const hasColor = isError ? this.errColor : this.outColor;
    const theme = isError ? this.errTheme : this.outTheme;
    const hex = resolveColor(color);

    const rawLines = Array.isArray(content) ? content : content.split('\n');
    const lines: string[] = [];
    for (const l of rawLines) {
      lines.push(...l.split('\n'));
    }

    const box = renderBox({
      ...(title ? { title } : {}),
      lines: lines.length > 0 ? lines : [''],
      color: hex,
      theme,
      hasColor,
    });

    for (const line of box) {
      write(line);
    }
  }

  /**
   * Render a step progress line: done (✓), running (●), failed (✗), or pending (○).
   */
  step(status: 'done' | 'running' | 'failed' | 'pending', label: string, detail?: string): void {
    const hasColor = this.outColor;
    const theme = this.outTheme;

    let symbol: string;
    switch (status) {
      case 'done':
        symbol = hasColor ? theme.success('✓') : '✓';
        break;
      case 'running':
        symbol = hasColor ? theme.cyan('●') : '●';
        break;
      case 'failed':
        symbol = hasColor ? theme.error('✗') : '✗';
        break;
      case 'pending':
        symbol = hasColor ? theme.dim('○') : '○';
        break;
    }

    const detailStr =
      detail !== undefined ? ` ${hasColor ? theme.dim(`(${detail})`) : `(${detail})`}` : '';
    this.out(`${symbol} ${label}${detailStr}`);
  }

  /**
   * Format a badge string [LABEL] in the given theme color.
   */
  badge(label: string, color?: string): string {
    if (!this.outColor) {
      return `[${label}]`;
    }
    const hex = resolveColor(color);
    return this.outTheme.wrap(hex, `[${label}]`, { bold: true });
  }

  private debugDetail(err: unknown): void {
    if (!(err instanceof SeloraApiError)) {
      const detail = redact(err instanceof Error ? String(err.stack ?? err.message) : String(err));
      this.err(`    ${detail.split('\n').join('\n    ')}`);
      return;
    }
    const parts: string[] = [];
    parts.push(`kind: ${err.kind}`);
    if (err.status !== undefined) parts.push(`status: ${err.status}`);
    if (err.reqId !== undefined) parts.push(`request_id: ${err.reqId}`);
    if (err.body !== undefined) parts.push(`body: ${redact(err.body)}`);
    if (err.apiMessage !== undefined) parts.push(`api_message: ${redact(err.apiMessage)}`);
    this.err(`    ${parts.join('\n    ')}`);
  }

  /** JSON success envelope: ONLY the JSON object on stdout, 2-space pretty. */
  jsonOut(value: unknown): void {
    this.out(JSON.stringify(value, null, 2));
  }
}
