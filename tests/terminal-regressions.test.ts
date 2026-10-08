import { describe, expect, it } from 'vitest';
import { MarkdownStream, plainMarkdownStyle, renderMarkdown } from '../src/ui/markdown.js';
import { markdownStyleFor, renderToolStart, toolDisplayName } from '../src/ui/chatui.js';
import { themeFor } from '../src/ui/theme.js';
import { terminalTextWidth } from '../src/ui/terminal-text.js';

const ESC = String.fromCharCode(27);
const mono = themeFor('mono', false, {});

describe('terminal rendering regressions at public seams', () => {
  it('keeps split terminal commands hidden in markdown without deduplicating repeated content', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    const chunks = ['hello\n', 'hello\n', ESC, ']52;c;PRIVATE', ESC, '\\good\r', '\nend'];
    const rendered = chunks.map((chunk) => stream.push(chunk)).filter(Boolean);
    rendered.push(stream.flush());
    expect(rendered.join('\n')).toBe('hello\nhello\ngood\nend');
  });

  it('preserves ordered-list numbers using the theme adapter', () => {
    expect(renderMarkdown('12. First\n13. Second', markdownStyleFor(mono, 40))).toBe(
      '12. First\n13. Second',
    );
  });

  it.each([1, 3, 6, 9, 20, 80, 140])('bounds all code-box rows to terminal width %i', (columns) => {
    const rows = markdownStyleFor(mono, columns).codeBlock(
      ['界'.repeat(70), 'a\tb', '👨‍👩‍👧‍👦'],
      'a-very-long-language',
    );
    expect(rows.every((row) => terminalTextWidth(row) <= Math.min(columns, 80))).toBe(true);
    expect(rows.every((row) => !row.includes('\t'))).toBe(true);
    if (columns >= 9) expect(new Set(rows.map(terminalTextWidth)).size).toBe(1);
  });

  it('treats prototype-property tool names as ordinary sanitized text', () => {
    expect(toolDisplayName('toString')).toBe('ToString');
    expect(toolDisplayName('__proto__')).toBe('__proto__');
    expect(
      renderToolStart(
        `${ESC}[31mread_file`,
        `${ESC}[31mread_file(safe${ESC}]0;SECRET\u0007.txt)`,
        mono,
      ),
    ).toBe('● Read(safe.txt)');
  });

  it('makes streamed and complete markdown agree for every split position', () => {
    const text = `# Title\r\n${ESC}PSECRET${ESC}\\good\rnext\n12. item\n\`\`\`txt\n界\n\`\`\``;
    const expected = renderMarkdown(text, plainMarkdownStyle());
    for (let split = 0; split <= text.length; split += 1) {
      const stream = new MarkdownStream(plainMarkdownStyle());
      const output = [
        stream.push(text.slice(0, split)),
        stream.push(text.slice(split)),
        stream.flush(),
      ]
        .filter(Boolean)
        .join('\n');
      expect(output, `split ${split}`).toBe(expected);
    }
  });
});
