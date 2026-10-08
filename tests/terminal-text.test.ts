import { describe, expect, it } from 'vitest';
import {
  sanitizeTerminalText,
  TerminalTextSanitizer,
  terminalTextWidth,
  truncateTerminalText,
} from '../src/ui/terminal-text.js';

const ESC = String.fromCharCode(27);

describe('terminal text safety', () => {
  it('keeps split escape strings private and preserves CR/CRLF line boundaries', () => {
    const sanitizer = new TerminalTextSanitizer();
    const chunks = [
      'safe\r',
      '\nnext\rrow' + ESC,
      '[31',
      'mred' + ESC + 'Ppayload',
      ESC,
      '\\end\r',
    ];
    expect(chunks.map((chunk) => sanitizer.push(chunk)).join('') + sanitizer.flush()).toBe(
      'safe\nnext\nrowredend\n',
    );
    expect(sanitizer.flush()).toBe('');
  });
  it('removes CSI, OSC, C0, C1, and bidi control sequences while preserving layout', () => {
    const value = `ok${ESC}[31m red${ESC}[0m${ESC}]8;;https://evil.test${String.fromCharCode(7)}\nnext\tline‮.txt`;
    expect(sanitizeTerminalText(value)).toBe('ok red\nnext\tline.txt');
  });

  it('removes all string controls, C1 equivalents, and split terminators at every boundary', () => {
    const strings = [
      `${ESC}]title\u0007`,
      `${ESC}Ppayload${ESC}\\`,
      `${ESC}_payload${ESC}\\`,
      `${ESC}^payload${ESC}\\`,
      `${ESC}Xpayload${ESC}\\`,
      '\u009b2J',
      '\u009dtitle\u009c',
      '\u0090payload\u009c',
      '\u009fpayload\u009c',
      '\u009epayload\u009c',
      `${ESC}_payload${ESC}\u009c`,
    ];
    for (const control of strings) {
      const value = `before${control}after`;
      for (let split = 0; split <= value.length; split += 1) {
        const sanitizer = new TerminalTextSanitizer();
        expect(
          sanitizer.push(value.slice(0, split)) +
            sanitizer.push(value.slice(split)) +
            sanitizer.flush(),
        ).toBe('beforeafter');
      }
    }
  });

  it('drops incomplete strings on flush and reset without poisoning the next stream', () => {
    const sanitizer = new TerminalTextSanitizer();
    expect(sanitizer.push(`ok${ESC}]52;SECRET`)).toBe('ok');
    expect(sanitizer.flush()).toBe('');
    expect(sanitizer.push('new')).toBe('new');
    sanitizer.push(`\r${ESC}PSECRET`);
    sanitizer.reset();
    expect(sanitizer.push('clean')).toBe('clean');
    expect(sanitizeTerminalText('a\rb\r\nc\r')).toBe('a\nb\nc\n');
    expect(sanitizeTerminalText('a؜b‎c⁨d⁩')).toBe('abcd');
  });

  it('truncates grapheme clusters, not their component code points', () => {
    expect(truncateTerminalText('👨‍👩‍👧‍👦xyz', 3)).toBe('👨‍👩‍👧‍👦…');
    expect(truncateTerminalText('🇨🇦xyz', 3)).toBe('🇨🇦…');
    expect(truncateTerminalText('éxyz', 2)).toBe('é…');
    expect(truncateTerminalText('1️⃣xyz', 3)).toBe('1️⃣…');
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
