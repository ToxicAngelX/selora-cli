/**
 * Terminal renderer: monochrome (white/gray) with exactly ONE accent green
 * (truecolor 34;197;94) for ✓ lines, red ✗ for failures, gray `·` bullets,
 * hairline dividers. Respects NO_COLOR / TERM=dumb / non-TTY.
 *
 * All writers are injectable so tests can capture output. This module is the
 * only place commands write user-facing text.
 */

import { SeloraApiError } from '../api/errors.js';
import { redact } from '../api/redact.js';

export type Writer = (s: string) => void;

export interface RenderOptions {
  /** Write normal output (default: process.stdout via console.log). */
  out?: Writer;
  /** Write errors/prompts (default: process.stderr via console.error). */
  err?: Writer;
  /** Raw stdout write with NO trailing newline (streamed chat deltas). */
  rawOut?: Writer;
  /** Raw stderr write with NO trailing newline (chat prompt, streamed reasoning). */
  rawErr?: Writer;
  /** --json mode: only JSON on stdout, errors as {ok:false,...}. */
  json?: boolean;
  /** --debug: extra raw detail on errors. */
  debug?: boolean;
}

const GREEN = '\x1b[38;2;34;197;94m';
const RED = '\x1b[31m';
const GRAY = '\x1b[90m';
const RESET = '\x1b[0m';

function colorsEnabled(streamIsTTY: boolean): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['TERM'] === 'dumb') return false;
  return streamIsTTY;
}

export class Renderer {
  private readonly out: Writer;
  private readonly err: Writer;
  private readonly rawOut: Writer;
  private readonly rawErr: Writer;
  readonly json: boolean;
  readonly debug: boolean;
  private readonly outColor: boolean;
  private readonly errColor: boolean;

  constructor(opts: RenderOptions = {}) {
    this.out = opts.out ?? ((s) => process.stdout.write(`${s}\n`));
    this.err = opts.err ?? ((s) => process.stderr.write(`${s}\n`));
    this.rawOut = opts.rawOut ?? ((s) => process.stdout.write(s));
    this.rawErr = opts.rawErr ?? ((s) => process.stderr.write(s));
    this.json = opts.json === true;
    this.debug = opts.debug === true;
    this.outColor = colorsEnabled(process.stdout.isTTY === true);
    this.errColor = colorsEnabled(process.stderr.isTTY === true);
  }

  /** Green ✓ line (stdout). */
  ok(message: string): void {
    this.out(`${this.outColor ? GREEN : ''}✓${this.outColor ? RESET : ''} ${message}`);
  }

  /** Red ✗ line (stderr in human mode). */
  fail(message: string): void {
    this.err(`${this.errColor ? RED : ''}✗${this.errColor ? RESET : ''} ${message}`);
  }

  /** Gray `·` bullet line (stderr). */
  bullet(message: string): void {
    this.err(`${this.errColor ? GRAY : ''}·${this.errColor ? RESET : ''} ${message}`);
  }

  /** Plain line to stdout. */
  line(text = ''): void {
    this.out(text);
  }

  /** Hairline divider, width 40. */
  divider(): void {
    this.out(`${this.outColor ? GRAY : ''}${'─'.repeat(40)}${this.outColor ? RESET : ''}`);
  }

  /** Label/value row: gray label padded to `width` (default 12). */
  field(label: string, value: string, width = 12): void {
    const pad = label.length >= width ? '' : ' '.repeat(width - label.length);
    this.out(`${this.outColor ? GRAY : ''}${label}${pad}${this.outColor ? RESET : ''}${value}`);
  }

  /** Plain gray stdout line (table headers, secondary labels). */
  gray(text: string): void {
    this.out(`${this.outColor ? GRAY : ''}${text}${this.outColor ? RESET : ''}`);
  }

  /**
   * Plain green stdout line. Used ONLY for the one-time key-secret print in
   * `keys create` — the single deliberate exception to never-print-keys.
   */
  green(text: string): void {
    this.out(`${this.outColor ? GREEN : ''}${text}${this.outColor ? RESET : ''}`);
  }

  /** Raw stdout write — NO trailing newline. Streamed chat content deltas. */
  writeRaw(text: string): void {
    this.rawOut(text);
  }

  /** Raw gray stderr write — NO trailing newline. REPL prompt, streamed reasoning. */
  writeRawGray(text: string): void {
    this.rawErr(`${this.errColor ? GRAY : ''}${text}${this.errColor ? RESET : ''}`);
  }

  /**
   * Render a command failure and set exitCode 1. Human mode: `✗ <message>` +
   * optional `· hint` (+ indented raw detail when debug). JSON mode: a single
   * {ok:false, error:{...}} object on stdout.
   */
  renderError(err: unknown): void {
    process.exitCode = 1;
    if (this.json) {
      const error =
        err instanceof SeloraApiError
          ? err.toJson()
          : { kind: 'internal', message: 'Unexpected CLI error.', hint: '(run with --debug for details)' };
      this.out(JSON.stringify({ ok: false, error }, null, 2));
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
