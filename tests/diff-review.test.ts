/**
 * Diff-review tests: the pure key parser (every bound key + garbage), the
 * raw-mode TTY loop (apply / reject+reason / apply-all / the hunk sub-flow /
 * expand / view toggle / cancel, and the Ctrl+C-mid-hunk terminal-restore
 * discipline), the non-TTY line fallback (y/n/a, degraded h/s, working e,
 * EOF cancel), the owned-readline fallback, auto/dry-run short-circuits,
 * secret/conflict/position presentation, and the change-set summary table.
 *
 * The renderer is being built in parallel against the pinned signature, so
 * it is mocked here with a tiny FAITHFUL fake whose output reflects
 * RenderOptions: maxLines caps rows with a "… N more lines" marker, the
 * split view puts a '│' divider in every row, generated files collapse
 * unless expandGenerated. All FileDiff fixtures are built BY HAND — the
 * parallel engine is never imported.
 */

import { PassThrough } from 'node:stream';
import stringWidth from 'string-width';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseReviewKey,
  renderChangeSetSummary,
  reviewChange,
  type ReviewIo,
  type ReviewOptions,
} from '../src/diff/review.js';
import type { DiffLine, FileDiff, Hunk, RenderOptions } from '../src/diff/types.js';
import { GALAXY_PALETTE, Theme } from '../src/ui/theme.js';

// ---------------------------------------------------------------------------
// the fake renderer (stands in for the parallel-built src/diff/renderer.ts)
// ---------------------------------------------------------------------------

const rendererSpy = vi.hoisted(() => ({
  calls: [] as Array<{ path: string; hunks: number; opts: Record<string, unknown> }>,
}));

vi.mock('../src/diff/renderer.js', () => {
  function fakeRenderFileDiff(diff: FileDiff, _theme: Theme, opts?: RenderOptions): string[] {
    const o: Record<string, unknown> = { ...(opts ?? {}) };
    rendererSpy.calls.push({ path: diff.change.path, hunks: diff.hunks.length, opts: o });
    const view = o['view'] === 'split' ? 'split' : 'unified';
    const header = `diff: ${diff.change.path} (${diff.change.kind}) view=${view}`;
    if (diff.binary !== undefined) return [header, '(binary content)'];
    if (diff.generated && o['expandGenerated'] !== true) {
      return [header, '(generated — collapsed)'];
    }
    const rows: string[] = [];
    for (const hunk of diff.hunks) {
      rows.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const l of hunk.lines) {
        const sign = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
        rows.push(view === 'split' ? `${sign} ${l.text} │ ${l.text}` : `${sign} ${l.text}`);
      }
    }
    const max = o['maxLines'];
    const capped =
      typeof max === 'number' && max > 0 && rows.length > max
        ? [...rows.slice(0, max), `… ${rows.length - max} more lines`]
        : rows;
    return [header, ...capped];
  }
  return { renderFileDiff: fakeRenderFileDiff };
});

// ---------------------------------------------------------------------------
// fixtures — FileDiff objects built by hand
// ---------------------------------------------------------------------------

function dl(
  kind: DiffLine['kind'],
  text: string,
  oldNo: number | null,
  newNo: number | null,
): DiffLine {
  return { kind, oldNo, newNo, text };
}

function mkHunk(oldStart: number, lines: DiffLine[]): Hunk {
  return {
    oldStart,
    oldLines: lines.filter((l) => l.kind !== 'add').length,
    newStart: oldStart,
    newLines: lines.filter((l) => l.kind !== 'del').length,
    header: '',
    lines,
  };
}

function makeDiff(init?: {
  path?: string;
  kind?: 'created' | 'modified' | 'deleted' | 'renamed';
  hunks?: Hunk[];
  binary?: { oldSize: number; newSize: number };
  generated?: boolean;
}): FileDiff {
  const kind = init?.kind ?? 'modified';
  const path = init?.path ?? 'src/app.ts';
  const hunks = init?.hunks ?? [
    mkHunk(1, [
      dl('ctx', 'const a = 1;', 1, 1),
      dl('del', 'const b = 2;', 2, null),
      dl('add', 'const b = 3;', null, 2),
    ]),
  ];
  const added = hunks.reduce((n, hk) => n + hk.lines.filter((l) => l.kind === 'add').length, 0);
  const removed = hunks.reduce((n, hk) => n + hk.lines.filter((l) => l.kind === 'del').length, 0);
  const change: FileDiff['change'] =
    kind === 'created'
      ? { kind, path, newText: '' }
      : kind === 'deleted'
        ? { kind, path, oldText: '' }
        : kind === 'renamed'
          ? { kind, path, oldPath: 'src/old-name.ts', oldText: '', newText: '', similarity: 0.9 }
          : { kind, path, oldText: '', newText: '' };
  return {
    change,
    hunks,
    stats: { added, removed, hunks: hunks.length },
    binary: init?.binary,
    oldEol: 'lf',
    newEol: 'lf',
    oldEndsWithNewline: true,
    newEndsWithNewline: true,
    whitespaceOnly: false,
    modeChange: undefined,
    unchanged: false,
    generated: init?.generated ?? false,
  };
}

/** One hunk per entry; hunk i holds a single add line 'hunk i addition'. */
function fourHunkDiff(): FileDiff {
  return makeDiff({
    hunks: [1, 10, 20, 30].map((start, i) =>
      mkHunk(start, [
        dl('ctx', `context ${i}`, start, start),
        dl('add', `hunk ${i} addition`, null, start + 1),
      ]),
    ),
  });
}

/** A single hunk with six added lines — enough rows to trip a small maxLines cap. */
function cappedDiff(): FileDiff {
  return makeDiff({
    hunks: [
      mkHunk(
        1,
        [1, 2, 3, 4, 5, 6].map((n) => dl('add', `added line ${n}`, null, n)),
      ),
    ],
  });
}

// ---------------------------------------------------------------------------
// io harness — PassThrough stdin with a setRawMode spy, captured writes
// ---------------------------------------------------------------------------

type FakeStdin = PassThrough & { setRawMode(mode: boolean): void };

interface Harness {
  io: ReviewIo;
  stdin: FakeStdin;
  writes: string[];
  rawModes: boolean[];
  nextLineCalls: () => number;
}

function makeHarness(init?: {
  isTTY?: boolean;
  lines?: string[];
  /** false → no shared line source: review owns a readline over stdin. */
  sharedLines?: boolean;
}): Harness {
  const writes: string[] = [];
  const rawModes: boolean[] = [];
  const stdin = new PassThrough() as FakeStdin;
  stdin.setRawMode = (mode: boolean): void => {
    rawModes.push(mode);
  };
  const queue = [...(init?.lines ?? [])];
  let calls = 0;
  const io: ReviewIo = {
    stdin,
    isTTY: init?.isTTY ?? false,
    write: (s: string): void => {
      writes.push(s);
    },
  };
  if (init?.sharedLines !== false) {
    io.nextLine = (): Promise<string> => {
      calls += 1;
      const line = queue.shift();
      return line === undefined ? Promise.reject(new Error('eof')) : Promise.resolve(line);
    };
  }
  return { io, stdin, writes, rawModes, nextLineCalls: () => calls };
}

const plainTheme = new Theme(GALAXY_PALETTE, 0); // level 0 — no ANSI, ever

function askOpts(render?: RenderOptions): ReviewOptions {
  return render === undefined
    ? { mode: 'ask', theme: plainTheme }
    : { mode: 'ask', theme: plainTheme, render };
}

const PROMPT = '[y] apply  [n] reject  [a] apply all  [h] hunks  [e] expand  [s] split  [q] cancel';

/** Push keys one chunk per tick so each arrives as its own 'data' event. */
async function pushKeys(stdin: FakeStdin, keys: string[]): Promise<void> {
  for (const k of keys) {
    stdin.write(k);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  rendererSpy.calls.length = 0;
});

// ---------------------------------------------------------------------------
// parseReviewKey
// ---------------------------------------------------------------------------

describe('parseReviewKey', () => {
  it('maps every bound key and ignores garbage', () => {
    expect(parseReviewKey('y')).toBe('apply');
    expect(parseReviewKey('Y')).toBe('apply');
    expect(parseReviewKey('\r')).toBe('apply');
    expect(parseReviewKey('\n')).toBe('apply');
    expect(parseReviewKey('n')).toBe('reject');
    expect(parseReviewKey('N')).toBe('reject');
    expect(parseReviewKey('a')).toBe('apply-all');
    expect(parseReviewKey('A')).toBe('apply-all');
    expect(parseReviewKey('h')).toBe('hunks');
    expect(parseReviewKey('H')).toBe('hunks');
    expect(parseReviewKey('e')).toBe('expand');
    expect(parseReviewKey('E')).toBe('expand');
    expect(parseReviewKey('s')).toBe('toggle-view');
    expect(parseReviewKey('S')).toBe('toggle-view');
    expect(parseReviewKey('q')).toBe('cancel');
    expect(parseReviewKey('Q')).toBe('cancel');
    expect(parseReviewKey('\x1b')).toBe('cancel'); // Esc
    expect(parseReviewKey('\x03')).toBe('cancel'); // Ctrl+C
    expect(parseReviewKey('x')).toBe('other');
    expect(parseReviewKey('')).toBe('other');
    expect(parseReviewKey('\x1b[A')).toBe('other'); // arrow-up escape sequence is not Esc
  });
});

// ---------------------------------------------------------------------------
// TTY raw-mode flow
// ---------------------------------------------------------------------------

describe('tty raw-mode review', () => {
  it("'y' applies and raw mode is toggled ON then OFF (balanced)", async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
    h.stdin.write('y');
    const decision = await p;
    expect(decision).toEqual({ action: 'apply' });
    expect(h.rawModes).toEqual([true, false]);
    expect(h.writes.some((l) => l.includes('diff: src/app.ts'))).toBe(true);
    expect(h.writes.filter((l) => l === PROMPT)).toHaveLength(1);
  });

  it("'a' applies all; 'q', Esc and Ctrl+C at the main prompt cancel", async () => {
    const a = makeHarness({ isTTY: true });
    const pa = reviewChange({ diff: makeDiff() }, a.io, askOpts());
    a.stdin.write('a');
    expect(await pa).toEqual({ action: 'apply-all' });
    expect(a.rawModes).toEqual([true, false]);

    for (const key of ['q', '\x1b', '\x03']) {
      const h = makeHarness({ isTTY: true });
      const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
      h.stdin.write(key);
      expect(await p).toEqual({ action: 'cancel' });
      expect(h.rawModes).toEqual([true, false]);
    }
  });

  it("'n' reads a reason line AFTER cooked mode is restored", async () => {
    const h = makeHarness({ isTTY: true, lines: ['no thanks'] });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
    h.stdin.write('n');
    const decision = await p;
    expect(decision).toEqual({ action: 'reject', reason: 'no thanks' });
    // raw mode was already OFF when the reason line was read
    expect(h.rawModes).toEqual([true, false]);
    expect(h.writes).toContain('Reason (optional — sent to the model; empty = none):');
    expect(h.nextLineCalls()).toBe(1);
  });

  it('an empty reason line rejects with reason undefined', async () => {
    const h = makeHarness({ isTTY: true, lines: ['   '] });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
    h.stdin.write('n');
    expect(await p).toEqual({ action: 'reject', reason: undefined });
  });

  it("stdin 'end' without an answer cancels with a one-line note", async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
    h.stdin.end();
    expect(await p).toEqual({ action: 'cancel' });
    expect(h.writes.some((l) => l.includes('review cancelled'))).toBe(true);
    expect(h.rawModes).toEqual([true, false]);
  });

  it("'e' re-renders the FULL diff (maxLines 0, expandGenerated) then keeps asking", async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: cappedDiff() }, h.io, askOpts({ maxLines: 4 }));
    await pushKeys(h.stdin, ['e', 'y']);
    const decision = await p;
    expect(decision).toEqual({ action: 'apply' });
    // first render was capped: the marker is present and the tail is hidden
    expect(h.writes.some((l) => l.includes('… 3 more lines'))).toBe(true);
    // the second render is full: previously-capped content is now visible
    expect(h.writes.some((l) => l.includes('+ added line 6'))).toBe(true);
    expect(rendererSpy.calls).toHaveLength(2);
    expect(rendererSpy.calls[0]!.opts['maxLines']).toBe(4);
    expect(rendererSpy.calls[1]!.opts['maxLines']).toBe(0);
    expect(rendererSpy.calls[1]!.opts['expandGenerated']).toBe(true);
  });

  it("'s' flips the view unified→split, re-renders and re-asks", async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts({ view: 'unified' }));
    await pushKeys(h.stdin, ['s', 'y']);
    expect(await p).toEqual({ action: 'apply' });
    // the re-render happened with the flipped view and split rows carry the divider
    expect(rendererSpy.calls).toHaveLength(2);
    expect(rendererSpy.calls[1]!.opts['view']).toBe('split');
    expect(h.writes.some((l) => l.includes(' │ '))).toBe(true);
    // prompt shown again after the re-render
    expect(h.writes.filter((l) => l === PROMPT)).toHaveLength(2);
    expect(h.rawModes).toEqual([true, false]);
  });

  it('hunk flow: y,n,a over 4 hunks applies hunks [0, 2, 3] via single-hunk renders', async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: fourHunkDiff() }, h.io, askOpts());
    await pushKeys(h.stdin, ['h', 'y', 'n', 'a']);
    const decision = await p;
    expect(decision).toEqual({ action: 'apply-hunks', accepted: [0, 2, 3] });
    // the initial full render plus one single-hunk render per presented hunk
    expect(rendererSpy.calls).toHaveLength(4);
    expect(rendererSpy.calls[0]!.hunks).toBe(4);
    expect(rendererSpy.calls.slice(1).every((c) => c.hunks === 1)).toBe(true);
    expect(h.writes).toContain('[y] apply hunk 1/4  [n] skip  [a] apply rest  [q] stop');
    expect(h.writes.some((l) => l.includes('· 3 of 4 hunks selected'))).toBe(true);
    expect(h.rawModes).toEqual([true, false]);
  });

  it('hunk flow: all skips return an honest empty accepted list', async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: fourHunkDiff() }, h.io, askOpts());
    await pushKeys(h.stdin, ['h', 'n', 'n', 'n', 'n']);
    expect(await p).toEqual({ action: 'apply-hunks', accepted: [] });
    expect(h.writes.some((l) => l.includes('· 0 of 4 hunks selected'))).toBe(true);
  });

  it('hunk flow: q stops early keeping only the picks so far', async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: fourHunkDiff() }, h.io, askOpts());
    await pushKeys(h.stdin, ['h', 'y', 'q']);
    expect(await p).toEqual({ action: 'apply-hunks', accepted: [0] });
  });

  it('Ctrl+C mid-hunk-flow cancels AND restores the terminal', async () => {
    const h = makeHarness({ isTTY: true });
    const p = reviewChange({ diff: fourHunkDiff() }, h.io, askOpts());
    await pushKeys(h.stdin, ['h', '\x03']);
    const decision = await p;
    expect(decision).toEqual({ action: 'cancel' });
    expect(h.rawModes).toEqual([true, false]); // setRawMode(false) ran
  });
});

// ---------------------------------------------------------------------------
// non-TTY line flow
// ---------------------------------------------------------------------------

describe('non-tty line review', () => {
  it('answers y / n+reason / a; raw mode is never touched', async () => {
    const y = makeHarness({ isTTY: false, lines: ['y'] });
    expect(await reviewChange({ diff: makeDiff() }, y.io, askOpts())).toEqual({
      action: 'apply',
    });
    expect(y.rawModes).toEqual([]);

    const n = makeHarness({ isTTY: false, lines: ['n', 'no thanks'] });
    expect(await reviewChange({ diff: makeDiff() }, n.io, askOpts())).toEqual({
      action: 'reject',
      reason: 'no thanks',
    });

    const empty = makeHarness({ isTTY: false, lines: ['n', ''] });
    expect(await reviewChange({ diff: makeDiff() }, empty.io, askOpts())).toEqual({
      action: 'reject',
      reason: undefined,
    });

    const a = makeHarness({ isTTY: false, lines: ['a'] });
    expect(await reviewChange({ diff: makeDiff() }, a.io, askOpts())).toEqual({
      action: 'apply-all',
    });
  });

  it('EOF without an answer cancels with the safe-default note', async () => {
    const h = makeHarness({ isTTY: false, lines: [] });
    expect(await reviewChange({ diff: makeDiff() }, h.io, askOpts())).toEqual({
      action: 'cancel',
    });
    expect(h.writes.some((l) => l.includes('review cancelled'))).toBe(true);
  });

  it("'h' prints the needs-a-TTY note and re-asks", async () => {
    const h = makeHarness({ isTTY: false, lines: ['h', 'y'] });
    expect(await reviewChange({ diff: makeDiff() }, h.io, askOpts())).toEqual({
      action: 'apply',
    });
    expect(h.writes.some((l) => l.includes('hunk review needs a TTY'))).toBe(true);
    expect(h.writes.filter((l) => l === PROMPT).length).toBeGreaterThanOrEqual(2);
  });

  it("'s' prints the split-needs-a-TTY note; 'e' still reprints the full diff", async () => {
    const s = makeHarness({ isTTY: false, lines: ['s', 'y'] });
    expect(await reviewChange({ diff: makeDiff() }, s.io, askOpts())).toEqual({
      action: 'apply',
    });
    expect(s.writes.some((l) => l.includes('split needs a TTY'))).toBe(true);

    const e = makeHarness({ isTTY: false, lines: ['e', 'y'] });
    expect(await reviewChange({ diff: cappedDiff() }, e.io, askOpts({ maxLines: 4 }))).toEqual({
      action: 'apply',
    });
    expect(e.writes.some((l) => l.includes('… 3 more lines'))).toBe(true);
    expect(e.writes.some((l) => l.includes('+ added line 6'))).toBe(true);
    expect(rendererSpy.calls.at(-1)!.opts['maxLines']).toBe(0);
  });

  it('unrecognized answers re-ask until a decision key arrives', async () => {
    const h = makeHarness({ isTTY: false, lines: ['maybe', 'q'] });
    expect(await reviewChange({ diff: makeDiff() }, h.io, askOpts())).toEqual({
      action: 'cancel',
    });
  });
});

// ---------------------------------------------------------------------------
// owned readline fallback (no shared nextLine)
// ---------------------------------------------------------------------------

describe('owned readline fallback (no nextLine given)', () => {
  it('reads the answer line through its own readline over stdin', async () => {
    const h = makeHarness({ isTTY: false, sharedLines: false });
    h.stdin.write('y\n');
    const decision = await reviewChange({ diff: makeDiff() }, h.io, askOpts());
    expect(decision).toEqual({ action: 'apply' });
  });

  it('stdin EOF closes the owned readline and cancels safely', async () => {
    const h = makeHarness({ isTTY: false, sharedLines: false });
    const p = reviewChange({ diff: makeDiff() }, h.io, askOpts());
    h.stdin.end();
    expect(await p).toEqual({ action: 'cancel' });
    expect(h.writes.some((l) => l.includes('review cancelled'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// auto / dry-run modes
// ---------------------------------------------------------------------------

describe('auto and dry-run modes', () => {
  it("mode 'auto' renders and applies with NO input consumed", async () => {
    const h = makeHarness({ isTTY: true });
    const decision = await reviewChange({ diff: makeDiff() }, h.io, {
      mode: 'auto',
      theme: plainTheme,
    });
    expect(decision).toEqual({ action: 'apply' });
    expect(h.nextLineCalls()).toBe(0);
    expect(h.rawModes).toEqual([]);
    expect(h.writes.some((l) => l.includes('diff: src/app.ts'))).toBe(true);
  });

  it("mode 'dry-run' renders, prints the notice and rejects with reason 'dry-run'", async () => {
    const h = makeHarness({ isTTY: true });
    const decision = await reviewChange({ diff: makeDiff() }, h.io, {
      mode: 'dry-run',
      theme: plainTheme,
    });
    expect(decision).toEqual({ action: 'reject', reason: 'dry-run' });
    expect(h.writes).toContain('(dry-run — nothing will be written)');
    expect(h.nextLineCalls()).toBe(0);
    expect(h.rawModes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// presentation: position, secrets, conflict
// ---------------------------------------------------------------------------

describe('presentation extras', () => {
  it('prints the position line, secret warnings and the conflict line', async () => {
    const h = makeHarness({ isTTY: true });
    await reviewChange(
      {
        diff: makeDiff(),
        position: { index: 2, total: 5 },
        secrets: [{ rule: 'aws-access-key', line: 12, snippet: 'AKIA…' }],
        conflict: 'file changed on disk since read',
      },
      h.io,
      { mode: 'auto', theme: plainTheme },
    );
    expect(h.writes).toContain('file 2 of 5');
    expect(h.writes).toContain('⚠ possible secret on line 12 (aws-access-key): AKIA…');
    expect(
      h.writes.some((l) => l.includes('⚠') && l.includes('file changed on disk since read')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderChangeSetSummary
// ---------------------------------------------------------------------------

describe('renderChangeSetSummary', () => {
  const set: FileDiff[] = [
    makeDiff({
      path: 'src/new-file.ts',
      kind: 'created',
      hunks: [
        mkHunk(
          0,
          [1, 2, 3, 4, 5].map((n) => dl('add', `new ${n}`, null, n)),
        ),
      ],
    }),
    makeDiff({
      path: 'src/app.ts',
      hunks: [
        mkHunk(1, [
          dl('ctx', 'keep', 1, 1),
          dl('del', 'old a', 2, null),
          dl('del', 'old b', 3, null),
          dl('add', 'new a', null, 2),
          dl('add', 'new b', null, 3),
          dl('add', 'new c', null, 4),
        ]),
      ],
    }),
    makeDiff({
      path: 'src/gone.ts',
      kind: 'deleted',
      hunks: [
        mkHunk(
          1,
          [1, 2, 3, 4].map((n) => dl('del', `gone ${n}`, n, null)),
        ),
      ],
    }),
    makeDiff({
      path: 'src/renamed.ts',
      kind: 'renamed',
      hunks: [mkHunk(1, [dl('del', 'before', 1, null), dl('add', 'after', null, 1)])],
    }),
    makeDiff({ path: 'assets/logo.png', hunks: [], binary: { oldSize: 100, newSize: 200 } }),
  ];

  it('renders one icon row per file, right-aligned stats, and a totals row', () => {
    const lines = renderChangeSetSummary(set, plainTheme);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toContain('✚');
    expect(lines[0]).toContain('src/new-file.ts');
    expect(lines[1]).toContain('✎');
    expect(lines[2]).toContain('✖');
    expect(lines[3]).toContain('➜');
    expect(lines[4]).toContain('(binary)');
    // right-aligned stats: every row ENDS with its stats cell
    expect(lines[0]!.endsWith('+5 −0')).toBe(true);
    expect(lines[1]!.endsWith('+3 −2')).toBe(true);
    expect(lines[2]!.endsWith('+0 −4')).toBe(true);
    expect(lines[3]!.endsWith('+1 −1')).toBe(true);
    expect(lines[4]!.endsWith('(binary)')).toBe(true);
    // totals: 5 files, +9 −7
    expect(lines[5]).toBe('5 files · +9 −7');
  });

  it('a level-0 theme produces zero ANSI anywhere in the table', () => {
    const lines = renderChangeSetSummary(set, plainTheme);
    expect(lines.join('\n')).not.toContain('\x1b');
  });

  it('truncates long paths by display width with a … marker', () => {
    const longPath = `src/${'very-long-directory/'.repeat(5)}deep-file.ts`;
    const lines = renderChangeSetSummary([makeDiff({ path: longPath })], plainTheme);
    const row = lines[0]!;
    expect(row).not.toContain(longPath);
    const prefix = '1. ✎ ';
    const stats = '+1 −1';
    expect(row.startsWith(prefix)).toBe(true);
    expect(row.endsWith(stats)).toBe(true);
    const cell = row.slice(prefix.length, row.length - stats.length - 2);
    expect(cell.endsWith('…')).toBe(true);
    expect(stringWidth(cell)).toBeLessThanOrEqual(56);
  });

  it('an empty change set is just the totals row', () => {
    expect(renderChangeSetSummary([], plainTheme)).toEqual(['0 files · +0 −0']);
  });
});
