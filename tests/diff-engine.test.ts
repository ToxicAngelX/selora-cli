/**
 * Diff-engine tests: hunk building and merging, section headers, word-level
 * segments (and their exact-rejoin invariant), EOL/newline round-trips,
 * binary + generated detection, rename pairing, unified-patch structure,
 * applyHunks verification, and fast-check properties pinning the central
 * invariant: applyHunks(a, diff(a→b), all) === b, byte-for-byte.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import {
  applyHunks,
  computeFileDiff,
  detectEol,
  isBinaryData,
  isBinaryText,
  isGeneratedPath,
  pairRenames,
  similarity,
  toUnifiedPatch,
} from '../src/diff/engine.js';
import type { FileChange, FileDiff, Hunk } from '../src/diff/types.js';

const mod = (oldText: string, newText: string): FileDiff =>
  computeFileDiff({ kind: 'modified', path: 'f.txt', oldText, newText });

const allIndices = (d: FileDiff): number[] => d.hunks.map((_, i) => i);

/** The central invariant, asserted for one pair. */
function expectRoundTrip(a: string, b: string): FileDiff {
  const d = mod(a, b);
  const r = applyHunks(a, d, allIndices(d));
  if (!r.ok) throw new Error(`round-trip rejected: ${r.error.message}`);
  expect(r.value).toBe(b);
  return d;
}

// ---------------------------------------------------------------------------
// basic shapes
// ---------------------------------------------------------------------------

describe('computeFileDiff: basic shapes', () => {
  it('pure insertion: one add row, ctx around it, hunk bounds per GNU', () => {
    const d = mod('a\nb\nc', 'a\nb\nX\nc');
    expect(d.hunks.length).toBe(1);
    const h = d.hunks[0]!;
    expect(h.lines.map((l) => l.kind)).toEqual(['ctx', 'ctx', 'add', 'ctx']);
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(3);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(4);
    expect(d.stats).toEqual({ added: 1, removed: 0, hunks: 1 });
    expect(d.unchanged).toBe(false);
  });

  it('pure deletion', () => {
    const d = mod('a\nX\nb', 'a\nb');
    expect(d.stats).toEqual({ added: 0, removed: 1, hunks: 1 });
    const h = d.hunks[0]!;
    expect(h.lines.map((l) => l.kind)).toEqual(['ctx', 'del', 'ctx']);
    expect(h.oldLines).toBe(3);
    expect(h.newLines).toBe(2);
  });

  it('mixed modify: del+add pair in one hunk, words attached to both', () => {
    const d = mod('a\nb\nc', 'a\nB\nc');
    const h = d.hunks[0]!;
    const del = h.lines.find((l) => l.kind === 'del')!;
    const add = h.lines.find((l) => l.kind === 'add')!;
    expect(del.text).toBe('b');
    expect(add.text).toBe('B');
    expect(del.words).toBeDefined();
    expect(add.words).toBeDefined();
  });

  it('moved block: both adds and dels somewhere, and it round-trips', () => {
    const a = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight';
    const b = 'one\nfive\nsix\ntwo\nthree\nfour\nseven\neight';
    const d = expectRoundTrip(a, b);
    expect(d.stats.added).toBeGreaterThan(0);
    expect(d.stats.removed).toBeGreaterThan(0);
  });

  it('created: old side is empty, hunk starts at old 0,0', () => {
    const d = computeFileDiff({ kind: 'created', path: 'n.txt', newText: 'x\ny\n' });
    expect(d.stats).toEqual({ added: 2, removed: 0, hunks: 1 });
    const h = d.hunks[0]!;
    expect(h.oldStart).toBe(0);
    expect(h.oldLines).toBe(0);
    expect(h.newStart).toBe(1);
    expect(h.newLines).toBe(2);
    expect(h.lines.every((l) => l.kind === 'add')).toBe(true);
  });

  it('deleted: new side is empty, hunk starts at new 0,0', () => {
    const d = computeFileDiff({ kind: 'deleted', path: 'n.txt', oldText: 'x\ny\n' });
    expect(d.stats).toEqual({ added: 0, removed: 2, hunks: 1 });
    const h = d.hunks[0]!;
    expect(h.newStart).toBe(0);
    expect(h.newLines).toBe(0);
    expect(h.oldStart).toBe(1);
    expect(h.oldLines).toBe(2);
  });

  it('renamed change diffs content like modified; path is the NEW path', () => {
    const change: FileChange = {
      kind: 'renamed',
      oldPath: 'old.txt',
      path: 'new.txt',
      oldText: 'a\nb',
      newText: 'a\nB',
      similarity: 0.9,
    };
    const d = computeFileDiff(change);
    expect(d.change.path).toBe('new.txt');
    expect(d.stats).toEqual({ added: 1, removed: 1, hunks: 1 });
  });

  it('unchanged: identical texts → no hunks, unchanged flag, whitespaceOnly false', () => {
    const d = mod('x\ny\n', 'x\ny\n');
    expect(d.hunks).toEqual([]);
    expect(d.stats).toEqual({ added: 0, removed: 0, hunks: 0 });
    expect(d.unchanged).toBe(true);
    expect(d.whitespaceOnly).toBe(false);
  });

  it('empty ↔ empty, empty → text, text → empty all round-trip', () => {
    expectRoundTrip('', '');
    expect(mod('', '').unchanged).toBe(true);
    expectRoundTrip('', 'x\ny');
    expectRoundTrip('x\ny', '');
    expectRoundTrip('', 'x\ny\n');
  });

  it('stats count every add and del row across hunks', () => {
    const a = 'l0\nl1\nl2\nl3\nl4\nl5\nl6\nl7\nl8\nl9\nl10\nl11\nl12\nl13';
    const b = a.replace('l1\n', 'L1\n').replace('l12\nl13', 'L12\nL13\nL14');
    const d = mod(a, b);
    expect(d.stats.added).toBe(4);
    expect(d.stats.removed).toBe(3);
    expect(d.stats.hunks).toBe(d.hunks.length);
  });
});

// ---------------------------------------------------------------------------
// whitespace-only
// ---------------------------------------------------------------------------

describe('whitespaceOnly', () => {
  it('true when only indentation changed', () => {
    const d = mod('a\n  b\nc', 'a\n    b\nc');
    expect(d.unchanged).toBe(false);
    expect(d.whitespaceOnly).toBe(true);
  });

  it('true for tab↔space changes across multiple hunks', () => {
    const a = 'x\n\ta\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n\tb\nz';
    const b = 'x\n    a\nl3\nl4\nl5\nl6\nl7\nl8\nl9\n        b\nz';
    const d = mod(a, b);
    expect(d.hunks.length).toBe(2);
    expect(d.whitespaceOnly).toBe(true);
  });

  it('false when any content differs', () => {
    expect(mod('a\n  b', 'a\n  B').whitespaceOnly).toBe(false);
    // one whitespace-only hunk + one real change → false overall
    const a = '  a\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n  b';
    const b = ' a\nl1\nl2\nl3\nl4\nl5\nl6\nl7\n  B';
    expect(mod(a, b).whitespaceOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// EOL + trailing newline
// ---------------------------------------------------------------------------

describe('detectEol', () => {
  it('classifies empty, terminator-free, LF, CRLF, and mixed', () => {
    expect(detectEol('')).toBe('none');
    expect(detectEol('abc')).toBe('none');
    expect(detectEol('a\nb\n')).toBe('lf');
    expect(detectEol('a\nb')).toBe('lf');
    expect(detectEol('a\r\nb\r\n')).toBe('crlf');
    expect(detectEol('a\r\nb')).toBe('crlf');
    expect(detectEol('a\nb\r\nc')).toBe('mixed');
    expect(detectEol('a\rb')).toBe('mixed'); // lone CR counts as a terminator style
    expect(detectEol('\n')).toBe('lf');
  });
});

describe('EOL round-trips', () => {
  it('CRLF file round-trips byte-exactly and reports crlf on both sides', () => {
    const a = 'l1\r\nl2\r\nl3\r\n';
    const b = 'l1\r\nL2\r\nl3\r\n';
    const d = expectRoundTrip(a, b);
    expect(d.oldEol).toBe('crlf');
    expect(d.newEol).toBe('crlf');
    expect(d.oldEndsWithNewline).toBe(true);
    expect(d.newEndsWithNewline).toBe(true);
  });

  it('CRLF without trailing newline round-trips', () => {
    expectRoundTrip('l1\r\nl2', 'l1\r\nL2');
  });

  it('LF→CRLF conversion re-encodes on apply', () => {
    const d = expectRoundTrip('a\nb\n', 'a\r\nb\r\n');
    expect(d.oldEol).toBe('lf');
    expect(d.newEol).toBe('crlf');
  });

  it('missing trailing newline, both directions', () => {
    expectRoundTrip('a\nb', 'a\nb\n'); // gained
    expectRoundTrip('a\nb\n', 'a\nb'); // lost
    const d1 = mod('a\nb', 'a\nb\n');
    expect(d1.oldEndsWithNewline).toBe(false);
    expect(d1.newEndsWithNewline).toBe(true);
  });

  it('EOL-only change: zero hunks, apply(all) still produces b exactly', () => {
    const d = mod('x\ny\n', 'x\r\ny\r\n');
    expect(d.hunks).toEqual([]);
    const r = applyHunks('x\ny\n', d, []);
    expect(r).toEqual({ ok: true, value: 'x\r\ny\r\n' });
  });
});

// ---------------------------------------------------------------------------
// binary + generated
// ---------------------------------------------------------------------------

describe('binary detection', () => {
  it('isBinaryText: NUL, control ratio, clean text', () => {
    expect(isBinaryText('')).toBe(false);
    expect(isBinaryText('hello\nworld\n')).toBe(false);
    expect(isBinaryText('a\0b')).toBe(true);
    expect(isBinaryText('\x01'.repeat(10) + 'a'.repeat(5))).toBe(true);
    expect(isBinaryText('\x01' + 'a'.repeat(100))).toBe(false);
  });

  it('isBinaryData: empty, text, NUL, control ratio', () => {
    expect(isBinaryData(new Uint8Array([]))).toBe(false);
    expect(isBinaryData(new TextEncoder().encode('plain text\n'))).toBe(false);
    expect(isBinaryData(new Uint8Array([65, 0, 66]))).toBe(true);
    const control = new Uint8Array(100).fill(1);
    control.fill(65, 0, 50); // 50% control
    expect(isBinaryData(control)).toBe(true);
  });

  it('computeFileDiff short-circuits on binary: sizes, no hunks, zero stats', () => {
    const d = mod('a\0bc', 'xy');
    expect(d.binary).toEqual({ oldSize: 4, newSize: 2 });
    expect(d.hunks).toEqual([]);
    expect(d.stats).toEqual({ added: 0, removed: 0, hunks: 0 });
  });
});

describe('isGeneratedPath', () => {
  it('lockfiles, minified, maps, snaps, hashed dist chunks; plain files pass', () => {
    const yes = [
      'package-lock.json',
      'sub/dir/package-lock.json',
      'yarn.lock',
      'pnpm-lock.yaml',
      'Cargo.lock',
      'Gemfile.lock',
      'poetry.lock',
      'composer.lock',
      'go.sum',
      'app.min.js',
      'styles.min.css',
      'bundle.js.map',
      '__snapshots__/x.snap',
      'dist/index-a1b2c3d4.js',
      'build/chunk.0a1b2c3d.css',
    ];
    const no = ['src/index.ts', 'src/utils.js', 'dist/index.js', 'README.md', 'src/app.css'];
    for (const p of yes) expect(isGeneratedPath(p), p).toBe(true);
    for (const p of no) expect(isGeneratedPath(p), p).toBe(false);
  });

  it('computeFileDiff flags generated files', () => {
    const d = computeFileDiff({
      kind: 'modified',
      path: 'package-lock.json',
      oldText: 'a',
      newText: 'b',
    });
    expect(d.generated).toBe(true);
    expect(mod('a', 'b').generated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hunks: merging + headers
// ---------------------------------------------------------------------------

describe('hunk merging', () => {
  const base = Array.from({ length: 20 }, (_, i) => `c${i}`).join('\n');

  it('changes 5 ctx rows apart (gap ≤ 2·context) merge into one hunk', () => {
    const b = base.replace('c2', 'C2').replace('c8', 'C8');
    const d = mod(base, b);
    expect(d.hunks.length).toBe(1);
    expect(d.stats).toEqual({ added: 2, removed: 2, hunks: 1 });
  });

  it('changes 7 ctx rows apart (gap > 2·context) stay two hunks', () => {
    const b = base.replace('c2', 'C2').replace('c10', 'C10');
    const d = mod(base, b);
    expect(d.hunks.length).toBe(2);
    expect(d.hunks[0]!.lines.some((l) => l.text === 'C2')).toBe(true);
    expect(d.hunks[1]!.lines.some((l) => l.text === 'C10')).toBe(true);
  });

  it('context 0 keeps only changed rows', () => {
    const d = computeFileDiff(
      { kind: 'modified', path: 'f.txt', oldText: 'a\nb\nc', newText: 'a\nB\nc' },
      { context: 0 },
    );
    expect(d.hunks[0]!.lines.map((l) => l.kind)).toEqual(['del', 'add']);
  });

  it('the ui fallback (edit distance > 2000) degrades to ONE whole-file hunk', () => {
    const a = Array.from({ length: 2500 }, () => 'a').join('\n');
    const b = Array.from({ length: 2500 }, () => 'b').join('\n');
    const d = mod(a, b);
    expect(d.hunks.length).toBe(1);
    expect(d.stats).toEqual({ added: 2500, removed: 2500, hunks: 1 });
    expectRoundTrip(a, b);
  });
});

describe('hunk section headers', () => {
  it('carries the nearest preceding declaration line', () => {
    const a = [
      'function beta() {',
      '  const x = 1;',
      '  const y = 2;',
      '  const z = 3;',
      '  return 2;',
      '}',
    ].join('\n');
    const d = mod(a, a.replace('return 2;', 'return 42;'));
    expect(d.hunks[0]!.header).toBe('function beta() {');
  });

  it('is empty when no declaration precedes the hunk', () => {
    const d = mod('plain\ntext\nhere\nnothing', 'plain\ntext\nhere\nchanged');
    expect(d.hunks[0]!.header).toBe('');
  });
});

// ---------------------------------------------------------------------------
// word segments
// ---------------------------------------------------------------------------

describe('word-level diffs', () => {
  it('paired single-line change marks exactly the changed tokens; segments rejoin', () => {
    const d = mod('const timeout = 30;', 'const timeout = 60;');
    const h = d.hunks[0]!;
    const del = h.lines.find((l) => l.kind === 'del')!;
    const add = h.lines.find((l) => l.kind === 'add')!;
    expect(del.words).toBeDefined();
    expect(add.words).toBeDefined();
    expect(del.words!.map((w) => w.text).join('')).toBe(del.text);
    expect(add.words!.map((w) => w.text).join('')).toBe(add.text);
    expect(del.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(['30']);
    expect(add.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(['60']);
  });

  it('ctx lines never carry words', () => {
    const d = mod('a\nb\nc', 'a\nB\nc');
    for (const l of d.hunks[0]!.lines) {
      if (l.kind === 'ctx') expect(l.words).toBeUndefined();
    }
  });

  it('unequal runs pair greedily by similarity; poor matches stay unmarked', () => {
    const d = mod('foo(a, b);\nbar(c);', 'foo(a, b, c);');
    const h = d.hunks[0]!;
    const dels = h.lines.filter((l) => l.kind === 'del');
    const adds = h.lines.filter((l) => l.kind === 'add');
    expect(dels.length).toBe(2);
    expect(adds.length).toBe(1);
    expect(adds[0]!.words).toBeDefined();
    const pairedDel = dels.find((l) => l.words !== undefined)!;
    expect(pairedDel.text).toBe('foo(a, b);');
    const unpaired = dels.find((l) => l.words === undefined)!;
    expect(unpaired.text).toBe('bar(c);');
    // and the paired del still rejoins exactly
    expect(pairedDel.words!.map((w) => w.text).join('')).toBe(pairedDel.text);
  });

  it('whitespace change marks the whitespace token', () => {
    const d = mod('  return x;', '    return x;');
    const del = d.hunks[0]!.lines.find((l) => l.kind === 'del')!;
    const add = d.hunks[0]!.lines.find((l) => l.kind === 'add')!;
    expect(del.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(['  ']);
    expect(add.words!.filter((w) => w.changed).map((w) => w.text)).toEqual(['    ']);
  });
});

// ---------------------------------------------------------------------------
// applyHunks
// ---------------------------------------------------------------------------

describe('applyHunks', () => {
  it('accepted=[] returns oldText byte-identical when hunks exist', () => {
    const a = 'a\r\nb\r\nc\r\n';
    const d = mod(a, 'a\r\nB\r\nc\r\n');
    expect(applyHunks(a, d, [])).toEqual({ ok: true, value: a });
  });

  it('applies a subset of hunks (first of two)', () => {
    const a = Array.from({ length: 20 }, (_, i) => `c${i}`).join('\n');
    const b = a.replace('c2', 'C2').replace('c10', 'C10');
    const d = mod(a, b);
    expect(d.hunks.length).toBe(2);
    const r = applyHunks(a, d, [0]);
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value).toBe(a.replace('c2', 'C2'));
  });

  it('verifies context: tampered old text → PATCH_MISMATCH naming the hunk', () => {
    const a = 'a\nb\nc';
    const d = mod(a, 'a\nB\nc');
    const r = applyHunks('a\nTAMPERED\nc', d, [0]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('PATCH_MISMATCH');
    expect(r.error.message).toContain('hunk 0');
  });

  it('out-of-range indices are ignored; unknown-only means "apply nothing"', () => {
    const a = 'a\nb';
    const d = mod(a, 'a\nB');
    expect(applyHunks(a, d, [99])).toEqual({ ok: true, value: a });
    expect(applyHunks(a, d, [0, 99]).ok).toBe(true);
  });

  it('duplicate indices apply once', () => {
    const a = 'a\nb';
    const b = 'a\nB';
    const d = mod(a, b);
    const r = applyHunks(a, d, [0, 0]);
    expect(r).toEqual({ ok: true, value: b });
  });
});

// ---------------------------------------------------------------------------
// modeChange
// ---------------------------------------------------------------------------

describe('modeChange', () => {
  it('detected only when both modes are known and differ', () => {
    const base = { kind: 'modified' as const, path: 's.sh', oldText: 'x', newText: 'x' };
    expect(computeFileDiff({ ...base, oldMode: 0o644, newMode: 0o755 }).modeChange).toEqual({
      from: 0o644,
      to: 0o755,
    });
    expect(computeFileDiff({ ...base, oldMode: 0o644, newMode: 0o644 }).modeChange).toBeUndefined();
    expect(computeFileDiff({ ...base, oldMode: 0o644 }).modeChange).toBeUndefined();
    expect(computeFileDiff(base).modeChange).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// similarity + pairRenames
// ---------------------------------------------------------------------------

describe('similarity', () => {
  it('identical → 1, disjoint → 0, half → 0.5, empty pair → 1', () => {
    expect(similarity('a\nb', 'a\nb')).toBe(1);
    expect(similarity('a\nb', 'c\nd')).toBe(0);
    expect(similarity('a\nb', 'a\nc')).toBe(0.5);
    expect(similarity('', '')).toBe(1);
    expect(similarity('', 'x')).toBe(0);
  });

  it('is a multiset measure: duplicated lines count min(occurrences)', () => {
    expect(similarity('a\na\na', 'a\na\nb')).toBeCloseTo(2 / 3);
  });
});

describe('pairRenames', () => {
  const fiveLines = 'l1\nl2\nl3\nl4\nl5';

  it('merges a similar delete+create into one renamed change', () => {
    const out = pairRenames([
      { kind: 'deleted', path: 'old.txt', oldText: fiveLines },
      { kind: 'created', path: 'new.txt', newText: 'l1\nl2\nl3\nl4\nCHANGED' },
    ]);
    expect(out.length).toBe(1);
    const r = out[0]!;
    expect(r.kind).toBe('renamed');
    if (r.kind !== 'renamed') return;
    expect(r.oldPath).toBe('old.txt');
    expect(r.path).toBe('new.txt');
    expect(r.oldText).toBe(fiveLines);
    expect(r.newText).toBe('l1\nl2\nl3\nl4\nCHANGED');
    expect(r.similarity).toBeCloseTo(0.8);
  });

  it('below the threshold the pair stays delete+create', () => {
    const changes: FileChange[] = [
      { kind: 'deleted', path: 'a.txt', oldText: 'a\nb\nc' },
      { kind: 'created', path: 'b.txt', newText: 'x\ny\nz' },
    ];
    expect(pairRenames(changes)).toEqual(changes);
  });

  it('respects an explicit threshold', () => {
    const changes: FileChange[] = [
      { kind: 'deleted', path: 'old.txt', oldText: fiveLines },
      { kind: 'created', path: 'new.txt', newText: 'l1\nl2\nl3\nl4\nCHANGED' }, // 0.8
    ];
    expect(pairRenames(changes, 0.9).length).toBe(2);
    expect(pairRenames(changes, 0.7).length).toBe(1);
  });

  it('greedy: each file is used once, best match wins', () => {
    const out = pairRenames([
      { kind: 'deleted', path: 'gone.txt', oldText: fiveLines },
      { kind: 'created', path: 'close.txt', newText: 'l1\nl2\nl3\nl4\nl9' }, // 0.8
      { kind: 'created', path: 'far.txt', newText: 'l1\nx\ny\nz\nw' }, // 0.2
    ]);
    expect(out.length).toBe(2);
    const rename = out.find((c) => c.kind === 'renamed')!;
    expect(rename.path).toBe('close.txt');
    expect(out.some((c) => c.kind === 'created' && c.path === 'far.txt')).toBe(true);
  });

  it('unrelated changes pass through untouched; same-path pairs never merge', () => {
    const m: FileChange = { kind: 'modified', path: 'm.txt', oldText: 'a', newText: 'b' };
    const out = pairRenames([
      { kind: 'deleted', path: 'same.txt', oldText: 'a\nb' },
      m,
      { kind: 'created', path: 'same.txt', newText: 'a\nb' },
    ]);
    expect(out.length).toBe(3);
    expect(out[1]).toBe(m);
    expect(out.every((c) => c.kind !== 'renamed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// toUnifiedPatch
// ---------------------------------------------------------------------------

/** Structural check: every @@ header's counts match the rows that follow it. */
function expectConsistentHunks(patch: string): number {
  const lines = patch.split('\n');
  let hunks = 0;
  let i = 0;
  while (i < lines.length) {
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[i]!);
    if (!m) {
      i += 1;
      continue;
    }
    hunks += 1;
    const wantOld = m[2] === undefined ? 1 : Number(m[2]);
    const wantNew = m[4] === undefined ? 1 : Number(m[4]);
    let oldCount = 0;
    let newCount = 0;
    i += 1;
    while (i < lines.length && /^[ \-+\\]/.test(lines[i]!) && !lines[i]!.startsWith('@@')) {
      const row = lines[i]!;
      if (row.startsWith(' ')) {
        oldCount += 1;
        newCount += 1;
      } else if (row.startsWith('-')) {
        oldCount += 1;
      } else if (row.startsWith('+')) {
        newCount += 1;
      } // '\ No newline at end of file' attaches to the previous row
      i += 1;
    }
    expect(oldCount, `old count in ${m[0]}`).toBe(wantOld);
    expect(newCount, `new count in ${m[0]}`).toBe(wantNew);
  }
  return hunks;
}

describe('toUnifiedPatch', () => {
  it('modified: git header, ---/+++ headers, hunk rows with GNU counts', () => {
    const d = mod('a\nb\nc\n', 'a\nB\nc\n');
    const patch = toUnifiedPatch(d);
    const lines = patch.split('\n');
    expect(lines[0]).toBe('diff --git a/f.txt b/f.txt');
    expect(lines[1]).toBe('--- a/f.txt');
    expect(lines[2]).toBe('+++ b/f.txt');
    expect(lines[3]).toBe('@@ -1,3 +1,3 @@');
    expect(lines.slice(4, 9)).toEqual([' a', '-b', '+B', ' c', '']);
    expect(expectConsistentHunks(patch)).toBe(1);
  });

  it('created: new file mode + /dev/null old side', () => {
    const d = computeFileDiff({ kind: 'created', path: 'n.txt', newText: 'x\ny\n' });
    const patch = toUnifiedPatch(d);
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('--- /dev/null');
    expect(patch).toContain('+++ b/n.txt');
    expect(patch).toContain('@@ -0,0 +1,2 @@');
    expect(expectConsistentHunks(patch)).toBe(1);
  });

  it('deleted: deleted file mode + /dev/null new side', () => {
    const d = computeFileDiff({ kind: 'deleted', path: 'n.txt', oldText: 'x\n' });
    const patch = toUnifiedPatch(d);
    expect(patch).toContain('deleted file mode 100644');
    expect(patch).toContain('--- a/n.txt');
    expect(patch).toContain('+++ /dev/null');
    expect(patch).toContain('@@ -1 +0,0 @@');
    expect(expectConsistentHunks(patch)).toBe(1);
  });

  it('renamed: similarity index + rename from/to headers', () => {
    const d = computeFileDiff({
      kind: 'renamed',
      oldPath: 'old dir/a.txt',
      path: 'new dir/b.txt',
      oldText: 'same\n',
      newText: 'same\n',
      similarity: 0.82,
    });
    const patch = toUnifiedPatch(d);
    expect(patch).toContain('diff --git a/old dir/a.txt b/new dir/b.txt');
    expect(patch).toContain('similarity index 82%');
    expect(patch).toContain('rename from old dir/a.txt');
    expect(patch).toContain('rename to new dir/b.txt');
  });

  it('mode change emits old mode/new mode; exec bit picks 100755', () => {
    const d = computeFileDiff({
      kind: 'modified',
      path: 's.sh',
      oldText: 'x\n',
      newText: 'y\n',
      oldMode: 0o644,
      newMode: 0o755,
    });
    const patch = toUnifiedPatch(d);
    expect(patch).toContain('old mode 100644');
    expect(patch).toContain('new mode 100755');
    expect(expectConsistentHunks(patch)).toBe(1);
  });

  it('\\ No newline at end of file: earned on both sides when both lack it', () => {
    const patch = toUnifiedPatch(mod('a\nb', 'a\nB'));
    const markers = patch.split('\n').filter((l) => l === '\\ No newline at end of file');
    expect(markers.length).toBe(2);
    expect(patch).toContain('-b\n\\ No newline at end of file\n+B\n\\ No newline at end of file\n');
    expect(expectConsistentHunks(patch)).toBe(1);
  });

  it('a shared trailing ctx line earns ONE marker, not two', () => {
    const patch = toUnifiedPatch(mod('a\nb', 'a\nB'.replace('B', 'b').replace('a', 'A')));
    // 'a\nb' → 'A\nb': last row is the shared ctx 'b' at both file ends
    const markers = patch.split('\n').filter((l) => l === '\\ No newline at end of file');
    expect(markers.length).toBe(1);
    expect(patch).toContain(' b\n\\ No newline at end of file\n');
  });

  it('\\ No newline: only the side lacking the terminator earns the marker', () => {
    const gained = toUnifiedPatch(mod('a\nb', 'a\nB\n'));
    expect(gained.split('\\ No newline at end of file').length - 1).toBe(1);
    const lost = toUnifiedPatch(mod('a\nb\n', 'a\nB'));
    expect(lost.split('\\ No newline at end of file').length - 1).toBe(1);
    const both = toUnifiedPatch(mod('a\nb\n', 'a\nB\n'));
    expect(both).not.toContain('\\ No newline');
    expect(expectConsistentHunks(lost)).toBe(1);
  });

  it('subset: only accepted hunks are emitted, counts still consistent', () => {
    const a = Array.from({ length: 20 }, (_, i) => `c${i}`).join('\n');
    const b = a.replace('c2', 'C2').replace('c10', 'C10');
    const d = mod(a, b);
    expect(d.hunks.length).toBe(2);
    const patch = toUnifiedPatch(d, [1]);
    expect(expectConsistentHunks(patch)).toBe(1);
    expect(patch).toContain('-c10');
    expect(patch).not.toContain('-c2');
    // all hunks by default
    expect(expectConsistentHunks(toUnifiedPatch(d))).toBe(2);
  });

  it('binary diff emits a Binary files line instead of hunks', () => {
    const patch = toUnifiedPatch(mod('a\0b', 'cd'));
    expect(patch).toContain('Binary files a/f.txt and b/f.txt differ');
    expect(patch).not.toContain('@@');
  });
});

// ---------------------------------------------------------------------------
// property tests (fast-check)
// ---------------------------------------------------------------------------

/** Text without \r or NUL: letters, digits, punctuation, tabs, newlines (weighted). */
const textArb = fc
  .array(
    fc.constantFrom(
      'a',
      'b',
      'c',
      'd',
      'x',
      'y',
      '0',
      '1',
      ' ',
      ' ',
      '_',
      '=',
      '(',
      ')',
      ';',
      '+',
      '\t',
      '\n',
      '\n',
      '\n',
      '\n',
      'é',
      'λ',
    ),
    { minLength: 0, maxLength: 300 },
  )
  .map((chars) => chars.join(''));

/** Same alphabet, but every \n becomes \r\n — pure-CRLF (or terminator-free) texts. */
const crlfArb = textArb.map((s) => s.replace(/\n/g, '\r\n'));

const anyText = fc.oneof(textArb, crlfArb);

describe('properties', () => {
  it('apply(all) === b, byte-for-byte, for arbitrary LF/CRLF/empty texts', () => {
    fc.assert(
      fc.property(anyText, anyText, (a, b) => {
        const d = mod(a, b);
        const r = applyHunks(a, d, allIndices(d));
        expect(r.ok).toBe(true);
        if (r.ok) expect(r.value).toBe(b);
      }),
      { numRuns: 200 },
    );
  });

  it('applying none yields a exactly (when there is anything to reject)', () => {
    fc.assert(
      fc.property(anyText, anyText, (a, b) => {
        const d = mod(a, b);
        if (d.hunks.length === 0) return; // covered by the apply(all) property
        expect(applyHunks(a, d, [])).toEqual({ ok: true, value: a });
      }),
      { numRuns: 200 },
    );
  });

  it('random hunk subsets apply cleanly and chain: re-diff(a→mid) reproduces mid', () => {
    const maskArb = fc.array(fc.boolean(), { minLength: 16, maxLength: 16 });
    fc.assert(
      fc.property(anyText, anyText, maskArb, (a, b, mask) => {
        const d = mod(a, b);
        const subset = allIndices(d).filter((i) => mask[i % mask.length]);
        const r = applyHunks(a, d, subset);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const mid = r.value;
        const d2 = mod(a, mid);
        const r2 = applyHunks(a, d2, allIndices(d2));
        expect(r2.ok).toBe(true);
        if (r2.ok) expect(r2.value).toBe(mid);
      }),
      { numRuns: 100 },
    );
  });

  it('word segments always rejoin to their line text exactly', () => {
    fc.assert(
      fc.property(anyText, anyText, (a, b) => {
        const d = mod(a, b);
        for (const h of d.hunks) {
          for (const l of h.lines) {
            if (l.words !== undefined) {
              expect(l.words.map((w) => w.text).join('')).toBe(l.text);
            }
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('hunks never misstate their own row counts (GNU header invariant)', () => {
    fc.assert(
      fc.property(anyText, anyText, (a, b) => {
        const d = mod(a, b);
        for (const h of d.hunks) {
          let oldCount = 0;
          let newCount = 0;
          for (const l of h.lines) {
            if (l.kind !== 'add') oldCount += 1;
            if (l.kind !== 'del') newCount += 1;
          }
          expect(oldCount).toBe(h.oldLines);
          expect(newCount).toBe(h.newLines);
          expectConsistentHunksShape(h);
        }
      }),
      { numRuns: 100 },
    );
  });
});

/** oldStart/newStart agree with the first numbered row of each side. */
function expectConsistentHunksShape(h: Hunk): void {
  const firstOld = h.lines.find((l) => l.oldNo !== null);
  const firstNew = h.lines.find((l) => l.newNo !== null);
  if (h.oldLines > 0) expect(firstOld!.oldNo).toBe(h.oldStart);
  if (h.newLines > 0) expect(firstNew!.newNo).toBe(h.newStart);
}
