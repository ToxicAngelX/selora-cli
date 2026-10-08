import { describe, expect, it } from 'vitest';
import {
  sanitizeTerminalText,
  terminalTextWidth,
  truncateTerminalText,
} from '../src/ui/terminal-text.js';

const ESC = String.fromCharCode(27);

describe('terminal text safety', () => {
  it('removes CSI, OSC, C0, C1, and bidi control sequences while preserving layout', () => {
    const value = `ok${ESC}[31m red${ESC}[0m${ESC}]8;;https://evil.test${String.fromCharCode(7)}\nnext\tline‮.txt`;
    expect(sanitizeTerminalText(value)).toBe('ok red\nnext\tline.txt');
  });

  it('measures terminal cells rather than UTF-16/code-point length', () => {
    expect(terminalTextWidth('界')).toBe(2);
    expect(terminalTextWidth('é')).toBe(1);
    expect(terminalTextWidth(`${ESC}[31m界${ESC}[0m`)).toBe(2);
  });

  it('truncates by cells without splitting wide glyphs', () => {
    expect(truncateTerminalText('界界', 3)).toBe('界…');
    expect(truncateTerminalText('abcdef', 4)).toBe('abc…');
    expect(truncateTerminalText('界', 1)).toBe('…');
  });
});
