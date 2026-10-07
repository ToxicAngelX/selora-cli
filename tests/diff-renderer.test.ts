/**
 * tests/diff-renderer.test.ts — the visual contract of the diff renderer.
 * Fixtures are FileDiff literals built BY HAND (the engine is a sibling
 * module under parallel construction — this suite must stand alone). A local
 * stripAnsi (ESC-concatenated regex, the repo pattern) gives plain-text
 * snapshots; string-width asserts display-width correctness on CJK/emoji rows.
 */

import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { GALAXY_PALETTE, Theme } from '../src/ui/theme.js';
import { renderFileDiff } from '../src/diff/renderer.js';
import { detectScheme, diffPaletteFor } from '../src/diff/theme.js';
import { highlightLine } from '../src/diff/highlight.js';
import type { DiffLine, FileDiff, Hunk } from '../src/diff/types.js';

const ESC = '\x1b';
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

const plainTheme = new Theme(GALAXY_PALETTE, 0);
const truecolor = new Theme(GALAXY_PALETTE, 3);

// ---------------------------------------------------------------------------
// hand-built fixtures
// ---------------------------------------------------------------------------

const NO_NEWLINE = '\\ No newline at end of file';

function sampleHunk(): Hunk {
  const lines: DiffLine[] = [
    { kind: 'ctx', oldNo: 10, newNo: 10, text: '  const rate = getRate();' },
    {
      kind: 'del',
      oldNo: 11,
      newNo: null,
      text: '  const total = price * rate;',
      words: [
        { text: '  const total = ', changed: false },
        { text: 'price * rate', changed: true },
        { text: ';', changed: false },
      ],
    },
    {
      kind: 'add',
      oldNo: null,
      newNo: 11,
      text: '  const total = round(price * rate);',
      words: [
        { text: '  const total = ', changed: false },
        { text: 'round(price * rate)', changed: true },
        { text: ';', changed: false },
      ],
    },
    { kind: 'add', oldNo: null, newNo: 12, text: '  const label = fmt(total);' },
    { kind: 'ctx', oldNo: 12, newNo: 13, text: '  return label;' },
  ];
  return {
    oldStart: 10,
    oldLines: 3,
    newStart: 10,
    newLines: 4,
    header: 'export function formatPrice',
    lines,
  };
}

function baseDiff(over: Partial<FileDiff> = {}): FileDiff {
  return {
    change: { kind: 'modified', path: 'src/utils/format.ts', oldText: '', newText: '' },
    hunks: [sampleHunk()],
    stats: { added: 2, removed: 1, hunks: 1 },
    binary: undefined,
    oldEol: 'lf',
    newEol: 'lf',
    oldEndsWithNewline: true,
    newEndsWithNewline: true,
    whitespaceOnly: false,
    modeChange: undefined,
    unchanged: false,
    generated: false,
    ...over,
  };
}

/** Render at level 0 (plain) with an explicit scheme — hermetic. */
function renderPlain(diff: FileDiff, opts: Parameters<typeof renderFileDiff>[2] = {}): string[] {
  return renderFileDiff(diff, plainTheme, { width: 80, scheme: 'dark', ...opts }).map(stripAnsi);
}

// ---------------------------------------------------------------------------
// unified layout
// ---------------------------------------------------------------------------

describe('unified layout', () => {
  it('renders the boxed modify layout: gutters, markers, stats, borders', () => {
    const rows = renderPlain(baseDiff(), { view: 'unified' });
    const [top, ...rest] = rows;
    const bottom = rest.at(-1)!;
    expect(top!.startsWith('╭─')).toBe(true);
    expect(top!.endsWith('─╮')).toBe(true);
    expect(top).toContain('✎ Modified');
    expect(top).toContain('src/utils/format.ts');
    expect(top).toContain('+2 −1');
    expect(bottom.startsWith('╰')).toBe(true);
    expect(bottom.endsWith('╯')).toBe(true);

    const body = rest.slice(0, -1);
    expect(body[0]).toContain('@@ -10,3 +10,4 @@ export function formatPrice');
    const ctxRow = body.find((r) => r.includes('const rate'));
    expect(ctxRow).toContain('10');
    const delRow = body.find((r) => r.includes('price * rate;'));
    expect(delRow).toBeDefined();
    expect(delRow).toContain('−');
    expect(delRow).not.toContain(' 12 '); // new-side gutter blank on a del
    const addRow = body.find((r) => r.includes('round(price * rate)'));
    expect(addRow).toBeDefined();
    expect(addRow).toContain('+');

    // every row has exactly the box width
    const w = stringWidth(top!);
    for (const r of rows) expect(stringWidth(r)).toBe(w);

    expect(rows.join('\n')).toMatchSnapshot();
  });

  it('gutter width follows the largest line number', () => {
    const hunk: Hunk = {
      oldStart: 998,
      oldLines: 1,
      newStart: 998,
      newLines: 1,
      header: '',
      lines: [
        { kind: 'del', oldNo: 1234, newNo: null, text: 'old line' },
        { kind: 'add', oldNo: null, newNo: 1234, text: 'new line' },
      ],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [hunk], stats: { added: 1, removed: 1, hunks: 1 } }),
    );
    const del = rows.find((r) => r.includes('old line'))!;
    expect(del).toContain('1234');
  });
});

// ---------------------------------------------------------------------------
// color
// ---------------------------------------------------------------------------

describe('color levels and palettes', () => {
  it('truecolor: add rows carry the added bg/fg and the word bg', () => {
    const rows = renderFileDiff(baseDiff(), truecolor, {
      width: 80,
      scheme: 'dark',
      view: 'unified',
    });
    const joined = rows.join('\n');
    expect(joined).toContain('48;2;18;53;31'); // addedBg #12351f
    expect(joined).toContain('38;2;126;231;135'); // addedFg #7ee787
    expect(joined).toContain('48;2;31;111;58'); // addedWordBg #1f6f3a on the changed word
    expect(joined).toContain('48;2;61;20;24'); // removedBg #3d1418
  });

  it('colorblind palette: add rows carry the blue bg', () => {
    const rows = renderFileDiff(baseDiff(), truecolor, {
      width: 80,
      scheme: 'dark',
      view: 'unified',
      palette: 'colorblind',
    });
    const joined = rows.join('\n');
    expect(joined).toContain('48;2;12;45;107'); // addedBg #0c2d6b
    expect(joined).toContain('48;2;74;31;0'); // removedBg #4a1f00
    expect(joined).not.toContain('48;2;18;53;31'); // no classic green
  });

  it('mono palette: no hue escapes at all, bold/dim only', () => {
    const rows = renderFileDiff(baseDiff(), truecolor, {
      width: 80,
      scheme: 'dark',
      view: 'unified',
      palette: 'mono',
    });
    const joined = rows.join('\n');
    expect(joined).not.toContain('48;2');
    expect(joined).not.toContain('38;2');
    expect(joined).not.toContain('48;5');
    expect(joined).toContain(`${ESC}[1m`); // bold +/− markers
    expect(stripAnsi(joined)).toContain('✎ Modified');
  });

  it('level 0: the entire output is free of ANSI escapes', () => {
    const rows = renderFileDiff(baseDiff(), plainTheme, {
      width: 80,
      scheme: 'dark',
      view: 'unified',
    });
    expect(stripAnsi(rows.join('\n'))).toBe(rows.join('\n'));
  });

  it('paletteOverride replaces derivation entirely', () => {
    const pal = diffPaletteFor('colorblind', 'light', truecolor);
    const rows = renderFileDiff(baseDiff(), truecolor, {
      width: 80,
      scheme: 'dark',
      view: 'unified',
      paletteOverride: pal,
    });
    expect(rows.join('\n')).toContain('48;2;221;244;255'); // colorblind light addedBg #ddf4ff
  });
});

// ---------------------------------------------------------------------------
// change kinds
// ---------------------------------------------------------------------------

describe('change kinds', () => {
  it('created: all-add hunk with the ✚ Created title', () => {
    const hunk: Hunk = {
      oldStart: 0,
      oldLines: 0,
      newStart: 1,
      newLines: 2,
      header: '',
      lines: [
        { kind: 'add', oldNo: null, newNo: 1, text: 'export const a = 1;' },
        { kind: 'add', oldNo: null, newNo: 2, text: 'export const b = 2;' },
      ],
    };
    const rows = renderPlain(
      baseDiff({
        change: { kind: 'created', path: 'src/new.ts', newText: '' },
        hunks: [hunk],
        stats: { added: 2, removed: 0, hunks: 1 },
      }),
    );
    expect(rows[0]).toContain('✚ Created');
    expect(rows[0]).toContain('src/new.ts');
    expect(rows.some((r) => r.includes('+ export const a = 1;'))).toBe(true);
  });

  it('deleted: ✖ Deleted title and − markers', () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 0,
      newLines: 0,
      header: '',
      lines: [{ kind: 'del', oldNo: 1, newNo: null, text: 'gone();' }],
    };
    const rows = renderPlain(
      baseDiff({
        change: { kind: 'deleted', path: 'src/old.ts', oldText: '' },
        hunks: [hunk],
        stats: { added: 0, removed: 1, hunks: 1 },
      }),
    );
    expect(rows[0]).toContain('✖ Deleted');
    expect(rows.some((r) => r.includes('− gone();'))).toBe(true);
  });

  it('renamed: title shows old → new', () => {
    const rows = renderPlain(
      baseDiff({
        change: {
          kind: 'renamed',
          path: 'src/new-name.ts',
          oldPath: 'src/old-name.ts',
          oldText: '',
          newText: '',
          similarity: 0.9,
        },
      }),
    );
    expect(rows[0]).toContain('➜ Renamed');
    expect(rows[0]).toContain('src/old-name.ts → src/new-name.ts');
  });

  it('unchanged: a single dim line, no box', () => {
    const rows = renderFileDiff(
      baseDiff({ unchanged: true, hunks: [], stats: { added: 0, removed: 0, hunks: 0 } }),
      plainTheme,
      { width: 80, scheme: 'dark' },
    );
    expect(rows).toEqual(['src/utils/format.ts — no changes']);
  });
});

// ---------------------------------------------------------------------------
// special content
// ---------------------------------------------------------------------------

describe('special content', () => {
  it('binary: single box row with formatted sizes', () => {
    const changed = renderPlain(
      baseDiff({
        binary: { oldSize: 12288, newSize: 14848 },
        hunks: [],
        stats: { added: 0, removed: 0, hunks: 0 },
      }),
    );
    expect(changed.some((r) => r.includes('Binary file changed (12.0 KB → 14.5 KB)'))).toBe(true);

    const created = renderPlain(
      baseDiff({
        change: { kind: 'created', path: 'assets/logo.png', newText: '' },
        binary: { oldSize: 0, newSize: 14848 },
        hunks: [],
        stats: { added: 0, removed: 0, hunks: 0 },
      }),
    );
    expect(created.some((r) => r.includes('Binary file created (14.5 KB)'))).toBe(true);

    const deleted = renderPlain(
      baseDiff({
        change: { kind: 'deleted', path: 'assets/logo.png', oldText: '' },
        binary: { oldSize: 512, newSize: 0 },
        hunks: [],
        stats: { added: 0, removed: 0, hunks: 0 },
      }),
    );
    expect(deleted.some((r) => r.includes('Binary file deleted (512 B)'))).toBe(true);
  });

  it('generated: collapses to one row with stats; expandGenerated renders in full', () => {
    const gen = baseDiff({ generated: true, stats: { added: 1204, removed: 980, hunks: 4 } });
    const collapsed = renderPlain(gen);
    expect(
      collapsed.some((r) =>
        r.includes('+1204 −980 (collapsed — generated/lockfile; press e to expand)'),
      ),
    ).toBe(true);
    expect(collapsed.some((r) => r.includes('@@'))).toBe(false);

    const expanded = renderPlain(gen, { expandGenerated: true });
    expect(expanded.some((r) => r.includes('@@ -10,3 +10,4 @@'))).toBe(true);
    expect(expanded.some((r) => r.includes('collapsed'))).toBe(false);
  });

  it('maxLines caps the body and reports the unrendered line count', () => {
    const lines: DiffLine[] = [];
    for (let i = 1; i <= 20; i += 1) {
      lines.push({
        kind: 'add',
        oldNo: null,
        newNo: i,
        text: `const value${i} = computeSomething(${i});`,
      });
    }
    const diff = baseDiff({
      change: { kind: 'created', path: 'src/big.ts', newText: '' },
      hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 20, header: '', lines }],
      stats: { added: 20, removed: 0, hunks: 1 },
    });
    const rows = renderPlain(diff, { maxLines: 4 });
    const cap = rows.find((r) => r.includes('more lines · press e to expand'));
    expect(cap).toBeDefined();
    expect(cap).toContain('…');
    expect(cap).toContain('17 more lines'); // 4 rows used: hunk header + 3 lines
    expect(rows.some((r) => r.includes('line 4') || r.includes('value4'))).toBe(false);
  });

  it("emits '\\ No newline at end of file' when trailing-newline state differs", () => {
    const rows = renderPlain(baseDiff({ oldEndsWithNewline: false, newEndsWithNewline: true }));
    expect(rows.some((r) => r.includes(NO_NEWLINE))).toBe(true);
    // …and not when both sides agree
    const clean = renderPlain(baseDiff());
    expect(clean.some((r) => r.includes(NO_NEWLINE))).toBe(false);
  });

  it('whitespaceOnly diffs carry the dim note under the title', () => {
    const rows = renderPlain(baseDiff({ whitespaceOnly: true }));
    expect(rows[1]).toContain('whitespace-only changes');
  });

  it('modeChange renders an octal mode row', () => {
    const rows = renderPlain(baseDiff({ modeChange: { from: 0o644, to: 0o755 } }));
    expect(rows.some((r) => r.includes('mode 100644 → 100755'))).toBe(true);
  });

  it('empty hunks still render a safe box', () => {
    const rows = renderPlain(baseDiff({ hunks: [], stats: { added: 0, removed: 0, hunks: 0 } }));
    expect(rows.length).toBe(2);
    expect(rows[0]!.startsWith('╭─')).toBe(true);
    expect(rows[1]!.startsWith('╰')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// width behavior
// ---------------------------------------------------------------------------

describe('width behavior', () => {
  it('CJK + emoji rows pad to the exact box width', () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 2,
      header: '',
      lines: [
        { kind: 'ctx', oldNo: 1, newNo: 1, text: 'const s = "你好世界🚀";' },
        { kind: 'del', oldNo: 2, newNo: null, text: '// 注释行' },
      ],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [hunk], stats: { added: 0, removed: 1, hunks: 1 } }),
      { width: 60 },
    );
    const w = stringWidth(rows[0]!);
    for (const r of rows) expect(stringWidth(r)).toBe(w);
  });

  it('long lines truncate with … and never exceed the box width', () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '',
      lines: [{ kind: 'del', oldNo: 1, newNo: null, text: `x = '${'a'.repeat(500)}';` }],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [hunk], stats: { added: 0, removed: 1, hunks: 1 } }),
      { width: 60 },
    );
    for (const r of rows) expect(stringWidth(r)).toBe(60);
    expect(rows.some((r) => r.includes('…'))).toBe(true);
  });

  it('width < 40 compacts the gutters without throwing or breaking rows', () => {
    const rows = renderPlain(baseDiff(), { width: 30 });
    const w = stringWidth(rows[0]!);
    expect(w).toBeLessThanOrEqual(30);
    for (const r of rows) expect(stringWidth(r)).toBe(w);
    // markers survive; over-long text truncates with … instead of overflowing
    expect(rows.some((r) => r.includes('−'))).toBe(true);
    expect(rows.some((r) => r.includes('+'))).toBe(true);
    expect(rows.some((r) => r.includes('…'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// split view
// ---------------------------------------------------------------------------

describe('split view', () => {
  it('pairs del/add rows across a center divider with outer gutters', () => {
    const rows = renderPlain(baseDiff(), { width: 140, view: 'split' });
    const w = stringWidth(rows[0]!);
    for (const r of rows) expect(stringWidth(r)).toBe(w);
    const body = rows.slice(1, -1);
    // pair rows carry three '│': left border, center divider, right border
    // (full-width meta rows like the hunk header carry two)
    const pairRows = body.filter((r) => (r.match(/│/g) ?? []).length === 3);
    expect(pairRows.length).toBe(4); // ctx, del+add, blank+add, ctx
    expect(body.some((r) => r.includes('@@ -10,3 +10,4 @@'))).toBe(true);
    // the paired change sits on ONE row: old text left, new text right
    const paired = body.find((r) => r.includes('price * rate'));
    expect(paired).toBeDefined();
    expect(paired).toContain('round(price * rate)');
    // pure add row: blank left side
    const addOnly = body.find((r) => r.includes('const label'));
    expect(addOnly).toBeDefined();
    expect(addOnly).toContain('+');
    expect(rows.join('\n')).toMatchSnapshot();
  });

  it('auto view: split at width ≥ 140, unified below', () => {
    // del signature ('total = price * rate;') vs add signature ('round('):
    // in split they share ONE row; in unified they are separate rows.
    const onOneRow = (rows: string[]): boolean =>
      rows.some((r) => r.includes('total = price * rate;') && r.includes('round('));
    const wide = renderPlain(baseDiff(), { width: 140, view: 'auto' });
    expect(onOneRow(wide.slice(1, -1))).toBe(true);
    const narrow = renderPlain(baseDiff(), { width: 100, view: 'auto' });
    expect(onOneRow(narrow.slice(1, -1))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// whitespace visibility
// ---------------------------------------------------------------------------

describe('showWhitespace', () => {
  it('renders tabs as → and trailing spaces as ·', () => {
    const hunk: Hunk = {
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      header: '',
      lines: [
        { kind: 'del', oldNo: 1, newNo: null, text: '\treturn 1;  ' },
        { kind: 'add', oldNo: null, newNo: 1, text: '\treturn 2;' },
      ],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [hunk], stats: { added: 1, removed: 1, hunks: 1 } }),
      { showWhitespace: true },
    );
    const del = rows.find((r) => r.includes('return 1'))!;
    expect(del).toContain('→');
    expect(del).toContain('··');
    // default: invisible
    const plain = renderPlain(
      baseDiff({ hunks: [hunk], stats: { added: 1, removed: 1, hunks: 1 } }),
    );
    const plainDel = plain.find((r) => r.includes('return 1'))!;
    expect(plainDel).not.toContain('→');
    expect(plainDel).not.toContain('·');
  });
});

// ---------------------------------------------------------------------------
// theme + highlight units
// ---------------------------------------------------------------------------

describe('detectScheme', () => {
  it('reads the last COLORFGBG field; dark is the fallback', () => {
    expect(detectScheme({})).toBe('dark');
    expect(detectScheme({ COLORFGBG: '15;0' })).toBe('dark');
    expect(detectScheme({ COLORFGBG: '0;15' })).toBe('light');
    expect(detectScheme({ COLORFGBG: '7' })).toBe('light');
    expect(detectScheme({ COLORFGBG: '1;2;15' })).toBe('light');
    expect(detectScheme({ COLORFGBG: 'garbage' })).toBe('dark');
    expect(detectScheme({ COLORFGBG: '' })).toBe('dark');
  });
});

describe('highlightLine', () => {
  it('segments rejoin exactly to the input line', () => {
    const cases: Array<[string, string]> = [
      ['const x = "hello"; // done', 'src/a.ts'],
      ['def f(x):  # comment\n'.trimEnd(), 'src/a.py'],
      ['{"a": 1, "b": true}', 'data.json'],
      ['SELECT * FROM t WHERE id = 42;', 'q.sql'],
      ['# hash comment', 'script.sh'],
      ['unterminated "string here', 'src/a.js'],
      ['0xFF 1_000 3.14 1e10', 'src/a.ts'],
      ['任意のテキスト', 'src/a.ts'],
      ['plain line', 'no-extension-hopefully.zzz'],
    ];
    for (const [line, path] of cases) {
      const segs = highlightLine(line, path);
      expect(segs.map((s) => s.text).join('')).toBe(line);
    }
  });

  it('classifies keywords, strings, comments, numbers', () => {
    const segs = highlightLine('const total = round(3.5); // sum', 'src/a.ts');
    const roleOf = (text: string): string | undefined => segs.find((s) => s.text === text)?.role;
    expect(roleOf('const')).toBe('keyword');
    expect(roleOf('3.5')).toBe('number');
    expect(segs.find((s) => s.role === 'comment')?.text).toBe('// sum');
    const strSegs = highlightLine('echo "hi $USER"', 'deploy.sh');
    expect(strSegs.find((s) => s.text === '"hi $USER"')?.role).toBe('string');
  });

  it('unknown extensions yield one plain segment', () => {
    expect(highlightLine('whatever here', 'file.unknownext')).toEqual([
      { text: 'whatever here', role: 'plain' },
    ]);
    expect(highlightLine('', 'file.ts')).toEqual([]);
  });
});

describe('between-hunk separator', () => {
  it('distant hunks get a ⋯ N unchanged lines ⋯ row with the skip count', () => {
    const h1: Hunk = {
      oldStart: 3,
      oldLines: 7,
      newStart: 3,
      newLines: 7,
      header: '',
      lines: [
        { kind: 'ctx', oldNo: 3, newNo: 3, text: 'l2' },
        { kind: 'del', oldNo: 6, newNo: null, text: 'l5' },
        { kind: 'add', oldNo: null, newNo: 6, text: 'L5' },
        { kind: 'ctx', oldNo: 9, newNo: 9, text: 'l8' },
      ],
    };
    const h2: Hunk = {
      oldStart: 28,
      oldLines: 7,
      newStart: 28,
      newLines: 7,
      header: '',
      lines: [
        { kind: 'ctx', oldNo: 28, newNo: 28, text: 'l27' },
        { kind: 'del', oldNo: 31, newNo: null, text: 'l30' },
        { kind: 'add', oldNo: null, newNo: 31, text: 'L30' },
        { kind: 'ctx', oldNo: 34, newNo: 34, text: 'l33' },
      ],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [h1, h2], stats: { added: 2, removed: 2, hunks: 2 } }),
    );
    // h1 covers old lines 3..9; h2 starts at 28 → 18 unchanged lines skipped
    expect(rows.some((r) => r.includes('⋯ 18 unchanged lines ⋯'))).toBe(true);
  });

  it('touching hunks get no separator', () => {
    const h1: Hunk = {
      oldStart: 3,
      oldLines: 4,
      newStart: 3,
      newLines: 4,
      header: '',
      lines: [
        { kind: 'del', oldNo: 4, newNo: null, text: 'a' },
        { kind: 'add', oldNo: null, newNo: 4, text: 'A' },
      ],
    };
    const h2: Hunk = {
      oldStart: 7,
      oldLines: 2,
      newStart: 7,
      newLines: 2,
      header: '',
      lines: [
        { kind: 'del', oldNo: 7, newNo: null, text: 'b' },
        { kind: 'add', oldNo: null, newNo: 7, text: 'B' },
      ],
    };
    const rows = renderPlain(
      baseDiff({ hunks: [h1, h2], stats: { added: 2, removed: 2, hunks: 2 } }),
    );
    expect(rows.some((r) => r.includes('unchanged line'))).toBe(false);
  });
});
