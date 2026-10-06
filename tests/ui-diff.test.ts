/**
 * Diff tests: Myers line diff correctness (pure insertion, pure deletion,
 * mixed edits) with 1-based line numbers on both sides, trailing-newline
 * semantics, the all-context (identical) documented behavior, context
 * grouping with gap elision in renderDiffLines, the >2000 edit-distance
 * fallback to whole-block replace, and the plainDiffStyle prefixes.
 */

import { describe, expect, it } from 'vitest';
import {
  computeDiff,
  plainDiffStyle,
  renderDiffLines,
  renderUnifiedDiff,
  type DiffLine,
} from '../src/ui/diff.js';

const plain = plainDiffStyle();

function lines(...text: string[]): string[] {
  return text;
}

/** Strip to the op/number skeleton for structure assertions. */
function skeleton(
  diff: readonly DiffLine[],
): Array<[DiffLine['op'], number | null, number | null]> {
  return diff.map((l) => [l.op, l.before, l.after]);
}

describe('computeDiff basics', () => {
  it('pure insertion: numbers and nulls on the correct sides', () => {
    const diff = computeDiff('a\nb\nc', 'a\nb\nX\nc');
    expect(skeleton(diff)).toEqual([
      ['ctx', 1, 1],
      ['ctx', 2, 2],
      ['add', null, 3],
      ['ctx', 3, 4],
    ]);
    expect(diff[2]!.text).toBe('X');
  });

  it('pure deletion', () => {
    const diff = computeDiff('a\nX\nb', 'a\nb');
    expect(skeleton(diff)).toEqual([
      ['ctx', 1, 1],
      ['del', 2, null],
      ['ctx', 3, 2],
    ]);
    expect(diff[1]!.text).toBe('X');
  });

  it('mixed change at both ends with a shared middle', () => {
    const diff = computeDiff('one\nc\ntwo', 'ONE\nc\nTWO');
    expect(skeleton(diff)).toEqual([
      ['del', 1, null],
      ['add', null, 1],
      ['ctx', 2, 2],
      ['del', 3, null],
      ['add', null, 3],
    ]);
  });

  it('identical input is all ctx with matching numbers on both sides', () => {
    const diff = computeDiff('a\nb\n', 'a\nb\n');
    expect(skeleton(diff)).toEqual([
      ['ctx', 1, 1],
      ['ctx', 2, 2],
    ]);
  });

  it('a trailing newline is a terminator, not an extra empty line', () => {
    // 'a\n' vs 'a' are the same single line, not a one-line vs two-line file
    expect(skeleton(computeDiff('a\n', 'a'))).toEqual([['ctx', 1, 1]]);
    // inserting after the final newline adds one real line, not two
    expect(skeleton(computeDiff('a\n', 'a\nb\n'))).toEqual([
      ['ctx', 1, 1],
      ['add', null, 2],
    ]);
  });

  it('empty texts diff to empty', () => {
    expect(computeDiff('', '')).toEqual([]);
  });

  it('insert into empty and delete to empty', () => {
    expect(skeleton(computeDiff('', 'x\ny'))).toEqual([
      ['add', null, 1],
      ['add', null, 2],
    ]);
    expect(skeleton(computeDiff('x\ny', ''))).toEqual([
      ['del', 1, null],
      ['del', 2, null],
    ]);
  });
});

describe('large-change fallback', () => {
  it('no common lines at 3000x3000 falls back to whole-block replace', () => {
    const before = lines(...Array.from({ length: 3000 }, () => 'a')).join('\n');
    const after = lines(...Array.from({ length: 3000 }, () => 'b')).join('\n');
    const diff = computeDiff(before, after);
    expect(diff.length).toBe(6001);
    expect(diff[0]).toEqual({
      op: 'meta',
      before: null,
      after: null,
      text: 'large change — full before/after shown',
    });
    // every before line is a del with its number, every after line an add
    expect(diff[1]).toEqual({ op: 'del', before: 1, after: null, text: 'a' });
    expect(diff[3000]).toEqual({ op: 'del', before: 3000, after: null, text: 'a' });
    expect(diff[3001]).toEqual({ op: 'add', before: null, after: 1, text: 'b' });
    expect(diff[6000]).toEqual({ op: 'add', before: null, after: 3000, text: 'b' });
    // and it still renders through the meta path
    const rendered = renderDiffLines(diff, plain, { context: 3 });
    expect(rendered[0]).toBe('        ··· large change — full before/after shown ···');
    expect(rendered.length).toBe(6001);
  });

  it('a diff just under the cap still uses Myers (small change inside huge files)', () => {
    const before = lines(...Array.from({ length: 1500 }, (_, i) => `x${i}`)).join('\n');
    const after = lines(
      ...Array.from({ length: 1500 }, (_, i) => (i === 750 ? 'CHANGED' : `x${i}`)),
    ).join('\n');
    const diff = computeDiff(before, after);
    // a single-line change — real diff, not the fallback
    expect(diff.filter((l) => l.op === 'del' || l.op === 'add').length).toBe(2);
  });
});

describe('plainDiffStyle', () => {
  it('prefixes and zero-padded line numbers', () => {
    expect(plain.add('x')).toBe('+ x');
    expect(plain.del('x')).toBe('- x');
    expect(plain.ctx('x')).toBe('  x');
    expect(plain.meta('5 unchanged lines')).toBe('··· 5 unchanged lines ···');
    expect(plain.lineNo(1)).toBe('001');
    expect(plain.lineNo(42)).toBe('042');
    expect(plain.lineNo(1234)).toBe('1234'); // past width 3, not truncated
  });
});

describe('renderDiffLines', () => {
  it('output rows are <before> <after> <styled>, missing numbers as spaces', () => {
    const diff = computeDiff('a\nb', 'a\nX\nb');
    expect(renderDiffLines(diff, plain, { context: 3 })).toEqual([
      '001 001   a',
      '    002 + X',
      '002 003   b',
    ]);
  });

  it('default context is 3', () => {
    const before = lines(...Array.from({ length: 20 }, (_, i) => `c${i}`)).join('\n');
    const diff = computeDiff(before, before.replace('c0\n', 'K\n'));
    const rendered = renderDiffLines(diff, plain);
    const rendered2 = renderDiffLines(diff, plain, { context: 3 });
    expect(rendered).toEqual(rendered2);
  });

  it('mixed change with 3-line context elides the long unchanged middle', () => {
    const before = lines(
      'one',
      'c2',
      'c3',
      'c4',
      'c5',
      'c6',
      'c7',
      'c8',
      'c9',
      'c10',
      'c11',
      'two',
    ).join('\n');
    const after = before.replace('one\n', 'ONE\n').replace('two', 'TWO');
    const rendered = renderUnifiedDiff(before, after, plain);
    expect(rendered).toEqual([
      '001     - one',
      '    001 + ONE',
      '002 002   c2',
      '003 003   c3',
      '004 004   c4',
      '        ··· 4 unchanged lines ···',
      '009 009   c9',
      '010 010   c10',
      '011 011   c11',
      '012     - two',
      '    012 + TWO',
    ]);
  });

  it('a skipped run of exactly one line is shown, not replaced by a meta line', () => {
    // edits 2 lines apart with context 0: each single skipped ctx renders as-is
    const diff: DiffLine[] = [
      { op: 'ctx', before: 1, after: 1, text: 'a' },
      { op: 'del', before: 2, after: null, text: 'x' },
      { op: 'ctx', before: 3, after: 2, text: 'middle' },
      { op: 'add', before: null, after: 3, text: 'y' },
    ];
    expect(renderDiffLines(diff, plain, { context: 0 })).toEqual([
      '001 001   a',
      '002     - x',
      '003 002   middle',
      '    003 + y',
    ]);
  });

  it('context 0 elides multi-line unchanged runs but keeps the edits', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nb\nX\nd\ne';
    expect(renderUnifiedDiff(before, after, plain, { context: 0 })).toEqual([
      '        ··· 2 unchanged lines ···',
      '003     - c',
      '    003 + X',
      '        ··· 2 unchanged lines ···',
    ]);
  });

  it('identical inputs render as [] (documented: nothing to show)', () => {
    expect(renderDiffLines(computeDiff('a\nb', 'a\nb'), plain)).toEqual([]);
    expect(renderDiffLines([], plain)).toEqual([]);
    expect(renderUnifiedDiff('same', 'same', plain)).toEqual([]);
  });

  it('renderUnifiedDiff equals renderDiffLines over computeDiff', () => {
    const before = 'a\nb\nc';
    const after = 'a\nQ\nc\nd';
    expect(renderUnifiedDiff(before, after, plain, { context: 1 })).toEqual(
      renderDiffLines(computeDiff(before, after), plain, { context: 1 }),
    );
  });
});
