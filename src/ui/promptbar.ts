import stringWidth from 'string-width';
import { sanitizeTerminalText } from './terminal-text.js';

/** Compatibility only: the raw editor never uses the readline paste protocol. */
export const PASTE_NEWLINE_MARKER = '⁣';
export function encodePromptPaste(text: string): string {
  return normalizePromptPaste(text).replace(/\n/g, PASTE_NEWLINE_MARKER);
}
export function restorePromptPaste(text: string): string {
  return text.replaceAll(PASTE_NEWLINE_MARKER, '\n');
}

export interface PromptBufferState {
  value: string;
  /** UTF-16 offset, always at an extended grapheme boundary. */
  cursor: number;
}

export function normalizePromptPaste(text: string): string {
  // The sanitizer deliberately strips CR: normalize BEFORE applying it.
  return sanitizeTerminalText(text.replace(/\r\n?/g, '\n'));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function promptGraphemes(value: string): { segment: string; index: number }[] {
  return Array.from(segmenter.segment(value), ({ segment, index }) => ({ segment, index }));
}

function boundary(value: string, offset: number, forward = false): number {
  const wanted = Math.max(0, Math.min(Math.floor(offset), value.length));
  for (const { segment, index } of promptGraphemes(value)) {
    if (wanted > index && wanted < index + segment.length) {
      return forward ? index + segment.length : index;
    }
  }
  return wanted;
}

function cellWidth(segment: string, column: number): number {
  return segment === '\t' ? 4 - (column % 4) : stringWidth(segment);
}

/** An owned multiline editor; offsets stay compatible with readline consumers. */
export class PromptBuffer {
  private value = '';
  private cursor = 0;
  private preferredColumn: number | undefined;

  constructor(initial = '') {
    this.setValue(initial);
  }

  state(): PromptBufferState {
    return { value: this.value, cursor: this.cursor };
  }

  setValue(value: string, cursor = value.length): void {
    // Map offsets through CRLF normalization and control removal as well.
    const prefix = normalizePromptPaste(value.slice(0, Math.max(0, Math.min(cursor, value.length))));
    this.value = normalizePromptPaste(value);
    this.cursor = boundary(this.value, prefix.length);
    this.preferredColumn = undefined;
  }

  insert(text: string): void {
    const safe = normalizePromptPaste(text);
    this.value = this.value.slice(0, this.cursor) + safe + this.value.slice(this.cursor);
    this.cursor = boundary(this.value, this.cursor + safe.length, true);
    this.preferredColumn = undefined;
  }

  private replace(start: number, end: number): void {
    this.value = this.value.slice(0, start) + this.value.slice(end);
    this.cursor = boundary(this.value, start);
    this.preferredColumn = undefined;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    const end = this.cursor;
    this.moveLeft();
    this.replace(this.cursor, end);
  }

  deleteForward(): void {
    if (this.cursor === this.value.length) return;
    const start = this.cursor;
    this.moveRight();
    this.replace(start, this.cursor);
  }

  moveLeft(): void {
    const previous = promptGraphemes(this.value).filter((g) => g.index < this.cursor).at(-1);
    this.cursor = previous?.index ?? 0;
    this.preferredColumn = undefined;
  }

  moveRight(): void {
    const next = promptGraphemes(this.value).find((g) => g.index >= this.cursor);
    this.cursor = next === undefined ? this.value.length : next.index + next.segment.length;
    this.preferredColumn = undefined;
  }

  moveHome(): void {
    this.cursor = this.cursor === 0 ? 0 : this.value.lastIndexOf('\n', this.cursor - 1) + 1;
    this.preferredColumn = undefined;
  }

  moveEnd(): void {
    const end = this.value.indexOf('\n', this.cursor);
    this.cursor = end === -1 ? this.value.length : end;
    this.preferredColumn = undefined;
  }

  moveStart(): void {
    this.cursor = 0;
    this.preferredColumn = undefined;
  }

  moveFinish(): void {
    this.cursor = this.value.length;
    this.preferredColumn = undefined;
  }

  moveWordLeft(): void {
    const units = promptGraphemes(this.value).filter((g) => g.index < this.cursor);
    while (units.length > 0 && /^\s+$/u.test(units.at(-1)!.segment)) units.pop();
    const word = units.at(-1);
    if (word === undefined) {
      this.moveStart();
      return;
    }
    const kind = /[\p{L}\p{N}_]/u.test(word.segment);
    while (units.length > 0) {
      const last = units.at(-1)!;
      if (/^\s+$/u.test(last.segment) || /[\p{L}\p{N}_]/u.test(last.segment) !== kind) break;
      this.cursor = last.index;
      units.pop();
    }
    this.preferredColumn = undefined;
  }

  moveWordRight(): void {
    const units = promptGraphemes(this.value).filter((g) => g.index >= this.cursor);
    let i = 0;
    while (i < units.length && /^\s+$/u.test(units[i]!.segment)) i += 1;
    const word = units[i];
    if (word === undefined) {
      this.moveFinish();
      return;
    }
    const kind = /[\p{L}\p{N}_]/u.test(word.segment);
    while (i < units.length) {
      const unit = units[i]!;
      if (/^\s+$/u.test(unit.segment) || /[\p{L}\p{N}_]/u.test(unit.segment) !== kind) break;
      this.cursor = unit.index + unit.segment.length;
      i += 1;
    }
    this.preferredColumn = undefined;
  }

  deleteWordBackward(): void {
    const end = this.cursor;
    this.moveWordLeft();
    this.replace(this.cursor, end);
  }

  deleteWordForward(): void {
    const start = this.cursor;
    this.moveWordRight();
    this.replace(start, this.cursor);
  }

  deleteToHome(): void {
    const end = this.cursor;
    this.moveHome();
    this.replace(this.cursor, end);
  }

  deleteToEnd(): void {
    const start = this.cursor;
    this.moveEnd();
    this.replace(start, this.cursor);
  }

  /** Logical-row motion. False means the caller may browse history instead. */
  moveVertical(delta: -1 | 1): boolean {
    const start = this.cursor === 0 ? 0 : this.value.lastIndexOf('\n', this.cursor - 1) + 1;
    const foundEnd = this.value.indexOf('\n', this.cursor);
    const end = foundEnd === -1 ? this.value.length : foundEnd;
    if ((delta === -1 && start === 0) || (delta === 1 && end === this.value.length)) return false;
    if (this.preferredColumn === undefined) {
      this.preferredColumn = 0;
      for (const g of promptGraphemes(this.value.slice(start, this.cursor))) {
        this.preferredColumn += cellWidth(g.segment, this.preferredColumn);
      }
    }
    const targetStart = delta === -1 ? (start <= 1 ? 0 : this.value.lastIndexOf('\n', start - 2) + 1) : end + 1;
    const targetEnd = delta === -1 ? start - 1 : this.value.indexOf('\n', targetStart);
    const logical = this.value.slice(targetStart, targetEnd === -1 ? undefined : targetEnd);
    let column = 0;
    this.cursor = targetStart;
    for (const g of promptGraphemes(logical)) {
      const width = cellWidth(g.segment, column);
      if (column + width > this.preferredColumn) break;
      column += width;
      this.cursor = targetStart + g.index + g.segment.length;
    }
    return true;
  }

  submit(): string {
    const submitted = this.value;
    this.value = '';
    this.cursor = 0;
    this.preferredColumn = undefined;
    return submitted;
  }
}

export interface PromptLayout {
  lines: string[];
  cursor: { row: number; col: number };
}

/** Wrap whole graphemes; tabs use deterministic four-cell stops. */
export function layoutPromptValue(value: string, width: number, cursor = value.length): PromptLayout {
  const text = normalizePromptPaste(value);
  const max = Math.max(1, Math.floor(width));
  const at = boundary(text, normalizePromptPaste(value.slice(0, cursor)).length);
  const lines: string[] = [];
  let row = '';
  let col = 0;
  let position = { row: 0, col: 0 };
  for (const g of promptGraphemes(text)) {
    if (g.segment === '\n') {
      if (g.index === at) position = { row: lines.length, col };
      lines.push(row);
      row = '';
      col = 0;
      continue;
    }
    let size = cellWidth(g.segment, col);
    if (row !== '' && col + size > max) {
      lines.push(row);
      row = '';
      col = 0;
      size = cellWidth(g.segment, col);
    }
    if (g.index === at) position = { row: lines.length, col };
    row += g.segment === '\t' ? ' '.repeat(size) : g.segment;
    col += size;
  }
  if (at === text.length) position = { row: lines.length, col };
  lines.push(row);
  return { lines, cursor: position };
}

export function wrapPromptValue(value: string, width: number): string[] {
  return layoutPromptValue(value, width).lines;
}
