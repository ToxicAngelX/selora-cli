/**
 * Markdown renderer tests: the full line-level subset (headings at every
 * level, bold/italic/inline-code with unmatched delimiters staying literal,
 * nested and ordered lists, fenced blocks with verbatim contents and
 * language labels, thematic breaks, blockquotes, blank-line collapsing) and
 * MarkdownStream semantics — mid-line and mid-marker delta splits, fenced
 * blocks delivered only on close (or flush), trailing partial lines, and a
 * chunked-streaming property: feeding a fixed multi-paragraph document
 * through the stream reproduces renderMarkdown() exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  MarkdownStream,
  plainMarkdownStyle,
  renderMarkdown,
  type MarkdownStyle,
} from '../src/ui/markdown.js';

/** Marker-wrapping style: makes structure assertions legible. */
function taggedStyle(): MarkdownStyle {
  return {
    heading: (text, level) => `h${level}[${text}]`,
    bold: (text) => `**${text}**`,
    italic: (text) => `*${text}*`,
    code: (text) => `\`${text}\``,
    bullet: (marker, text, indent) => `${'.'.repeat(indent)}${marker}{${text}}`,
    codeBlock: (lines, lang) => [`<${lang || 'plain'}>`, ...lines, `</${lang || 'plain'}>`],
    paragraph: (text) => `p(${text})`,
    hr: () => '<HR>',
    quote: (text) => `q{${text}}`,
  };
}

describe('headings', () => {
  it('levels 1-3 map to style.heading with the right level', () => {
    expect(renderMarkdown('# Title', taggedStyle())).toBe('h1[Title]');
    expect(renderMarkdown('## Sub', taggedStyle())).toBe('h2[Sub]');
    expect(renderMarkdown('### Deep', taggedStyle())).toBe('h3[Deep]');
  });

  it('levels 4-6 render as bold paragraphs', () => {
    expect(renderMarkdown('#### H4', taggedStyle())).toBe('p(**H4**)');
    expect(renderMarkdown('##### H5', taggedStyle())).toBe('p(**H5**)');
    expect(renderMarkdown('###### H6', taggedStyle())).toBe('p(**H6**)');
  });

  it('seven hashes is not a heading, and #hi without a space is a paragraph', () => {
    expect(renderMarkdown('####### x', taggedStyle())).toBe('p(####### x)');
    expect(renderMarkdown('#not-a-heading', taggedStyle())).toBe('p(#not-a-heading)');
  });
});

describe('inline styling', () => {
  it('bold with ** and __; italic with * and _', () => {
    expect(renderMarkdown('a **b** c', taggedStyle())).toBe('p(a **b** c)');
    expect(renderMarkdown('a __b__ c', taggedStyle())).toBe('p(a **b** c)');
    expect(renderMarkdown('a *b* c', taggedStyle())).toBe('p(a *b* c)');
    expect(renderMarkdown('a _b_ c', taggedStyle())).toBe('p(a *b* c)');
  });

  it('italic and bold coexist without the single delimiter eating half a pair', () => {
    expect(renderMarkdown('*i* and **b**', taggedStyle())).toBe('p(*i* and **b**)');
    expect(renderMarkdown('**b** and *i*', taggedStyle())).toBe('p(**b** and *i*)');
    expect(renderMarkdown('**a *b* c**', taggedStyle())).toBe('p(**a *b* c**)');
  });

  it('inline code keeps its contents verbatim, including markup characters', () => {
    expect(renderMarkdown('run `x = *1* + _2_` now', taggedStyle())).toBe(
      'p(run `x = *1* + _2_` now)',
    );
  });

  it('unmatched delimiters render literally', () => {
    expect(renderMarkdown('a ** b', taggedStyle())).toBe('p(a ** b)');
    expect(renderMarkdown('a * b', taggedStyle())).toBe('p(a * b)');
    expect(renderMarkdown('never *closed', taggedStyle())).toBe('p(never *closed)');
    expect(renderMarkdown('never _closed', taggedStyle())).toBe('p(never _closed)');
    expect(renderMarkdown('open `tick', taggedStyle())).toBe('p(open `tick)');
  });
});

describe('lists', () => {
  it('bullets nest via leading spaces, 2 spaces per level, any of - * + markers', () => {
    const md = '- alpha\n  * beta\n    + gamma\n- delta';
    expect(renderMarkdown(md, taggedStyle())).toBe('-{alpha}\n.*{beta}\n..+{gamma}\n-{delta}');
  });

  it('ordered markers keep their number as the marker', () => {
    const md = '1. first\n2. second\n10. tenth';
    expect(renderMarkdown(md, taggedStyle())).toBe('1{first}\n2{second}\n10{tenth}');
  });

  it('ordered lists nest too', () => {
    expect(renderMarkdown('  3. nested', taggedStyle())).toBe('.3{nested}');
  });
});

describe('fenced code blocks', () => {
  it('first word after the opening fence is the language label; contents are verbatim', () => {
    const md = '```ts\nconst x = *1* + `y`;\n```';
    expect(renderMarkdown(md, taggedStyle())).toBe('<ts>\nconst x = *1* + `y`;\n</ts>');
    expect(renderMarkdown(md, plainMarkdownStyle())).toBe(
      '╭─ ts ───╮\n│ const x = *1* + `y`; │\n╰────╯',
    );
  });

  it('extra words after the language are dropped; empty language has no label', () => {
    expect(renderMarkdown('```js extra words\nx\n```', taggedStyle())).toBe('<js>\nx\n</js>');
    expect(renderMarkdown('```\nx\n```', plainMarkdownStyle())).toBe('╭──────╮\n│ x │\n╰────╯');
  });

  it('a ~~~ fence closes only on ~~~, never on ``` inside it', () => {
    const md = '~~~json\n```\n{"a": 1}\n~~~';
    expect(renderMarkdown(md, taggedStyle())).toBe('<json>\n```\n{"a": 1}\n</json>');
  });

  it('blank lines inside a fence are content, not paragraph separators', () => {
    expect(renderMarkdown('```txt\na\n\nb\n```', taggedStyle())).toBe('<txt>\na\n\nb\n</txt>');
  });
});

describe('thematic breaks and blockquotes', () => {
  it('--- and *** alone on a line render via hr', () => {
    expect(renderMarkdown('---', taggedStyle())).toBe('<HR>');
    expect(renderMarkdown('***', taggedStyle())).toBe('<HR>');
    expect(renderMarkdown('-----', taggedStyle())).toBe('<HR>');
    // not a break: trailing content
    expect(renderMarkdown('--- text', taggedStyle())).toBe('p(--- text)');
  });

  it('blockquote lines inline-style their remainder', () => {
    expect(renderMarkdown('> quoted **strong** words', taggedStyle())).toBe(
      'q{quoted **strong** words}',
    );
    expect(renderMarkdown('> plain', plainMarkdownStyle())).toBe('> plain');
  });
});

describe('renderMarkdown blank-line handling', () => {
  it('runs of blank lines collapse to one separator', () => {
    expect(renderMarkdown('a\n\n\n\nb', taggedStyle())).toBe('p(a)\n\np(b)');
  });

  it('a trailing newline does not produce a trailing blank output line', () => {
    expect(renderMarkdown('a\n', taggedStyle())).toBe('p(a)');
    expect(renderMarkdown('a\n\n', taggedStyle())).toBe('p(a)\n');
  });

  it('an unclosed fence is closed gracefully at end of document', () => {
    expect(renderMarkdown('```py\ncode', plainMarkdownStyle())).toBe(
      '╭─ py ───╮\n│ code │\n╰────╯',
    );
  });
});

describe('MarkdownStream', () => {
  it('a delta split mid-line renders one heading line, not two', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    expect(stream.push('# He')).toBe('');
    expect(stream.push('llo\n')).toBe('# Hello');
    expect(stream.flush()).toBe('');
  });

  it('deltas split mid-marker still style the whole span once complete', () => {
    const stream = new MarkdownStream(taggedStyle());
    expect(stream.push('very *bo')).toBe('');
    expect(stream.push('ld* text\n')).toBe('p(very *bold* text)');
  });

  it('inside-fence lines are held back and delivered as a unit on close', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    expect(stream.push('```js\n1\n2\n')).toBe('');
    // the closing fence only takes effect once its line completes
    expect(stream.push('```')).toBe('');
    expect(stream.push('\n')).toBe('╭─ js ───╮\n│ 1 │\n│ 2 │\n╰────╯');
    expect(stream.flush()).toBe('');
  });

  it('an unclosed fence renders at flush', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    expect(stream.push('```py\ncode')).toBe('');
    expect(stream.flush()).toBe('╭─ py ───╮\n│ code │\n╰────╯');
  });

  it('a trailing partial line renders at flush', () => {
    const stream = new MarkdownStream(taggedStyle());
    expect(stream.push('just some text')).toBe('');
    expect(stream.flush()).toBe('p(just some text)');
  });

  it('a trailing partial line that opens a fence still boxes at flush', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    expect(stream.push('```\nbody\nmore')).toBe(''); // fence still open
    expect(stream.flush()).toBe('╭──────╮\n│ body │\n│ more │\n╰────╯');
  });

  it('blank-line runs collapse across pushes (a lone blank returns the empty join)', () => {
    const stream = new MarkdownStream(taggedStyle());
    stream.push('a\n');
    // two blank lines arrive; the second is collapsed, the batch is blank + p(b)
    expect(stream.push('\n\nb\n')).toBe('\np(b)');
    expect(stream.flush()).toBe('');
  });
});

describe('MarkdownStream equals renderMarkdown (chunked streaming)', () => {
  const DOC = [
    '# Release notes',
    '',
    'Some **bold**, *italic* and `code` text.',
    '',
    '',
    '- alpha',
    '- beta with **bold**',
    '  - nested',
    '- gamma',
    '',
    '1. first',
    '2. second',
    '',
    '```ts',
    'const x = *1* + _2_;',
    '```',
    '',
    '> quoted **strong** words',
    '',
    '---',
    '',
    'Final *partial* line without newline',
  ].join('\n');

  /**
   * Fixed-size chunks, extended past a completed line so a blank line is
   * never the only line in a push batch (a lone blank joins to '' — the
   * same string push returns for "no lines"). Boundaries still land
   * mid-line and mid-marker, which is what the stream must survive.
   */
  function chunkDoc(doc: string): string[] {
    const chunks: string[] = [];
    let rest = doc;
    while (rest !== '') {
      let chunk = rest.slice(0, 4);
      rest = rest.slice(4);
      if (chunk.endsWith('\n') && rest !== '') {
        const nl = rest.indexOf('\n');
        const extra = nl === -1 ? rest : rest.slice(0, nl + 1);
        chunk += extra;
        rest = rest.slice(extra.length);
      }
      chunks.push(chunk);
    }
    return chunks;
  }

  it('pushing the doc in small chunks reproduces renderMarkdown exactly', () => {
    const chunks = chunkDoc(DOC);
    // sanity: the chunking really splits lines mid-flight
    expect(chunks.some((c) => !c.endsWith('\n'))).toBe(true);
    expect(chunks.length).toBeGreaterThan(10);

    const stream = new MarkdownStream(taggedStyle());
    const parts: string[] = [];
    for (const chunk of chunks) {
      const out = stream.push(chunk);
      if (out !== '') parts.push(out);
    }
    const tail = stream.flush();
    if (tail !== '') parts.push(tail);
    expect(parts.join('\n')).toBe(renderMarkdown(DOC, taggedStyle()));
  });

  // A doc with no blank lines: push() legitimately returns '' both for "no
  // completed lines" and for "exactly one blank line", so a doc containing
  // blank separators cannot be reconstructed from return values alone when
  // every chunk boundary lands right after a blank. Blank-free docs have no
  // such ambiguity, so they can be streamed one character at a time.
  const DOC_NOBLANK = [
    '# Heading',
    'Some **bold** and *italic* and `code` text.',
    '- alpha',
    '  - nested *item*',
    '1. first',
    '```ts',
    'const x = *1*;',
    '```',
    '> quoted **strong** words',
    '---',
    'Final *partial* line',
  ].join('\n');

  it('single-character chunks reproduce renderMarkdown on a blank-free doc', () => {
    const stream = new MarkdownStream(plainMarkdownStyle());
    const parts: string[] = [];
    for (let i = 0; i < DOC_NOBLANK.length; i++) {
      const out = stream.push(DOC_NOBLANK[i]!);
      if (out !== '') parts.push(out);
    }
    const tail = stream.flush();
    if (tail !== '') parts.push(tail);
    expect(parts.join('\n')).toBe(renderMarkdown(DOC_NOBLANK, plainMarkdownStyle()));
  });
});
