import stringWidth from 'string-width';
import { promptGraphemes } from './promptbar.js';
import { sanitizeTerminalText } from './terminal-text.js';

export interface TerminalFrame {
  lines: string[];
  cursor: { row: number; col: number };
}
export interface TerminalSurfaceDeps {
  write: (text: string) => void;
  cols: () => number;
  rows: () => number;
}

/** Keep SGR styling, never layout/OSC controls, and never cut a grapheme or escape. */
export function clipSurfaceLine(text: string, width: number): string {
  const limit = Math.max(0, Math.floor(width));
  const parts = text.split(new RegExp(`(${String.fromCharCode(27)}\\[[0-9;:]*m)`, 'g'));
  let out = '';
  let cells = 0;
  let styled = false;
  for (const part of parts) {
    if (new RegExp(`^${String.fromCharCode(27)}\\[[0-9;:]*m$`).test(part)) {
      out += part;
      styled = true;
      continue;
    }
    for (const { segment } of promptGraphemes(sanitizeTerminalText(part).replace(/[\n\t]/g, ' '))) {
      const size = stringWidth(segment);
      if (cells + size > limit) return out + (styled ? '\x1b[0m' : '');
      out += segment;
      cells += size;
    }
  }
  return out + (styled ? '\x1b[0m' : '');
}

const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const up = (n: number): string => (n > 0 ? `\x1b[${n}A` : '');
const down = (n: number): string => (n > 0 ? `\x1b[${n}B` : '');

/**
 * A bounded inline tail of the native terminal, not a screen application.
 * Between writes the cursor rests at the prompt cursor (or the last live row).
 * New rows are reserved with ordinary newlines; committed output only scrolls
 * forward. No alternate screen, scroll-region changes, or screen erase.
 * The caller decides whether this surface is enabled.
 */
export class TerminalSurface {
  private promptFrame: TerminalFrame | undefined;
  private live: string[] = [];
  private drawn = 0;
  private cursorRow = 0;
  private suspended = false;
  private disposed = false;

  constructor(private readonly deps: TerminalSurfaceDeps) {}

  setPrompt(frame: TerminalFrame | undefined): void {
    if (this.disposed) return;
    this.promptFrame = frame === undefined ? undefined : { lines: [...frame.lines], cursor: { ...frame.cursor } };
    this.redraw();
  }

  setLive(lines: string[]): void {
    if (this.disposed) return;
    this.live = [...lines];
    this.redraw();
  }

  commitLive(): void {
    if (this.disposed || this.live.length === 0) return;
    const text = this.live.map((line) => clipSurfaceLine(line, this.width())).join('\r\n') + '\r\n';
    this.live = [];
    this.output(text);
  }

  writeOutput(text: string): void {
    if (this.disposed || text === '') return;
    // Output is append-only; streaming fragments belong in setLive instead.
    const normalized = text.replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
    this.output(normalized.endsWith('\r\n') ? normalized : normalized + '\r\n');
  }

  /** Raw terminal modes for the input owner, without adding transcript rows. */
  writeControl(text: string): void {
    if (!this.disposed && text !== '') this.deps.write(text);
  }

  resize(): void {
    if (this.disposed) return;
    // Never reach outside the dynamic viewport after a height reduction.
    this.drawn = Math.min(this.drawn, this.limit());
    this.cursorRow = Math.min(this.cursorRow, Math.max(0, this.drawn - 1));
    this.redraw();
  }

  suspend(): void {
    if (this.disposed || this.suspended) return;
    const out = this.erase();
    this.suspended = true;
    this.flush(out);
  }

  resume(): void {
    if (this.disposed || !this.suspended) return;
    this.suspended = false;
    this.redraw();
  }

  dispose(): void {
    if (this.disposed) return;
    const out = this.erase();
    this.disposed = true;
    this.promptFrame = undefined;
    this.live = [];
    this.flush(out);
  }

  private width(): number {
    return Math.max(0, Math.floor(this.deps.cols()) - 1);
  }

  private limit(): number {
    return Math.max(0, Math.floor(this.deps.rows()) - 2);
  }

  private frame(): TerminalFrame {
    const max = this.limit();
    const width = this.width();
    const prompt = this.promptFrame;
    const promptLength = Math.min(prompt?.lines.length ?? 0, max);
    // If an external prompt exceeds the viewport, retain its cursor row.
    const wanted = Math.max(0, Math.min(prompt?.cursor.row ?? 0, (prompt?.lines.length ?? 1) - 1));
    const start = Math.max(0, Math.min(wanted - promptLength + 1, (prompt?.lines.length ?? 0) - promptLength));
    const promptLines = prompt?.lines.slice(start, start + promptLength) ?? [];
    const live = this.live.slice(-Math.max(0, max - promptLength));
    // slice(-0) is slice(0), so explicitly omit live when there is no room.
    const liveLines = max === promptLength ? [] : live;
    const lines = [...liveLines, ...promptLines].map((line) => clipSurfaceLine(line, width));
    return {
      lines,
      cursor: promptLength > 0
        ? { row: liveLines.length + wanted - start, col: Math.max(0, Math.min(prompt!.cursor.col, width)) }
        : { row: Math.max(0, lines.length - 1), col: 0 },
    };
  }

  /** Erase only rows we own, returning to their first row. */
  private erase(): string {
    if (this.drawn === 0) return '';
    let out = up(this.cursorRow) + '\r';
    for (let i = 0; i < this.drawn; i += 1) {
      out += '\x1b[2K';
      if (i < this.drawn - 1) out += down(1) + '\r';
    }
    out += up(this.drawn - 1) + '\r';
    this.drawn = 0;
    this.cursorRow = 0;
    return out;
  }

  private paint(): string {
    const frame = this.frame();
    const next = frame.lines.length;
    if (next === 0 && this.drawn === 0) return '';
    let out = up(this.cursorRow) + '\r';
    const span = Math.max(next, this.drawn);
    // Reserve before painting: bottom-edge scrolling preserves relative anchors.
    if (next > this.drawn) {
      const existing = Math.max(1, this.drawn);
      out += down(existing - 1) + '\r\n'.repeat(next - existing) + up(next - 1) + '\r';
    }
    for (let i = 0; i < span; i += 1) {
      out += '\x1b[2K' + (frame.lines[i] ?? '');
      if (i < span - 1) out += down(1) + '\r';
    }
    const target = next === 0 ? 0 : frame.cursor.row;
    out += up(span - 1 - target) + '\r';
    if (next > 0 && frame.cursor.col > 0) out += `\x1b[${frame.cursor.col}C`;
    this.drawn = next;
    this.cursorRow = target;
    return out;
  }

  private flush(text: string): void {
    if (text !== '') this.deps.write(SYNC_START + text + SYNC_END);
  }

  private redraw(): void {
    if (!this.suspended) this.flush(this.paint());
  }

  private output(text: string): void {
    const out = this.erase() + text;
    this.flush(out + (this.suspended ? '' : this.paint()));
  }
}
