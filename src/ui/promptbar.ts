import stringWidth from 'string-width';
import { sanitizeTerminalText } from './terminal-text.js';

/** Invisible placeholder used while readline holds a pasted multiline value. */
export const PASTE_NEWLINE_MARKER = '⁣';

export function encodePromptPaste(text: string): string {
  return normalizePromptPaste(text).replace(/\n/g, PASTE_NEWLINE_MARKER);
}

export function restorePromptPaste(text: string): string {
  return text.replaceAll(PASTE_NEWLINE_MARKER, '\n');
}

export interface PromptBufferState {
  value: string;
  cursor: number;
}

/** Normalize bracketed paste without turning pasted newlines into submissions. */
export function normalizePromptPaste(text: string): string {
  return sanitizeTerminalText(text).replace(/\r\n?/g, '\n');
}

/**
 * Small, deterministic line editor used by the TTY prompt seams. The REPL can
 * adapt it to readline today and move to a fully-owned renderer later without
 * changing editing semantics or tests.
 */
export class PromptBuffer {
  private value = '';
  private cursor = 0;

  constructor(initial = '') {
    this.setValue(initial);
  }

  state(): PromptBufferState {
    return { value: this.value, cursor: this.cursor };
  }

  setValue(value: string, cursor = value.length): void {
    this.value = normalizePromptPaste(value);
    this.cursor = Math.max(0, Math.min(cursor, this.value.length));
  }

  insert(text: string): void {
    const safe = normalizePromptPaste(text);
    this.value = `${this.value.slice(0, this.cursor)}${safe}${this.value.slice(this.cursor)}`;
    this.cursor += safe.length;
  }

  backspace(): void {
    if (this.cursor === 0) return;
    this.value = `${this.value.slice(0, this.cursor - 1)}${this.value.slice(this.cursor)}`;
    this.cursor -= 1;
  }

  deleteForward(): void {
    if (this.cursor >= this.value.length) return;
    this.value = `${this.value.slice(0, this.cursor)}${this.value.slice(this.cursor + 1)}`;
  }

  moveLeft(): void {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  moveRight(): void {
    this.cursor = Math.min(this.value.length, this.cursor + 1);
  }

  moveHome(): void {
    this.cursor = 0;
  }

  moveEnd(): void {
    this.cursor = this.value.length;
  }

  submit(): string {
    const submitted = this.value;
    this.value = '';
    this.cursor = 0;
    return submitted;
  }
}

/** Wrap a prompt value by terminal cells while retaining logical newlines. */
export function wrapPromptValue(value: string, width: number): string[] {
  const max = Math.max(1, Math.floor(width));
  const rows: string[] = [];
  for (const logical of normalizePromptPaste(value).split('\n')) {
    if (logical === '') {
      rows.push('');
      continue;
    }
    let row = '';
    let rowWidth = 0;
    for (const ch of logical) {
      const widthOfChar = stringWidth(ch);
      if (row !== '' && rowWidth + widthOfChar > max) {
        rows.push(row);
        row = '';
        rowWidth = 0;
      }
      row += ch;
      rowWidth += widthOfChar;
    }
    rows.push(row);
  }
  return rows;
}
