/**
 * Terminal Markdown rendering (v0.3) for the agent chat view.
 *
 * Supports the per-line subset the gateway actually emits: ATX headings
 * (#..###### — levels 1-3 styled as headings, 4+ as bold paragraphs), bold
 * **x** / __x__, italic *x* / _x_, inline `code` (contents verbatim — markup
 * inside is never styled), nested bullet lists (-, *, + and ordered `N.`),
 * fenced code blocks (``` or ~~~, closed only by the same character; the
 * first word after the opening fence is the language label and the contents
 * pass through verbatim), thematic breaks (--- / ***), blockquotes (> ),
 * and blank-line paragraph separation (runs of blank lines collapse to one).
 * Inline styles never span lines; unmatched delimiters render literally.
 *
 * All decoration goes through an injected MarkdownStyle, so this module is
 * pure and theme-agnostic. plainMarkdownStyle() is the colorless default:
 * bullets render as '•' (ordered markers keep their number), inline code
 * keeps its backticks, and code blocks use the ╭─╮ box with the language
 * embedded in the top border.
 *
 * renderMarkdown() renders a complete document; MarkdownStream renders the
 * same subset incrementally — every completed line renders immediately,
 * while code-block interiors buffer until the fence closes (or flush()), so
 * a boxed block is always delivered as a unit. Deltas may split a line
 * anywhere, including mid-marker: nothing is styled until the line
 * completes. Nothing here throws.
 */

import { sanitizeTerminalText } from './terminal-text.js';

export interface MarkdownStyle {
  /** ATX heading, level 1-3. */
  heading(text: string, level: number): string;
  bold(text: string): string;
  italic(text: string): string;
  /** Inline code — contents are verbatim (markup inside was NOT parsed). */
  code(text: string): string;
  /** One bullet line; `marker` is the source marker ('-', '*', '+' or the ordered number). */
  bullet(marker: string, text: string, indent: number): string;
  /** Full boxed code block, always >= 1 content line; `lang` may be ''. */
  codeBlock(lines: readonly string[], lang: string): readonly string[];
  paragraph(text: string): string;
  hr(): string;
  /** One blockquote line. */
  quote(text: string): string;
}

/** No-color default: '•' bullets, backticked inline code, boxed code blocks. */
export function plainMarkdownStyle(): MarkdownStyle {
  return {
    heading: (text, level) => `${'#'.repeat(level)} ${text}`,
    bold: (text) => text,
    italic: (text) => text,
    code: (text) => `\`${text}\``,
    bullet: (marker, text, indent) => {
      const markerText = /^\d+$/.test(marker) ? `${marker}. ` : '• ';
      return `${'  '.repeat(indent)}${markerText}${text}`;
    },
    codeBlock: (lines, lang) => [
      lang === '' ? '╭──────╮' : `╭─ ${lang} ───╮`,
      ...lines.map((line) => `│ ${line} │`),
      '╰────╯',
    ],
    paragraph: (text) => text,
    hr: () => '────────',
    quote: (text) => `> ${text}`,
  };
}

// --- inline styling ---------------------------------------------------------

/**
 * Index of the next *lone* occurrence of `ch` at or after `from` — one that
 * is not adjacent to another `ch` — so single-char italic delimiters never
 * grab half of a `**` / `__` pair. -1 when there is none.
 */
function findLoneClose(text: string, ch: string, from: number): number {
  for (let k = from; k < text.length; k++) {
    if (text[k] === ch && text[k - 1] !== ch && text[k + 1] !== ch) return k;
  }
  return -1;
}

/** Inline (never line-spanning) bold / italic / code. Unmatched stays literal. */
function renderInline(text: string, style: MarkdownStyle): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === undefined) break; // unreachable: i < length
    if (c === '`') {
      const close = text.indexOf('`', i + 1);
      if (close === -1) {
        out += '`';
        i += 1;
        continue;
      }
      out += style.code(text.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (c === '*' || c === '_') {
      if (text[i + 1] === c) {
        // bold attempt: **x** / __x__
        const close = text.indexOf(c + c, i + 2);
        if (close !== -1) {
          out += style.bold(renderInline(text.slice(i + 2, close), style));
          i = close + 2;
          continue;
        }
        out += c + c; // unmatched: both delimiters stay literal
        i += 2;
        continue;
      }
      // italic attempt: *x* / _x_
      const close = findLoneClose(text, c, i + 1);
      if (close !== -1) {
        out += style.italic(renderInline(text.slice(i + 1, close), style));
        i = close + 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

// --- line-level rendering ---------------------------------------------------

interface OpenFence {
  /** The fence character ('`' or '~') — only the same character can close it. */
  readonly ch: string;
  readonly lang: string;
  readonly lines: string[];
}

function countRun(text: string, ch: string): number {
  let n = 0;
  while (text[n] === ch) n++;
  return n;
}

/** The fence character a trimmed line opens with, or null. */
function fenceOpenChar(trimmed: string): string | null {
  if (trimmed.startsWith('```')) return '`';
  if (trimmed.startsWith('~~~')) return '~';
  return null;
}

/** A line closes the open fence when it is only that fence character, >= 3. */
function isFenceClose(raw: string, ch: string): boolean {
  const t = raw.trim();
  if (t.length < 3) return false;
  for (const c of t) {
    if (c !== ch) return false;
  }
  return true;
}

/**
 * Shared per-line renderer: the same state machine backs renderMarkdown()
 * and MarkdownStream, so incremental and one-shot rendering agree exactly.
 * Carries open-fence state across lines (inside-fence lines are buffered
 * verbatim, never styled) and collapses blank-line runs to one.
 */
class LineRenderer {
  private fence: OpenFence | null = null;
  private lastBlank = false;

  constructor(private readonly style: MarkdownStyle) {}

  renderLine(raw: string, out: string[]): void {
    if (this.fence !== null) {
      if (isFenceClose(raw, this.fence.ch)) {
        this.emitFence(out);
      } else {
        this.fence.lines.push(raw);
      }
      return;
    }
    const t = raw.trim();
    if (t === '') {
      if (!this.lastBlank) {
        out.push('');
        this.lastBlank = true;
      }
      return;
    }
    this.lastBlank = false;

    const fenceCh = fenceOpenChar(t);
    if (fenceCh !== null) {
      const rest = t.slice(countRun(t, fenceCh)).trim();
      const lang = rest === '' ? '' : (rest.split(/[ \t]+/)[0] ?? '');
      this.fence = { ch: fenceCh, lang, lines: [] };
      return;
    }

    const heading = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(raw);
    if (heading !== null) {
      const level = heading[1]!.length;
      const content = heading[2] ?? '';
      if (level <= 3) {
        out.push(this.style.heading(renderInline(content, this.style), level));
      } else {
        out.push(this.style.paragraph(this.style.bold(renderInline(content, this.style))));
      }
      return;
    }

    if (/^-{3,}$/.test(t) || /^\*{3,}$/.test(t)) {
      out.push(this.style.hr());
      return;
    }

    const bullet = /^([ \t]*)([-*+])[ \t]+(.*)$/.exec(raw);
    if (bullet !== null) {
      const indent = Math.floor(bullet[1]!.length / 2);
      out.push(this.style.bullet(bullet[2]!, renderInline(bullet[3]!, this.style), indent));
      return;
    }

    const ordered = /^([ \t]*)(\d+)\.[ \t]+(.*)$/.exec(raw);
    if (ordered !== null) {
      const indent = Math.floor(ordered[1]!.length / 2);
      out.push(this.style.bullet(ordered[2]!, renderInline(ordered[3]!, this.style), indent));
      return;
    }

    const quote = /^>[ \t]?(.*)$/.exec(raw);
    if (quote !== null) {
      out.push(this.style.quote(renderInline(quote[1]!, this.style)));
      return;
    }

    out.push(this.style.paragraph(renderInline(raw, this.style)));
  }

  /** Render an open fence gracefully (close without a closing marker). */
  flushOpenFence(out: string[]): void {
    if (this.fence !== null) this.emitFence(out);
  }

  private emitFence(out: string[]): void {
    const fence = this.fence;
    this.fence = null;
    this.lastBlank = false;
    // codeBlock promises >= 1 content line; an empty fence renders one blank line.
    const lines = fence !== null && fence.lines.length > 0 ? fence.lines : [''];
    out.push(...this.style.codeBlock(lines, fence?.lang ?? ''));
  }
}

/**
 * Render a complete Markdown document to '\n'-joined styled lines. A
 * trailing '\n' does not produce a trailing blank output line; an unclosed
 * code fence is closed gracefully at end of input.
 */
export function renderMarkdown(text: string, style: MarkdownStyle): string {
  const renderer = new LineRenderer(style);
  const out: string[] = [];
  const parts = sanitizeTerminalText(text).split('\n');
  if (text.endsWith('\n') && parts.length > 0) parts.pop();
  for (const line of parts) {
    renderer.renderLine(line, out);
  }
  renderer.flushOpenFence(out);
  return out.join('\n');
}

/**
 * Incremental Markdown renderer. push() returns the newly completed
 * rendered lines ('\n'-joined, '' when none); code-block interiors are
 * held back until the fence closes, so boxed blocks arrive as a unit.
 * flush() renders any trailing partial line and closes an unclosed fence.
 */
export class MarkdownStream {
  private buffer = '';
  private readonly renderer: LineRenderer;

  constructor(style: MarkdownStyle) {
    this.renderer = new LineRenderer(style);
  }

  push(delta: string): string {
    this.buffer += sanitizeTerminalText(delta);
    const out: string[] = [];
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      this.renderer.renderLine(line, out);
      nl = this.buffer.indexOf('\n');
    }
    return out.length > 0 ? out.join('\n') : '';
  }

  flush(): string {
    this.buffer = sanitizeTerminalText(this.buffer);
    const out: string[] = [];
    if (this.buffer !== '') {
      const line = this.buffer;
      this.buffer = '';
      this.renderer.renderLine(line, out);
    }
    this.renderer.flushOpenFence(out);
    return out.length > 0 ? out.join('\n') : '';
  }
}
