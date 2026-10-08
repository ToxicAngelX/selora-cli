import stringWidth from 'string-width';

/**
 * Remove terminal control sequences from untrusted text before it reaches a
 * terminal. Newlines and tabs remain useful layout characters; carriage returns,
 * C0/C1 controls, OSC/CSI sequences, and bidi overrides do not.
 */
export function sanitizeTerminalText(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code === 0x1b) {
      const next = value.charCodeAt(i + 1);
      if (next === 0x5b) {
        // CSI: consume through the final byte (0x40–0x7e).
        i += 2;
        while (i < value.length) {
          const final = value.charCodeAt(i);
          if (final >= 0x40 && final <= 0x7e) break;
          i += 1;
        }
      } else if (next === 0x5d) {
        // OSC: consume through BEL or ST (ESC \\).
        i += 2;
        while (i < value.length) {
          const current = value.charCodeAt(i);
          if (current === 0x07) break;
          if (current === 0x1b && value.charCodeAt(i + 1) === 0x5c) {
            i += 1;
            break;
          }
          i += 1;
        }
      } else if (i + 1 < value.length) {
        // Other two-byte escape sequence.
        i += 1;
      }
      continue;
    }
    if (code === 0x09 || code === 0x0a) {
      out += value[i]!;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) continue;
    if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f
    ) {
      continue;
    }
    out += value[i]!;
  }
  return out;
}

/** Display-cell width of untrusted terminal text. */
export function terminalTextWidth(value: string): number {
  return stringWidth(sanitizeTerminalText(value));
}

/**
 * Truncate text by terminal cells without splitting a wide glyph. The ellipsis
 * is included in the requested width.
 */
export function truncateTerminalText(value: string, maxWidth: number): string {
  const text = sanitizeTerminalText(value);
  const max = Math.max(0, Math.floor(maxWidth));
  if (max === 0) return '';
  if (stringWidth(text) <= max) return text;
  if (max === 1) return '…';
  let out = '';
  let width = 0;
  for (const ch of text) {
    const chWidth = stringWidth(ch);
    if (width + chWidth > max - 1) break;
    out += ch;
    width += chWidth;
  }
  return `${out}…`;
}
