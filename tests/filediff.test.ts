/**
 * tests/filediff.test.ts — the flat Claude-Code-style tool-result renderer
 * (src/ui/filediff.ts): created/edit/delete bodies, the computed result
 * lines, gutter geometry, hunk separators, elision + the expanded (ctrl+r)
 * view, width truncation, and the NO_COLOR/level-0 plain-text fallback.
 */

import { describe, expect, it } from 'vitest';
import {
  fileChangeResultLine,
  renderFileChangeRows,
  renderFileChangeToolResult,
} from '../src/ui/filediff.js';
import { renderToolResult, renderToolStart } from '../src/ui/chatui.js';
import { themeFor } from '../src/ui/theme.js';
import { terminalTextWidth } from '../src/ui/terminal-text.js';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');
const strip = (s: string): string => s.replace(ANSI_RE, '');

/** Level 0 — no escapes ever (NO_COLOR / non-TTY / mono). */
const plain = themeFor('galaxy', false, {});
/** Truecolor dark — the full bg/fg rendering. */
const color = themeFor('galaxy', true, { COLORTERM: 'truecolor' });

const bigFile = Array.from({ length: 182 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

describe('fileChangeResultLine', () => {
  it('created: "Wrote N lines to path" with singular/plural', () => {
    expect(fileChangeResultLine({ before: '', after: 'a\n', path: 'x.ts' })).toBe(
      'Wrote 1 line to x.ts',
    );
    expect(fileChangeResultLine({ before: '', after: bigFile, path: 'src/new.ts' })).toBe(
      'Wrote 182 lines to src/new.ts',
    );
  });

  it('deleted: "Deleted path"', () => {
    expect(fileChangeResultLine({ before: 'a\nb\n', after: '', path: 'old.txt' })).toBe(
      'Deleted old.txt',
    );
  });

  it('modified: "Updated path with A additions and R removals", singular correct', () => {
    expect(
      fileChangeResultLine({ before: 'a\nb\nc\n', after: 'a\nX\nc\n', path: 'f.ts' }),
    ).toBe('Updated f.ts with 1 addition and 1 removal');
    expect(
      fileChangeResultLine({ before: 'a\nb\nc\nd\n', after: 'a\nX\nY\nc\n', path: 'f.ts' }),
    ).toBe('Updated f.ts with 2 additions and 2 removals');
  });

  it('kind is inferred from the empty side when absent', () => {
    expect(fileChangeResultLine({ before: '', after: 'x\n', path: 'p' })).toContain('Wrote');
    expect(fileChangeResultLine({ before: 'x\n', after: '', path: 'p' })).toContain('Deleted');
  });

  it('a no-op overwrite and binary content return undefined (summary fallback)', () => {
    expect(fileChangeResultLine({ before: 'same\n', after: 'same\n', path: 'f' })).toBeUndefined();
    expect(
      fileChangeResultLine({ before: 'a\n', after: 'a\n' + String.fromCharCode(0) + 'x\n', path: 'f' }),
    ).toBeUndefined();
  });
});

describe('renderFileChangeRows — created', () => {
  it('small file: every line a numbered + row, no elision', () => {
    const r = renderFileChangeRows(
      { before: '', after: 'one\ntwo\nthree\n', path: 'a.txt' },
      plain,
      { width: 80, scheme: 'dark' },
    );
    expect(r).toBeDefined();
    expect(r!.rows.map(strip)).toEqual(['1 + one', '2 + two', '3 + three']);
    expect(r!.expandable).toBe(false);
  });

  it('long file: first 10 lines + the dim "… +172 lines (ctrl+r to expand)" row', () => {
    const r = renderFileChangeRows({ before: '', after: bigFile, path: 'src/new.ts' }, plain, {
      width: 80,
      scheme: 'dark',
      expandHint: true,
    });
    const rows = r!.rows.map(strip);
    expect(rows).toHaveLength(11);
    expect(rows[0]).toBe(' 1 + line 1');
    expect(rows[9]).toBe('10 + line 10');
    expect(rows[10]).toBe('  … +172 lines (ctrl+r to expand)');
    expect(r!.expandable).toBe(true);
  });

  it('the hint is omitted when expandHint is off (classic / run paths)', () => {
    const r = renderFileChangeRows({ before: '', after: bigFile, path: 'f' }, plain, {
      width: 80,
      scheme: 'dark',
    });
    expect(strip(r!.rows.at(-1)!)).toBe('  … +172 lines');
  });

  it('expanded: the ctrl+r view shows every line, no elision', () => {
    const r = renderFileChangeRows({ before: '', after: bigFile, path: 'f' }, plain, {
      width: 80,
      scheme: 'dark',
      expanded: true,
    });
    expect(r!.rows).toHaveLength(182);
    expect(strip(r!.rows.at(-1)!)).toBe('182 + line 182');
    expect(r!.expandable).toBe(false);
  });

  it('an 11-line file shows all 11 — eliding one line saves nothing', () => {
    const text = Array.from({ length: 11 }, (_, i) => `l${i + 1}`).join('\n') + '\n';
    const r = renderFileChangeRows({ before: '', after: text, path: 'f' }, plain, { width: 80 });
    expect(r!.rows).toHaveLength(11);
    expect(r!.expandable).toBe(false);
  });
});

describe('renderFileChangeRows — modified', () => {
  const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n']
    .join('\n') + '\n';

  it('single hunk: del rows carry old numbers, add/ctx new numbers', () => {
    const after = before.replace('b\n', 'B\n');
    const r = renderFileChangeRows({ before, after, path: 'f.ts' }, plain, { width: 100 });
    const rows = r!.rows.map(strip);
    // context 3 around the change at line 2 → lines 1..5
    expect(rows).toEqual([
      '1   a',
      '2 - b',
      '2 + B',
      '3   c',
      '4   d',
      '5   e',
    ]);
  });

  it('multiple hunks are separated by a dim "..." row', () => {
    let after = before.replace('b\n', 'B\n');
    after = after.replace('m\n', 'M\n');
    const r = renderFileChangeRows({ before, after, path: 'f.ts' }, plain, { width: 100 });
    const rows = r!.rows.map(strip);
    // gutter width 2 (numbers up to 14) → right-aligned with a leading pad
    expect(rows).toContain('   ...');
    const sepAt = rows.indexOf('   ...');
    // first hunk ends at line 5, second starts at line 10 (ctx 3 around line 13)
    expect(rows[sepAt - 1]).toBe(' 5   e');
    expect(rows[sepAt + 1]).toBe('10   j');
    // both changes visible, old numbers on the removals
    expect(rows).toContain(' 2 - b');
    expect(rows).toContain(' 2 + B');
    expect(rows).toContain('13 - m');
    expect(rows).toContain('13 + M');
  });

  it('no separator between touching hunks (gap ≤ 2×context)', () => {
    let after = before.replace('c\n', 'C\n');
    after = after.replace('h\n', 'H\n'); // gap of 4 ctx lines ≤ 6 → one hunk
    const r = renderFileChangeRows({ before, after, path: 'f.ts' }, plain, { width: 100 });
    const rows = r!.rows.map(strip);
    expect(rows.some((row) => row.includes('...'))).toBe(false);
  });

  it('a full-file rewrite caps the body at maxRows with "… N more lines"', () => {
    const bigBefore = Array.from({ length: 300 }, (_, i) => `old ${i + 1}`).join('\n');
    const bigAfter = Array.from({ length: 300 }, (_, i) => `new ${i + 1}`).join('\n');
    const r = renderFileChangeRows({ before: bigBefore, after: bigAfter, path: 'f' }, plain, {
      width: 100,
      maxRows: 40,
      expandHint: true,
    });
    const rows = r!.rows.map(strip);
    expect(rows.at(-1)).toMatch(/^  … \d+ more lines \(ctrl\+r to expand\)$/); // eslint-disable-line no-regex-spaces
    expect(r!.expandable).toBe(true);
    const full = renderFileChangeRows({ before: bigBefore, after: bigAfter, path: 'f' }, plain, {
      width: 100,
      expanded: true,
    });
    expect(full!.rows).toHaveLength(600);
  });
});

describe('renderFileChangeRows — deleted', () => {
  it('removed lines are - rows with old line numbers', () => {
    const r = renderFileChangeRows(
      { before: 'one\ntwo\nthree\n', after: '', path: 'gone.txt' },
      plain,
      { width: 80 },
    );
    expect(r!.rows.map(strip)).toEqual(['1 - one', '2 - two', '3 - three']);
  });

  it('long deletes collapse like creates, with a -N elision row', () => {
    const r = renderFileChangeRows({ before: bigFile, after: '', path: 'gone.txt' }, plain, {
      width: 80,
      expandHint: true,
    });
    const rows = r!.rows.map(strip);
    expect(rows).toHaveLength(11);
    expect(rows[10]).toBe('  … -172 lines (ctrl+r to expand)');
  });
});

describe('geometry + styling', () => {
  it('the gutter is right-aligned and sized to the widest shown number', () => {
    const r = renderFileChangeRows({ before: '', after: bigFile, path: 'f' }, plain, {
      width: 80,
      expanded: true,
    });
    expect(strip(r!.rows[0]!)).toBe('  1 + line 1');
    expect(strip(r!.rows[98]!)).toBe(' 99 + line 99');
    expect(strip(r!.rows[99]!)).toBe('100 + line 100');
  });

  it('long code lines truncate to the terminal width without breaking the gutter', () => {
    const long = `const x = '${'y'.repeat(500)}';`;
    const r = renderFileChangeRows({ before: '', after: `${long}\n`, path: 'f' }, plain, {
      width: 40,
    });
    expect(r!.rows).toHaveLength(1);
    expect(terminalTextWidth(r!.rows[0]!)).toBeLessThanOrEqual(40);
    expect(strip(r!.rows[0]!).startsWith('1 + const x = ')).toBe(true);
  });

  it('file content is sanitized: ESC bytes never reach the output', () => {
    const evil = `ok ${ESC}[31mred${ESC}]0;title${String.fromCharCode(7)} end`;
    const r = renderFileChangeRows({ before: '', after: `${evil}\n`, path: 'f' }, color, {
      width: 120,
      scheme: 'dark',
    });
    // the SGR marker is stripped, the OSC sequence drops WITH its payload
    const row = strip(r!.rows[0]!);
    expect(row.startsWith('1 + ok red end')).toBe(true);
    // the only escapes are our own SGR (38;2/48;2 truecolor + the final reset)
    for (const m of r!.rows[0]!.matchAll(new RegExp(`${ESC}\\[([0-9;]*)m`, 'g'))) {
      expect(m[1]).toMatch(
        /^(0|1|2|(1;)?(2;)?38;2;\d+;\d+;\d+|(1;)?(2;)?48;2;\d+;\d+;\d+|([12];)?38;2;\d+;\d+;\d+;48;2;\d+;\d+;\d+)$/,
      );
    }
  });

  it('NO_COLOR / non-TTY (level 0): zero escapes, plain +/- markers, no trailing pad', () => {
    const r = renderFileChangeRows(
      { before: 'a\nb\n', after: 'a\nB\n', path: 'f' },
      plain,
      { width: 80, scheme: 'dark' },
    );
    for (const row of r!.rows) {
      expect(row).not.toContain(ESC);
      expect(row).toBe(strip(row));
    }
    expect(r!.rows.map(strip)).toEqual(['1   a', '2 - b', '2 + B']);
  });

  it('colored: add rows carry the dark-green bg across the full row width', () => {
    const r = renderFileChangeRows(
      { before: 'a\nb\nc\n', after: 'a\nB\nc\n', path: 'f' },
      color,
      { width: 60, scheme: 'dark' },
    );
    const addRow = r!.rows.find((row) => strip(row).includes('+ B'))!;
    const delRow = r!.rows.find((row) => strip(row).includes('- b'))!;
    const ctxRow = r!.rows.find((row) => strip(row).trim() === '1   a')!;
    // #12351f added bg / #3d1418 removed bg
    expect(addRow).toContain('48;2;18;53;31');
    expect(delRow).toContain('48;2;61;20;24');
    expect(ctxRow).not.toContain('48;2;');
    // full-width background pad on change rows only
    expect(terminalTextWidth(addRow)).toBe(60);
    expect(terminalTextWidth(delRow)).toBe(60);
    expect(terminalTextWidth(ctxRow)).toBeLessThan(60);
  });

  it('colored: the gutter dims but the marker and code do NOT inherit it (SGR state tracking)', () => {
    const r = renderFileChangeRows(
      { before: 'a\nb\n', after: 'a\nB\n', path: 'f' },
      color,
      { width: 40, scheme: 'dark' },
    );
    const addRow = r!.rows.find((row) => strip(row).includes('+ B'))!;
    // gutter: dim (2) + gray fg on the green bg
    expect(addRow).toContain('2;38;2;107;114;128;48;2;18;53;31');
    // marker: green marker fg on the bg, NO dim — a fresh reset restates attrs
    expect(addRow).toContain(`${ESC}[0m${ESC}[38;2;63;185;80;48;2;18;53;31m`);
    // code: addedFg on the bg, also dim-free
    expect(addRow).toContain(`${ESC}[0m${ESC}[38;2;126;231;135;48;2;18;53;31m`);
  });

  it('mono diff palette on a color theme: bold markers, no hue escapes', () => {
    const r = renderFileChangeRows(
      { before: 'a\n', after: 'A\n', path: 'f' },
      color,
      { width: 60, palette: 'mono', scheme: 'dark' },
    );
    for (const row of r!.rows) {
      expect(row).not.toContain('48;2;');
      expect(row).not.toContain('38;2;');
    }
    expect(strip(r!.rows[0]!)).toBe('1 - a');
    expect(strip(r!.rows[1]!)).toBe('1 + A');
  });
});

describe('renderFileChangeToolResult', () => {
  it('composes the result line + body for a created file', () => {
    const r = renderFileChangeToolResult({ before: '', after: bigFile, path: 'src/new.ts' }, plain, {
      width: 80,
      expandHint: true,
    });
    expect(r!.result).toBe('Wrote 182 lines to src/new.ts');
    expect(r!.rows).toHaveLength(11);
    expect(r!.expandable).toBe(true);
  });

  it('undefined for binary / no-op (the caller falls back to the summary)', () => {
    expect(
      renderFileChangeToolResult({ before: 'a\n', after: 'a\n', path: 'f' }, plain, { width: 80 }),
    ).toBeUndefined();
  });
});

describe('chatui integration', () => {
  it('renderToolStart: ● is dim while running, green on success, red on failure', () => {
    expect(strip(renderToolStart('write_file', 'write_file(src/a.ts)', plain))).toBe(
      '● Write(src/a.ts)',
    );
    const ok = renderToolStart('write_file', 'write_file(src/a.ts)', color, 'ok');
    const err = renderToolStart('write_file', 'write_file(src/a.ts)', color, 'error');
    const run = renderToolStart('write_file', 'write_file(src/a.ts)', color, 'running');
    // success #34d399 / error #fb7185 / running = the dim space gray #6b7280
    expect(ok).toContain('38;2;52;211;153');
    expect(err).toContain('38;2;251;113;133');
    expect(run).toContain('38;2;107;114;128');
    expect(strip(ok)).toBe('● Write(src/a.ts)');
    expect(strip(err)).toBe('● Write(src/a.ts)');
  });

  it('edit_file displays as Update, remove as Delete', () => {
    expect(strip(renderToolStart('edit_file', 'edit_file(src/a.ts)', plain))).toBe(
      '● Update(src/a.ts)',
    );
    expect(strip(renderToolStart('remove', 'remove(old.txt)', plain))).toBe('● Delete(old.txt)');
  });

  it('renderToolResult: the payload path yields "⎿  Wrote …" + rows + a ctrl+r toggle', () => {
    const r = renderToolResult(
      {
        name: 'write_file',
        label: 'write_file(src/new.ts)',
        ok: true,
        summary: 'wrote src/new.ts (3.5 KB)',
        diffPayload: { before: '', after: bigFile, path: 'src/new.ts', kind: 'created' },
      },
      plain,
      { width: 80, expandHint: true },
    );
    expect(strip(r.lines[0]!)).toBe('  ⎿  Wrote 182 lines to src/new.ts');
    expect(r.lines).toHaveLength(12); // result line + 10 preview + elision
    expect(r.fileChange).toBeDefined();
    expect(r.fileChange!.expanded).toBe(false);
    const full = r.fileChange!.render(true);
    expect(full).toHaveLength(182);
    const collapsed = r.fileChange!.render(false);
    expect(collapsed).toHaveLength(11);
  });

  it('renderToolResult: edit results read "⎿  Updated path with …"', () => {
    const before = ['a', 'b', 'c', 'd', 'e'].join('\n') + '\n';
    const r = renderToolResult(
      {
        name: 'edit_file',
        label: 'edit_file(f.ts)',
        ok: true,
        summary: 'edited f.ts: replaced 1 occurrence (1 → 1 chars)',
        diffPayload: { before, after: before.replace('b\n', 'B\n'), path: 'f.ts', kind: 'modified' },
      },
      plain,
      { width: 80 },
    );
    expect(strip(r.lines[0]!)).toBe('  ⎿  Updated f.ts with 1 addition and 1 removal');
    expect(r.lines.map(strip)).toContain('2 - b');
    expect(r.lines.map(strip)).toContain('2 + B');
  });

  it('renderToolResult: a failed result keeps the red summary, payload ignored', () => {
    const r = renderToolResult(
      {
        name: 'write_file',
        label: 'write_file(f.ts)',
        ok: false,
        summary: 'denied by user',
        diffPayload: { before: '', after: 'x\n', path: 'f.ts', kind: 'created' },
      },
      plain,
      { width: 80 },
    );
    expect(strip(r.lines[0]!)).toBe('  ⎿ denied by user');
    expect(r.fileChange).toBeUndefined();
  });

  it('renderToolResult: no payload → the classic summary + content collapse', () => {
    const r = renderToolResult(
      {
        name: 'read_file',
        label: 'read_file(f.ts)',
        ok: true,
        summary: 'read f.ts (7 lines, 20 B)',
        content: 'l1\nl2\nl3\nl4\nl5\nl6\nl7',
      },
      plain,
    );
    expect(strip(r.lines[0]!)).toBe('  ⎿ read f.ts (7 lines, 20 B)');
    expect(strip(r.lines.at(-1)!)).toBe('      … +2 lines');
  });
});
