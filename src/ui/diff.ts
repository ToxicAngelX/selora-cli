/**
 * Line diff rendering (v0.3) for file-edit previews.
 *
 * computeDiff() is a Myers O(ND) greedy diff (iterative, per-depth V-array
 * trace — no recursion, so large files cannot blow the stack). If the edit
 * distance exceeds 2000 it degrades honestly to a whole-block replace: one
 * meta line, then every `before` line as a deletion and every `after` line
 * as an insertion — bounded work instead of a quadratic crawl.
 *
 * Line semantics: a text ending in '\n' does NOT produce a trailing empty
 * line; `before` numbers are 1-based positions in the original (del/ctx,
 * null for add), `after` numbers are 1-based in the new (add/ctx, null for
 * del). All decoration goes through an injected DiffStyle, so the module is
 * pure and theme-agnostic; plainDiffStyle() is the colorless default.
 *
 * renderDiffLines() keeps `context` (default 3) unchanged lines around each
 * add/del hunk and collapses longer skipped runs into a single
 * '··· N unchanged lines ···' meta line. A skipped run of exactly one line
 * is shown as-is (replacing one line with one meta line saves nothing).
 * An all-context diff (identical inputs) renders as [] — nothing to show;
 * that is the documented behavior. Nothing here throws.
 */

export type DiffOp = 'add' | 'del' | 'ctx' | 'meta';

export interface DiffLine {
  op: DiffOp;
  /** 1-based line in the original for del/ctx lines; null for add/meta. */
  before: number | null;
  /** 1-based line in the new for add/ctx lines; null for del/meta. */
  after: number | null;
  text: string;
}

export interface DiffStyle {
  add(text: string): string;
  del(text: string): string;
  ctx(text: string): string;
  meta(text: string): string;
  /** Line-number column content (plain style: zero-padded, width 3). */
  lineNo(n: number): string;
}

/** Skipped-ctx runs shorter than this are shown literally instead of elided. */
const MIN_ELIDED = 2;
/** Above this edit distance, computeDiff falls back to whole-block replace. */
const MAX_EDIT_DISTANCE = 2000;

/** No-color default: '+ ' / '- ' / '  ' / '··· x ···', numbers zero-padded to 3. */
export function plainDiffStyle(): DiffStyle {
  return {
    add: (text) => `+ ${text}`,
    del: (text) => `- ${text}`,
    ctx: (text) => `  ${text}`,
    meta: (text) => `··· ${text} ···`,
    lineNo: (n) => String(n).padStart(3, '0'),
  };
}

/**
 * Split into lines: 'a\nb' → ['a','b'], 'a\nb\n' → ['a','b'] (a trailing
 * newline is a terminator, not an extra empty line), '\n' → [''], '' → [].
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n') && parts.length > 0) parts.pop();
  return parts;
}

function fallbackDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const out: DiffLine[] = [
    { op: 'meta', before: null, after: null, text: 'large change — full before/after shown' },
  ];
  a.forEach((text, i) => out.push({ op: 'del', before: i + 1, after: null, text }));
  b.forEach((text, i) => out.push({ op: 'add', before: null, after: i + 1, text }));
  return out;
}

/**
 * Full line diff, no context trimming. Myers greedy forward pass with a
 * per-depth V snapshot for backtracking; returns null when the edit
 * distance exceeds MAX_EDIT_DISTANCE (caller falls back).
 */
function myersDiff(a: readonly string[], b: readonly string[]): DiffLine[] | null {
  const n = a.length;
  const m = b.length;
  const offset = n + m;
  const v = new Int32Array(2 * (n + m) + 3);
  const trace: Int32Array[] = [];
  const maxD = Math.min(MAX_EDIT_DISTANCE, n + m);
  let foundAt = -1;

  for (let d = 0; d <= maxD; d++) {
    let done = false;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      // reads hit depth-(d-1) diagonals (guarded by the k === ±d checks)
      if (k === -d || (k !== d && (v[k - 1 + offset] ?? 0) < (v[k + 1 + offset] ?? 0))) {
        x = v[k + 1 + offset] ?? 0;
      } else {
        x = (v[k - 1 + offset] ?? 0) + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[k + offset] = x;
      if (x >= n && y >= m) {
        done = true;
        break;
      }
    }
    trace.push(v.slice(offset - d, offset + d + 1));
    if (done) {
      foundAt = d;
      break;
    }
  }

  if (foundAt === -1) return null;

  // Backtrack the path from (n, m), collecting DiffLines in reverse.
  const reverse: DiffLine[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const depthV = trace[d]!;
    const k = x - y;
    if (d === 0) {
      while (x > 0 && y > 0) {
        x -= 1;
        y -= 1;
        reverse.push({ op: 'ctx', before: x + 1, after: y + 1, text: a[x]! });
      }
      break;
    }
    let prevK: number;
    if (k === -d || (k !== d && (depthV[k - 1 + d] ?? 0) < (depthV[k + 1 + d] ?? 0))) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = depthV[prevK + d]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reverse.push({ op: 'ctx', before: x + 1, after: y + 1, text: a[x]! });
    }
    if (x === prevX) {
      // vertical move: one insertion from `after`
      reverse.push({ op: 'add', before: null, after: prevY + 1, text: b[prevY]! });
    } else {
      // horizontal move: one deletion from `before`
      reverse.push({ op: 'del', before: prevX + 1, after: null, text: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }
  return reverse.reverse();
}

/** Full line diff of two texts (no context trimming). Never throws. */
export function computeDiff(before: string, after: string): DiffLine[] {
  return (
    myersDiff(splitLines(before), splitLines(after)) ??
    fallbackDiff(splitLines(before), splitLines(after))
  );
}

function styled(op: DiffOp, text: string, style: DiffStyle): string {
  switch (op) {
    case 'add':
      return style.add(text);
    case 'del':
      return style.del(text);
    case 'ctx':
      return style.ctx(text);
    case 'meta':
      return style.meta(text);
  }
}

/** One output row: '<beforeNo> <afterNo> <styled text>' (blank columns for null). */
function formatRow(line: DiffLine, style: DiffStyle): string {
  const beforeCol = line.before === null ? '   ' : style.lineNo(line.before);
  const afterCol = line.after === null ? '   ' : style.lineNo(line.after);
  return `${beforeCol} ${afterCol} ${styled(line.op, line.text, style)}`;
}

/**
 * Render a computed diff with context grouping: keep `context` (default 3)
 * unchanged lines around each add/del hunk; elide longer skipped runs into
 * '··· N unchanged lines ···'. Identical inputs (all ctx) → [] — the
 * documented nothing-to-show behavior.
 */
export function renderDiffLines(
  diff: readonly DiffLine[],
  style: DiffStyle,
  opts?: { context?: number },
): string[] {
  const context = opts?.context ?? 3;
  if (!diff.some((line) => line.op === 'add' || line.op === 'del')) return [];

  const keep = new Array<boolean>(diff.length).fill(false);
  diff.forEach((line, i) => {
    if (line.op === 'add' || line.op === 'del') {
      keep[i] = true;
      for (let j = Math.max(0, i - context); j <= Math.min(diff.length - 1, i + context); j++) {
        keep[j] = true;
      }
    }
  });

  const out: string[] = [];
  let i = 0;
  while (i < diff.length) {
    if (keep[i]) {
      out.push(formatRow(diff[i]!, style));
      i += 1;
      continue;
    }
    let j = i;
    while (j < diff.length && !keep[j]) j += 1;
    const skipped = j - i;
    if (skipped >= MIN_ELIDED) {
      out.push(
        formatRow(
          { op: 'meta', before: null, after: null, text: `${skipped} unchanged lines` },
          style,
        ),
      );
    } else {
      for (let k = i; k < j; k++) {
        out.push(formatRow(diff[k]!, style));
      }
    }
    i = j;
  }
  return out;
}

/** Compute and render a unified diff in one call. */
export function renderUnifiedDiff(
  before: string,
  after: string,
  style: DiffStyle,
  opts?: { context?: number },
): string[] {
  return renderDiffLines(computeDiff(before, after), style, opts);
}
