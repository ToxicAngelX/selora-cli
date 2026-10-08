import stringWidth from 'string-width';

const ESC = 0x1b;
const BEL = 0x07;
const ST_C1 = 0x9c;
const CSI_C1 = 0x9b;
const OSC_C1 = 0x9d;
const DCS_C1 = 0x90;
const SOS_C1 = 0x98;
const PM_C1 = 0x9e;
const APC_C1 = 0x9f;

type ParserState = 'normal' | 'escape' | 'escapeIntermediate' | 'csi' | 'string' | 'stringEscape';
type StringKind = 'osc' | 'dcs' | 'sos' | 'pm' | 'apc';

function isBidiControl(code: number): boolean {
  return (
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c
  );
}

function isCsiFinal(code: number): boolean {
  return code >= 0x40 && code <= 0x7e;
}

/**
 * Incremental terminal-text sanitizer. Escape sequences are parsed across push()
 * calls, so a delta can never expose a partial CSI/string control to the terminal.
 * flush() drops an incomplete control and turns a pending bare CR into a newline.
 */
export class TerminalTextSanitizer {
  private state: ParserState = 'normal';
  private stringKind: StringKind | undefined;
  private pendingCr = false;

  push(value: string): string {
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
      const code = value.charCodeAt(i);

      if (this.state === 'normal') {
        if (this.pendingCr) {
          this.pendingCr = false;
          if (code === 0x0a) {
            out += '\n';
            continue;
          }
          out += '\n';
        }
        if (code === ESC) {
          this.state = 'escape';
          continue;
        }
        if (code === 0x0d) {
          this.pendingCr = true;
          continue;
        }
        if (code === 0x0a || code === 0x09) {
          out += String.fromCharCode(code);
          continue;
        }
        if (code === CSI_C1) {
          this.state = 'csi';
          continue;
        }
        if (
          code === OSC_C1 ||
          code === DCS_C1 ||
          code === SOS_C1 ||
          code === PM_C1 ||
          code === APC_C1
        ) {
          this.state = 'string';
          this.stringKind =
            code === OSC_C1
              ? 'osc'
              : code === DCS_C1
                ? 'dcs'
                : code === SOS_C1
                  ? 'sos'
                  : code === PM_C1
                    ? 'pm'
                    : 'apc';
          continue;
        }
        if (code === ST_C1 || code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
          continue;
        }
        if (isBidiControl(code)) continue;
        out += value[i]!;
        continue;
      }

      if (this.state === 'escape') {
        if (code === 0x5b) {
          this.state = 'csi';
        } else if (code === 0x5d) {
          this.state = 'string';
          this.stringKind = 'osc';
        } else if (code === 0x50) {
          this.state = 'string';
          this.stringKind = 'dcs';
        } else if (code === 0x58) {
          this.state = 'string';
          this.stringKind = 'sos';
        } else if (code === 0x5e) {
          this.state = 'string';
          this.stringKind = 'pm';
        } else if (code === 0x5f) {
          this.state = 'string';
          this.stringKind = 'apc';
        } else if (code === ESC) {
          // A repeated ESC starts a fresh escape and remains hidden.
          this.state = 'escape';
        } else if (code >= 0x20 && code <= 0x2f) {
          // Escape intermediates may be split across deltas; consume until the
          // final byte rather than treating the first intermediate as complete.
          this.state = 'escapeIntermediate';
        } else if (code >= 0x80 && code <= 0x9f) {
          this.state = 'normal';
          i -= 1;
        } else {
          // Two-byte escape sequence: both bytes are control syntax.
          this.state = 'normal';
        }
        continue;
      }

      if (this.state === 'escapeIntermediate') {
        if (code >= 0x30 && code <= 0x7e) this.state = 'normal';
        else if (code === ESC) this.state = 'escape';
        continue;
      }

      if (this.state === 'csi') {
        if (code === ESC) this.state = 'escape';
        else if (code === 0x18 || code === 0x1a || isCsiFinal(code)) this.state = 'normal';
        else if (code >= 0x80 && code <= 0x9f) {
          this.state = 'normal';
          i -= 1;
        }
        continue;
      }

      if (this.state === 'string') {
        if (code === BEL && this.stringKind === 'osc') {
          this.state = 'normal';
          this.stringKind = undefined;
        } else if (code === ST_C1) {
          this.state = 'normal';
          this.stringKind = undefined;
        } else if (code === ESC) {
          this.state = 'stringEscape';
        }
        continue;
      }

      // ESC inside a string is only a terminator when followed by '\\'.
      if (code === 0x5c || code === ST_C1) {
        this.state = 'normal';
        this.stringKind = undefined;
      } else if (code === ESC) {
        this.state = 'stringEscape';
      } else {
        this.state = 'string';
      }
    }
    return out;
  }

  flush(): string {
    let out = '';
    if (this.state === 'normal' && this.pendingCr) out = '\n';
    this.pendingCr = false;
    this.state = 'normal';
    this.stringKind = undefined;
    return out;
  }

  reset(): void {
    this.state = 'normal';
    this.stringKind = undefined;
    this.pendingCr = false;
  }
}

/** Sanitize a complete document in one call. */
export function sanitizeTerminalText(value: string): string {
  const sanitizer = new TerminalTextSanitizer();
  return sanitizer.push(value) + sanitizer.flush();
}

/** Expand tabs at terminal tab stops after sanitization. */
export function expandTerminalTabs(value: string, tabSize = 8): string {
  const size = Math.max(1, Math.floor(tabSize));
  let column = 0;
  let out = '';
  const text = sanitizeTerminalText(value);
  const Segmenter = globalThis.Intl?.Segmenter;
  const clusters = Segmenter
    ? Array.from(
        new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
        (part) => part.segment,
      )
    : Array.from(text);
  for (const ch of clusters) {
    if (ch === '\n') {
      out += ch;
      column = 0;
      continue;
    }
    if (ch === '\t') {
      const spaces = size - (column % size);
      out += ' '.repeat(spaces);
      column += spaces;
      continue;
    }
    out += ch;
    column += stringWidth(ch);
  }
  return out;
}

/** Display-cell width of untrusted terminal text. */
export function terminalTextWidth(value: string): number {
  return stringWidth(expandTerminalTabs(value));
}

/**
 * Truncate text by terminal cells without splitting a grapheme cluster. The
 * ellipsis is included in the requested width.
 */
export function truncateTerminalText(value: string, maxWidth: number): string {
  const text = expandTerminalTabs(value);
  const max = Math.max(0, Math.floor(maxWidth));
  if (max === 0) return '';
  if (stringWidth(text) <= max) return text;
  if (max === 1) return '…';
  const Segmenter = globalThis.Intl?.Segmenter;
  const segments = Segmenter
    ? Array.from(
        new Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
        (part) => part.segment,
      )
    : Array.from(text);
  let out = '';
  let width = 0;
  for (const cluster of segments) {
    const clusterWidth = stringWidth(cluster);
    if (width + clusterWidth > max - 1) break;
    out += cluster;
    width += clusterWidth;
  }
  return `${out}…`;
}
