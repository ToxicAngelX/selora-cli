/**
 * src/diff/engine.ts — the DIFF ENGINE: FileChange → FileDiff, hunk subset
 * application, unified-patch emission, and rename pairing. Pure functions:
 * no I/O, no printing, no clock, no randomness. Nothing here throws — bad
 * input degrades to a coarser diff, never to a crash.
 *
 * Design decisions, in the order you'd meet them reading top to bottom:
 *
 * 1. EOL. Texts are normalized (CRLF/CR → LF) before diffing, so the Myers
 *    line diff (reused from src/ui/diff.ts — proven, bounded, do not
 *    reimplement) never sees '\r'. The ORIGINAL styles are remembered on
 *    FileDiff (oldEol/newEol, endsWithNewline flags) and applyHunks
 *    re-encodes with newEol — which is what makes the round-trip invariant
 *    `applyHunks(a, diff(a→b), all) === b` byte-exact for LF and CRLF files.
 *    'mixed' EOL cannot be reproduced exactly (the per-line choice is lost);
 *    we join with '\n' — honest degradation, documented on the type.
 *
 * 2. Line model. splitLines mirrors ui/diff.ts: a trailing newline is a
 *    TERMINATOR, not an extra empty line ('a\n' → ['a'], '' → []). This is
 *    what lets '\ No newline at end of file' markers be earned rather than
 *    guessed.
 *
 * 3. Hunks. Built from ui computeDiff rows: changes ± `context` ctx lines,
 *    merged when the gap between change groups is ≤ 2·context (their context
 *    windows would touch). The ui fallback meta row (edit distance > 2000)
 *    and any text > MAX_TEXT_BYTES collapse to ONE whole-file hunk — bounded
 *    work on adversarial input. Hunk headers get a best-effort section
 *    heading: the nearest preceding ctx line that looks like a declaration,
 *    trimmed and capped at 60 chars.
 *
 * 4. Word-level diff. Inside a hunk, a maximal del-run followed by an add-run
 *    is paired: line-by-line when run lengths are EQUAL (the single-line-edit
 *    case), otherwise greedily by token-multiset similarity (best pair first,
 *    each line used once, only pairs ≥ 0.4 are marked). Tokens come from a
 *    unicode-aware regex (/[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]+/gu) that
 *    partitions the line, so segments ALWAYS concatenate back to the exact
 *    line text. The token diff is a small DP LCS (token arrays are tiny);
 *    oversized lines skip word marking entirely. ctx lines never get words.
 *
 * 5. Renames. pairRenames scores every deleted×created pair with a
 *    line-multiset similarity (|intersection| / max(|a|,|b|)) and greedily
 *    merges the best pairs ≥ threshold into RenamedChanges. Each file is
 *    used once; unmatched changes pass through untouched.
 *
 * 6. applyHunks verifies before it writes: each accepted hunk's del+ctx
 *    lines must match the old text at oldStart, else PATCH_MISMATCH naming
 *    the hunk and the first differing line. Splicing runs last-hunk-first so
 *    earlier positions stay valid. accepted=[] returns oldText untouched
 *    (no re-encoding).
 */

import { computeDiff } from '../ui/diff.js';
import type {
  DiffLine,
  DiffOptions,
  EolStyle,
  FileChange,
  FileDiff,
  Hunk,
  SafeResult,
  WordSegment,
} from './types.js';

// ---------------------------------------------------------------------------
// bounds (the "never crawl" contract)
// ---------------------------------------------------------------------------

/** Texts larger than this skip Myers entirely → one whole-file hunk. */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
/** How far back (rows) the section-heading scan may look. */
const HEADER_SCAN_BACK = 200;
/** Per-side token cap for word diffs; above it a pair is left unmarked. */
const MAX_WORD_TOKENS = 300;
/** DP-LCS cell cap for the token diff (n·m); above it, no word marking. */
const MAX_WORD_CELLS = 64 * 1024;
/** Max del×add candidate pairs scored in the greedy word pairing. */
const MAX_PAIR_CANDIDATES = 2500;
/** Word marking is skipped for change-block runs longer than this (either side). */
const MAX_RUN_LINES = 60;
/** Word-pairing similarity floor for unequal-length runs. */
const WORD_PAIR_FLOOR = 0.4;

// ---------------------------------------------------------------------------
// EOL + line splitting
// ---------------------------------------------------------------------------

/**
 * Classify the dominant line terminator. 'none' means the text is empty or
 * carries no terminator at all; 'mixed' means more than one style appears
 * (including stray lone '\r'). Lone '\r' counts as a terminator here because
 * normalizeEol treats it as one.
 */
export function detectEol(text: string): EolStyle {
  if (text === '') return 'none';
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      lf += 1;
    } else if (c === 13) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf += 1;
        i += 1;
      } else {
        cr += 1;
      }
    }
  }
  if (crlf === 0 && lf === 0 && cr === 0) return 'none';
  if (crlf > 0 && lf === 0 && cr === 0) return 'crlf';
  if (lf > 0 && crlf === 0 && cr === 0) return 'lf';
  return 'mixed';
}

/** CRLF and lone CR → LF. The ONLY normalization the engine performs. */
function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

/**
 * ui/diff.ts semantics: 'a\nb' → ['a','b'], 'a\nb\n' → ['a','b'] (trailing
 * newline terminates, it does not add an empty line), '' → [].
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

/** A text "ends with newline" when its last byte is a terminator; '' does not. */
function endsWithNewline(text: string): boolean {
  return text.endsWith('\n') || text.endsWith('\r');
}

// ---------------------------------------------------------------------------
// binary detection
// ---------------------------------------------------------------------------

function isControlCode(code: number): boolean {
  // \t \n \r are text; other C0 controls and DEL are not.
  return (code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127;
}

/**
 * Text heuristic: a NUL byte anywhere, or >30% control characters in a
 * sample of the first 8000 chars. Empty text is never binary.
 */
export function isBinaryText(text: string): boolean {
  if (text === '') return false;
  if (text.includes('\u0000')) return true;
  const sample = text.length > 8000 ? text.slice(0, 8000) : text;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    if (isControlCode(sample.charCodeAt(i))) control += 1;
  }
  return control / sample.length > 0.3;
}

/**
 * Buffer heuristic (git-style): NUL in the first 8KB, or >30% non-text bytes
 * in that window. Bytes ≥ 0x80 count as text (UTF-8 multibyte content).
 */
export function isBinaryData(buf: Uint8Array): boolean {
  if (buf.length === 0) return false;
  const n = Math.min(buf.length, 8192);
  let nonText = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 0) return true;
    if (b < 128 && isControlCode(b)) nonText += 1;
  }
  return nonText / n > 0.3;
}

// ---------------------------------------------------------------------------
// generated-file detection
// ---------------------------------------------------------------------------

const LOCKFILE_BASENAMES = new Set([
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'Cargo.lock',
  'Gemfile.lock',
  'poetry.lock',
  'composer.lock',
  'go.sum',
]);

/** Hashed chunk names inside a dist/build dir: `index-3f9a1c2e.js`, `chunk.ab12cd34.css`. */
const CHUNK_NAME = /(?:^|[-.])(?:chunk[-.]?)?[a-f0-9]{8,}\.(?:js|css|map)$/i;

/**
 * Lockfiles, minified bundles, sourcemaps, snapshots, and hashed dist/build
 * chunks — files a human never reviews line-by-line. Renderer collapses them.
 */
export function isGeneratedPath(path: string): boolean {
  const base = path.split('/').pop() ?? path;
  if (LOCKFILE_BASENAMES.has(base)) return true;
  if (/\.(min\.js|min\.css|map|snap)$/i.test(base)) return true;
  const segments = path.split('/');
  const inBuildDir = segments.some((s) => s === 'dist' || s === 'build' || s === 'coverage');
  return inBuildDir && CHUNK_NAME.test(base);
}

// ---------------------------------------------------------------------------
// similarity (line-multiset overlap — the rename-pairing score)
// ---------------------------------------------------------------------------

/**
 * Line-multiset overlap: |intersection| / max(|a|, |b|) over normalized,
 * end-trimmed lines (multiset: repeated lines count min(times in a, times in
 * b)). Identical content → 1; two empty texts → 1; one empty side → 0.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const aLines = splitLines(normalizeEol(a)).map((l) => l.trimEnd());
  const bLines = splitLines(normalizeEol(b)).map((l) => l.trimEnd());
  const max = Math.max(aLines.length, bLines.length);
  if (max === 0) return 1;
  const counts = new Map<string, number>();
  for (const line of aLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let common = 0;
  for (const line of bLines) {
    const left = counts.get(line) ?? 0;
    if (left > 0) {
      counts.set(line, left - 1);
      common += 1;
    }
  }
  return common / max;
}

// ---------------------------------------------------------------------------
// word-level diff (unicode tokenizer + small DP LCS)
// ---------------------------------------------------------------------------

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\s\p{L}\p{N}_]+/gu;

/** Tokenize a line so that tokens.join('') === line, always. */
function tokenize(line: string): string[] {
  if (line === '') return [];
  TOKEN_RE.lastIndex = 0;
  return line.match(TOKEN_RE) ?? [line];
}

/** Token-multiset similarity, same shape as line similarity(). */
function tokenSimilarity(a: readonly string[], b: readonly string[]): number {
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let common = 0;
  for (const t of b) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      counts.set(t, left - 1);
      common += 1;
    }
  }
  return common / max;
}

interface TokenOp {
  type: 'same' | 'del' | 'add';
  /** Index into the OLD token array for same/del. */
  ai: number;
  /** Index into the NEW token array for same/add. */
  bi: number;
}

/**
 * Token-level diff via DP LCS — chosen over a second Myers because token
 * arrays are line-sized (a few dozen), so O(n·m) with a hard cell cap is
 * simpler and just as bounded. Returns null when over budget (caller leaves
 * the pair unmarked).
 */
function diffTokens(a: readonly string[], b: readonly string[]): TokenOp[] | null {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n > MAX_WORD_TOKENS || m > MAX_WORD_TOKENS || n * m > MAX_WORD_CELLS) return null;

  // lengths[i][j] = LCS length of a[i..] and b[j..]
  const widths = m + 1;
  const lengths = new Int32Array((n + 1) * widths);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * widths + j] =
        a[i] === b[j]
          ? lengths[(i + 1) * widths + j + 1]! + 1
          : Math.max(lengths[(i + 1) * widths + j]!, lengths[i * widths + j + 1]!);
    }
  }
  const ops: TokenOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', ai: i, bi: j });
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * widths + j]! >= lengths[i * widths + j + 1]!) {
      ops.push({ type: 'del', ai: i, bi: j });
      i += 1;
    } else {
      ops.push({ type: 'add', ai: i, bi: j });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'del', ai: i, bi: j });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', ai: i, bi: j });
    j += 1;
  }
  return ops;
}

/**
 * Word segments for one paired del/add line couple. `changed` marks the
 * tokens that do NOT survive the LCS (deleted on the old side, inserted on
 * the new). Segments always cover the line exactly. Null when over budget.
 */
function wordSegments(
  oldLine: string,
  newLine: string,
): { delWords: WordSegment[]; addWords: WordSegment[] } | null {
  const oldTokens = tokenize(oldLine);
  const newTokens = tokenize(newLine);
  const ops = diffTokens(oldTokens, newTokens);
  if (ops === null) return null;
  const delWords: WordSegment[] = oldTokens.map((text) => ({ text, changed: true }));
  const addWords: WordSegment[] = newTokens.map((text) => ({ text, changed: true }));
  for (const op of ops) {
    if (op.type === 'same') {
      delWords[op.ai]!.changed = false;
      addWords[op.bi]!.changed = false;
    }
  }
  return { delWords, addWords };
}

/**
 * Pair the del and add runs of one change block and attach word segments.
 * Equal-length runs pair line-by-line (always marked); unequal runs pair
 * greedily by token similarity and are only marked at ≥ WORD_PAIR_FLOOR.
 */
function attachWordDiffs(lines: DiffLine[]): void {
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.kind === 'ctx') {
      i += 1;
      continue;
    }
    // one change block: consecutive add/del rows
    let j = i;
    while (j < lines.length && lines[j]!.kind !== 'ctx') j += 1;
    const dels: DiffLine[] = [];
    const adds: DiffLine[] = [];
    for (let k = i; k < j; k++) {
      const row = lines[k]!;
      if (row.kind === 'del') dels.push(row);
      else if (row.kind === 'add') adds.push(row);
    }
    if (dels.length > 0 && adds.length > 0) {
      const withinRunCap = dels.length <= MAX_RUN_LINES && adds.length <= MAX_RUN_LINES;
      if (!withinRunCap) {
        // Whole-file-scale blocks: word marking is noise and quadratic risk.
      } else if (dels.length === adds.length) {
        for (let k = 0; k < dels.length; k++) {
          markPair(dels[k]!, adds[k]!);
        }
      } else if (dels.length * adds.length <= MAX_PAIR_CANDIDATES) {
        pairGreedily(dels, adds);
      }
    }
    i = j;
  }
}

function markPair(delLine: DiffLine, addLine: DiffLine): void {
  if (delLine.text === addLine.text) return; // identical text: nothing to mark
  const segs = wordSegments(delLine.text, addLine.text);
  if (segs === null) return;
  delLine.words = segs.delWords;
  addLine.words = segs.addWords;
}

function pairGreedily(dels: readonly DiffLine[], adds: readonly DiffLine[]): void {
  interface Cand {
    d: number;
    a: number;
    score: number;
  }
  const cands: Cand[] = [];
  const delTokens = dels.map((l) => tokenize(l.text));
  const addTokens = adds.map((l) => tokenize(l.text));
  for (let d = 0; d < dels.length; d++) {
    for (let a = 0; a < adds.length; a++) {
      cands.push({ d, a, score: tokenSimilarity(delTokens[d]!, addTokens[a]!) });
    }
  }
  cands.sort((x, y) => y.score - x.score);
  const usedD = new Set<number>();
  const usedA = new Set<number>();
  for (const c of cands) {
    if (c.score < WORD_PAIR_FLOOR) break;
    if (usedD.has(c.d) || usedA.has(c.a)) continue;
    usedD.add(c.d);
    usedA.add(c.a);
    markPair(dels[c.d]!, adds[c.a]!);
  }
}

// ---------------------------------------------------------------------------
// hunk building
// ---------------------------------------------------------------------------

/** Section-heading heuristic: a line that opens a declaration, in any common syntax. */
const SECTION_RE =
  /\b(?:function|class|const|let|var|export|import|interface|type|struct|enum|impl|def|fn|func|public|private|protected|static|void|int|package|describe|it|test)\b/;

function sectionHeading(rows: readonly { op: string; text: string }[], beforeIdx: number): string {
  const start = Math.max(0, beforeIdx - HEADER_SCAN_BACK);
  for (let i = beforeIdx - 1; i >= start; i--) {
    const row = rows[i]!;
    if (row.op !== 'ctx') continue;
    const trimmed = row.text.trim();
    if (trimmed === '') continue;
    if (SECTION_RE.test(trimmed)) {
      return trimmed.length > 60 ? trimmed.slice(0, 60) : trimmed;
    }
  }
  return '';
}

interface UiRow {
  op: 'add' | 'del' | 'ctx' | 'meta';
  before: number | null;
  after: number | null;
  text: string;
}

/** Convert the ui/diff row list into context-trimmed, merged hunks. */
function buildHunks(rows: readonly UiRow[], context: number): Hunk[] {
  // Fallback marker → single whole-file hunk (rows are already del* then add*).
  if (rows.length > 0 && rows[0]!.op === 'meta') {
    return [wholeFileHunk(rows.slice(1))];
  }
  const changeIdx: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const op = rows[i]!.op;
    if (op === 'add' || op === 'del') changeIdx.push(i);
  }
  if (changeIdx.length === 0) return [];

  // Group changes: gap = ctx rows between two changes; windows touch when
  // gap ≤ 2·context (gap == 2·context leaves the two windows exactly adjacent).
  const groups: Array<[number, number]> = []; // [firstChangeIdx, lastChangeIdx]
  let gStart = changeIdx[0]!;
  let prev = gStart;
  for (let k = 1; k < changeIdx.length; k++) {
    const idx = changeIdx[k]!;
    if (idx - prev - 1 > 2 * context) {
      groups.push([gStart, prev]);
      gStart = idx;
    }
    prev = idx;
  }
  groups.push([gStart, prev]);

  const hunks: Hunk[] = [];
  for (const [first, last] of groups) {
    const from = Math.max(0, first - context);
    const to = Math.min(rows.length - 1, last + context);
    const slice = rows.slice(from, to + 1);
    const lines: DiffLine[] = slice.map((r) => ({
      kind: r.op === 'meta' ? 'ctx' : (r.op as DiffLine['kind']),
      oldNo: r.before,
      newNo: r.after,
      text: r.text,
    }));
    hunks.push({
      ...hunkBounds(lines, rows, from),
      header: sectionHeading(rows, from),
      lines,
    });
  }
  return hunks;
}

/**
 * GNU bounds for one hunk. With ≥1 old-side line, oldStart is its first
 * 1-based number; a pure-insertion hunk reports the line AFTER which content
 * goes (0 at file start) — the `@@ -2,0 +3,2 @@` convention. Same for new.
 */
function hunkBounds(
  lines: readonly DiffLine[],
  rows: readonly UiRow[],
  from: number,
): { oldStart: number; oldLines: number; newStart: number; newLines: number } {
  let firstOld: number | null = null;
  let firstNew: number | null = null;
  let oldLines = 0;
  let newLines = 0;
  for (const l of lines) {
    if (l.oldNo !== null) {
      if (firstOld === null) firstOld = l.oldNo;
      oldLines += 1;
    }
    if (l.newNo !== null) {
      if (firstNew === null) firstNew = l.newNo;
      newLines += 1;
    }
  }
  let prevOld = 0;
  let prevNew = 0;
  for (let i = from - 1; i >= 0; i--) {
    const r = rows[i]!;
    if (prevOld === 0 && r.before !== null) prevOld = r.before;
    if (prevNew === 0 && r.after !== null) prevNew = r.after;
    if (prevOld !== 0 && prevNew !== 0) break;
  }
  return {
    oldStart: firstOld ?? prevOld,
    oldLines,
    newStart: firstNew ?? prevNew,
    newLines,
  };
}

/** Whole-file replace: every old line a del, every new line an add. */
function wholeFileHunk(rows: readonly UiRow[]): Hunk {
  const lines: DiffLine[] = rows.map((r) => ({
    kind: r.op === 'add' ? ('add' as const) : ('del' as const),
    oldNo: r.before,
    newNo: r.after,
    text: r.text,
  }));
  let oldLines = 0;
  let newLines = 0;
  for (const l of lines) {
    if (l.kind === 'del') oldLines += 1;
    else newLines += 1;
  }
  return {
    oldStart: oldLines > 0 ? 1 : 0,
    oldLines,
    newStart: newLines > 0 ? 1 : 0,
    newLines,
    header: '',
    lines,
  };
}

// ---------------------------------------------------------------------------
// computeFileDiff
// ---------------------------------------------------------------------------

function changeTexts(change: FileChange): { oldText: string; newText: string } {
  switch (change.kind) {
    case 'created':
      return { oldText: '', newText: change.newText };
    case 'deleted':
      return { oldText: change.oldText, newText: '' };
    case 'modified':
    case 'renamed':
      return { oldText: change.oldText, newText: change.newText };
  }
}

/** A hunk is whitespace-only when its del text and add text agree once ALL whitespace is stripped. */
function hunkWhitespaceOnly(hunk: Hunk): boolean {
  let del = '';
  let add = '';
  for (const l of hunk.lines) {
    if (l.kind === 'del') del += l.text;
    else if (l.kind === 'add') add += l.text;
  }
  return del.replace(/\s+/g, '') === add.replace(/\s+/g, '');
}

function computeFileDiffInner(change: FileChange, opts?: DiffOptions): FileDiff {
  const context = Math.max(0, Math.floor(opts?.context ?? 3));
  const { oldText, newText } = changeTexts(change);
  const oldEol = detectEol(oldText);
  const newEol = detectEol(newText);
  const oldEndsWithNewline = endsWithNewline(oldText);
  const newEndsWithNewline = endsWithNewline(newText);
  const generated = isGeneratedPath(change.path);
  const modeChange =
    change.kind === 'modified' &&
    change.oldMode !== undefined &&
    change.newMode !== undefined &&
    change.oldMode !== change.newMode
      ? { from: change.oldMode, to: change.newMode }
      : undefined;

  if (isBinaryText(oldText) || isBinaryText(newText)) {
    return {
      change,
      hunks: [],
      stats: { added: 0, removed: 0, hunks: 0 },
      binary: { oldSize: Buffer.byteLength(oldText), newSize: Buffer.byteLength(newText) },
      oldEol,
      newEol,
      oldEndsWithNewline,
      newEndsWithNewline,
      whitespaceOnly: false,
      modeChange,
      unchanged: oldText === newText,
      generated,
    };
  }

  const normOld = normalizeEol(oldText);
  const normNew = normalizeEol(newText);
  const tooBig =
    Buffer.byteLength(normOld) > MAX_TEXT_BYTES || Buffer.byteLength(normNew) > MAX_TEXT_BYTES;

  let hunks: Hunk[];
  if (tooBig) {
    const rows: UiRow[] = [
      ...splitLines(normOld).map((text, i): UiRow => ({
        op: 'del',
        before: i + 1,
        after: null,
        text,
      })),
      ...splitLines(normNew).map((text, i): UiRow => ({
        op: 'add',
        before: null,
        after: i + 1,
        text,
      })),
    ];
    hunks = rows.length === 0 ? [] : [wholeFileHunk(rows)];
  } else {
    hunks = buildHunks(computeDiff(normOld, normNew), context);
  }

  for (const hunk of hunks) attachWordDiffs(hunk.lines);

  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const l of hunk.lines) {
      if (l.kind === 'add') added += 1;
      else if (l.kind === 'del') removed += 1;
    }
  }
  const unchanged = added === 0 && removed === 0;
  const whitespaceOnly = !unchanged && hunks.every(hunkWhitespaceOnly);

  return {
    change,
    hunks,
    stats: { added, removed, hunks: hunks.length },
    binary: undefined,
    oldEol,
    newEol,
    oldEndsWithNewline,
    newEndsWithNewline,
    whitespaceOnly,
    modeChange,
    unchanged,
    generated,
  };
}

/**
 * Compute the full diff of one change. Never throws: an unexpected failure
 * degrades to a whole-file hunk (or an empty diff when even that fails).
 */
export function computeFileDiff(change: FileChange, opts?: DiffOptions): FileDiff {
  try {
    return computeFileDiffInner(change, opts);
  } catch {
    const { oldText, newText } = changeTexts(change);
    return {
      change,
      hunks: [],
      stats: { added: 0, removed: 0, hunks: 0 },
      binary: undefined,
      oldEol: detectEol(oldText),
      newEol: detectEol(newText),
      oldEndsWithNewline: endsWithNewline(oldText),
      newEndsWithNewline: endsWithNewline(newText),
      whitespaceOnly: false,
      modeChange: undefined,
      unchanged: oldText === newText,
      generated: isGeneratedPath(change.path),
    };
  }
}

// ---------------------------------------------------------------------------
// applyHunks
// ---------------------------------------------------------------------------

/**
 * Apply ONLY the accepted hunk indices to the raw old text. Verification is
 * positional AND textual: each hunk's del+ctx lines must equal the old lines
 * at oldStart, or the result is PATCH_MISMATCH naming the hunk and the first
 * differing line. Output is re-encoded with the diff's newEol and gets its
 * final terminator iff newEndsWithNewline. accepted=[] returns oldText as-is.
 */
export function applyHunks(
  oldText: string,
  diff: FileDiff,
  accepted: readonly number[],
): SafeResult<string> {
  try {
    if (diff.binary !== undefined) return { ok: true, value: oldText };
    const indices = [...new Set(accepted.filter((i) => i >= 0 && i < diff.hunks.length))].sort(
      (a, b) => a - b,
    );
    // Nothing accepted → oldText untouched (no re-encoding). The exception is
    // a diff with ZERO hunks: then "accepted" trivially covers everything and
    // an EOL-only change must still re-encode — applyHunks(a, diff(a→b), all)
    // === b holds even when a and b differ only in terminators.
    if (indices.length === 0 && diff.hunks.length > 0) return { ok: true, value: oldText };

    const oldLines = splitLines(normalizeEol(oldText));

    // Verify all accepted hunks BEFORE mutating anything (all-or-nothing).
    for (const hi of indices) {
      const hunk = diff.hunks[hi]!;
      const expected: string[] = [];
      for (const l of hunk.lines) {
        if (l.kind === 'del' || l.kind === 'ctx') expected.push(l.text);
      }
      const start = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart;
      for (let k = 0; k < expected.length; k++) {
        const actual = oldLines[start + k];
        if (actual !== expected[k]) {
          return {
            ok: false,
            error: {
              code: 'PATCH_MISMATCH',
              message:
                `hunk ${hi} does not apply at old line ${start + k + 1}: ` +
                `expected ${JSON.stringify(expected[k])}, found ${JSON.stringify(actual ?? '<EOF>')}`,
              path: diff.change.path,
            },
          };
        }
      }
    }

    // Splice last-hunk-first so earlier positions stay valid.
    const lines = [...oldLines];
    for (let k = indices.length - 1; k >= 0; k--) {
      const hunk = diff.hunks[indices[k]!]!;
      const start = hunk.oldLines > 0 ? hunk.oldStart - 1 : hunk.oldStart;
      const replacement: string[] = [];
      for (const l of hunk.lines) {
        if (l.kind === 'add' || l.kind === 'ctx') replacement.push(l.text);
      }
      lines.splice(start, hunk.oldLines, ...replacement);
    }

    if (lines.length === 0) return { ok: true, value: '' };
    const eol = diff.newEol === 'crlf' ? '\r\n' : '\n';
    let out = lines.join(eol);
    if (diff.newEndsWithNewline) out += eol;
    return { ok: true, value: out };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: 'PATCH_MISMATCH',
        message: `apply failed: ${err instanceof Error ? err.message : 'unknown error'}`,
        path: diff.change.path,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// toUnifiedPatch
// ---------------------------------------------------------------------------

/** `100644`-style git mode string from unix permission bits. */
function gitMode(mode: number | undefined): string {
  if (mode === undefined) return '100644';
  const exec = (mode & 0o111) !== 0;
  return exec ? '100755' : '100644';
}

/** GNU count formatting: `-5` when count is 1, `-5,3` otherwise. */
function range(start: number, count: number): string {
  return count === 1 ? `${start}` : `${start},${count}`;
}

/** Total normalized line counts of both sides, from the embedded change. */
function sideLineCounts(diff: FileDiff): { oldCount: number; newCount: number } {
  const { oldText, newText } = changeTexts(diff.change);
  return {
    oldCount: splitLines(normalizeEol(oldText)).length,
    newCount: splitLines(normalizeEol(newText)).length,
  };
}

/**
 * A valid unified patch for the accepted hunks (default: all). Headers:
 * `diff --git a/x b/y`, plus the kind-specific extended headers (new/deleted
 * file mode, rename from/to + similarity index, old/new mode). `\ No newline
 * at end of file` is emitted after a row that reaches a file end whose side
 * lacks the final terminator. Paths are emitted unquoted — git accepts spaces.
 */
export function toUnifiedPatch(diff: FileDiff, acceptedHunks?: readonly number[]): string {
  const change = diff.change;
  const oldPath = change.kind === 'renamed' ? change.oldPath : change.path;
  const newPath = change.path;
  const out: string[] = [];
  out.push(`diff --git a/${oldPath} b/${newPath}`);

  if (change.kind === 'created') {
    out.push(`new file mode ${gitMode(change.newMode)}`);
  } else if (change.kind === 'deleted') {
    out.push(`deleted file mode ${gitMode(change.oldMode)}`);
  } else if (change.kind === 'renamed') {
    out.push(`similarity index ${Math.round(change.similarity * 100)}%`);
    out.push(`rename from ${change.oldPath}`);
    out.push(`rename to ${change.path}`);
  } else if (diff.modeChange !== undefined) {
    out.push(`old mode ${gitMode(diff.modeChange.from)}`);
    out.push(`new mode ${gitMode(diff.modeChange.to)}`);
  }

  if (diff.binary !== undefined) {
    out.push(`Binary files a/${oldPath} and b/${newPath} differ`);
    return out.join('\n') + '\n';
  }

  out.push(change.kind === 'created' ? '--- /dev/null' : `--- a/${oldPath}`);
  out.push(change.kind === 'deleted' ? '+++ /dev/null' : `+++ b/${newPath}`);

  const indices =
    acceptedHunks === undefined
      ? diff.hunks.map((_, i) => i)
      : [...new Set(acceptedHunks.filter((i) => i >= 0 && i < diff.hunks.length))].sort(
          (a, b) => a - b,
        );

  const { oldCount, newCount } = sideLineCounts(diff);
  for (const hi of indices) {
    const hunk = diff.hunks[hi]!;
    // Counts are recomputed from the rows so a hunk subset stays self-consistent.
    let oldLines = 0;
    let newLines = 0;
    for (const l of hunk.lines) {
      if (l.kind !== 'add') oldLines += 1;
      if (l.kind !== 'del') newLines += 1;
    }
    const header = hunk.header === '' ? '' : ` ${hunk.header}`;
    out.push(
      `@@ -${range(hunk.oldStart, oldLines)} +${range(hunk.newStart, newLines)} @@${header}`,
    );
    const oldEnd = hunk.oldStart + oldLines - 1; // 1-based last covered old line
    const newEnd = hunk.newStart + newLines - 1;
    let lastOld = 0; // last old line number emitted so far in this hunk
    let lastNew = 0;
    let pendingOld = hunk.oldLines > 0 ? hunk.oldStart : 0;
    let pendingNew = hunk.newLines > 0 ? hunk.newStart : 0;
    for (const l of hunk.lines) {
      if (l.kind === 'ctx') {
        out.push(` ${l.text}`);
        lastOld = pendingOld;
        lastNew = pendingNew;
        pendingOld += 1;
        pendingNew += 1;
      } else if (l.kind === 'del') {
        out.push(`-${l.text}`);
        lastOld = pendingOld;
        pendingOld += 1;
      } else {
        out.push(`+${l.text}`);
        lastNew = pendingNew;
        pendingNew += 1;
      }
      // One marker per ROW, earned when that row reaches a file end whose
      // side lacks the final terminator (a shared trailing ctx line earns one).
      const earnsOld =
        l.kind !== 'add' &&
        !diff.oldEndsWithNewline &&
        oldCount > 0 &&
        lastOld === oldEnd &&
        oldEnd === oldCount;
      const earnsNew =
        l.kind !== 'del' &&
        !diff.newEndsWithNewline &&
        newCount > 0 &&
        lastNew === newEnd &&
        newEnd === newCount;
      if (earnsOld || earnsNew) {
        out.push('\\ No newline at end of file');
        lastOld = 0;
        lastNew = 0;
      }
    }
  }
  return out.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// pairRenames
// ---------------------------------------------------------------------------

/** Similarity scoring is capped for pathological sizes (pairing, not diffing). */
const MAX_PAIR_SCORE_LINES = 5000;

function scoreRename(a: string, b: string): number {
  const aLines = splitLines(normalizeEol(a));
  const bLines = splitLines(normalizeEol(b));
  if (aLines.length > MAX_PAIR_SCORE_LINES || bLines.length > MAX_PAIR_SCORE_LINES) return 0;
  return similarity(a, b);
}

/**
 * Merge delete+create pairs into renames. Every deleted×created pair is
 * scored by line-multiset similarity; pairs ≥ threshold (default 0.6) are
 * claimed greedily, best score first, each file used once. The merged rename
 * takes the deleted change's slot in the output order; unmatched changes
 * pass through untouched. Same-path pairs are never merged (that's a rewrite).
 */
export function pairRenames(changes: readonly FileChange[], threshold?: number): FileChange[] {
  const floor = threshold ?? 0.6;
  interface Pair {
    d: number;
    c: number;
    score: number;
  }
  const pairs: Pair[] = [];
  for (let d = 0; d < changes.length; d++) {
    const del = changes[d]!;
    if (del.kind !== 'deleted') continue;
    for (let c = 0; c < changes.length; c++) {
      const cre = changes[c]!;
      if (cre.kind !== 'created') continue;
      if (del.path === cre.path) continue;
      const score = scoreRename(del.oldText, cre.newText);
      if (score >= floor) pairs.push({ d, c, score });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  const usedD = new Set<number>();
  const usedC = new Set<number>();
  const merged = new Map<number, FileChange>(); // deleted-index → rename
  for (const p of pairs) {
    if (usedD.has(p.d) || usedC.has(p.c)) continue;
    usedD.add(p.d);
    usedC.add(p.c);
    const del = changes[p.d]!;
    const cre = changes[p.c]!;
    if (del.kind !== 'deleted' || cre.kind !== 'created') continue;
    merged.set(p.d, {
      kind: 'renamed',
      oldPath: del.path,
      path: cre.path,
      oldText: del.oldText,
      newText: cre.newText,
      similarity: p.score,
    });
  }
  const out: FileChange[] = [];
  for (let i = 0; i < changes.length; i++) {
    if (usedC.has(i)) continue; // created side absorbed into a rename
    const m = merged.get(i);
    out.push(m ?? changes[i]!);
  }
  return out;
}
