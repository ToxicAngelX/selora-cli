/**
 * src/diff/renderer.ts — FileDiff → boxed ANSI rows. This is the visual heart
 * of the diff subsystem: the engine hands over a pure FileDiff and this
 * module returns the exact strings to print, one per terminal row. Functions
 * here are PURE — no I/O, no printing, no clocks, no randomness; the only
 * ambient read is the documented default `scheme: detectScheme(process.env)`,
 * and tests always pass `scheme` explicitly.
 *
 * The unified layout (widths shrink honestly below 40 columns — gutters shed
 * their padding and divider, never a negative repeat, never a throw):
 *
 *   ╭─ ✎ Modified  src/utils/format.ts ───────────── +2 −1 ─╮
 *   │ @@ -10,3 +10,4 @@ export function formatPrice          │
 *   │  10   10 │   const rate = getRate();                    │
 *   │  11      │ − const total = price * rate;               │
 *   │       11 │ + const total = round(price * rate);        │
 *   ╰────────────────────────────────────────────────────────╯
 *
 * Composition rules that make it read well:
 *  - The box hugs its content: width = min(terminal, widest natural row).
 *  - add/del row backgrounds span the FULL inner width (gutters, marker,
 *    text and the trailing pad all sit on addedBg/removedBg); ctx rows have
 *    no background. Changed WORDS on paired lines get the brighter word bg.
 *  - Syntax roles (from highlight.ts) supply FOREGROUND colors from the
 *    galaxy palette; the diff background is layered underneath; word-changed
 *    segments override the bg. Each row is emitted as SGR transitions with
 *    ONE reset at row end, so the background is visually continuous.
 *  - Color level 0 (NO_COLOR/non-TTY) or the mono THEME: zero escapes — the
 *    box, markers and gutters carry everything. The mono DIFF palette
 *    suppresses all hues (no 48;2/38;2 ever) and distinguishes add/del with
 *    bold markers and dim deletion text.
 *  - split view (side-by-side): old on the left (del cells on removedBg),
 *    new on the right (add cells on addedBg), a '│' center divider, gutter
 *    numbers on the OUTER edges. ctx rows are DUPLICATED dim into both
 *    columns (the documented choice — spanning looked broken with unequal
 *    side gutters). del/add runs in a hunk are zipped into row pairs; an
 *    unpaired side renders blank.
 *  - RTL/Arabic text is never reordered and never gets bidi controls
 *    injected; truncation is by DISPLAY width only (string-width), and a wide
 *    char (CJK/emoji) is never split.
 */

import stringWidth from 'string-width';
import type { ColorLevel, Theme } from '../ui/theme.js';
import type { BinaryInfo, DiffLine, DiffPalette, FileDiff, Hunk, RenderOptions } from './types.js';
import { bgSgrParams, detectScheme, diffPaletteFor, fgSgrParams } from './theme.js';
import { highlightLine, type HighlightRole } from './highlight.js';

const CSI = '\x1b[';
const RESET = '\x1b[0m';
/** U+2212 — the typographic minus used for deletion markers and stats. */
const MINUS = '−';
const ELLIPSIS = '…';
/** Below this terminal width the unified gutters shed padding + divider. */
const COMPACT_WIDTH = 40;
/** Split view needs at least this many box columns; narrower → unified. */
const MIN_SPLIT_WIDTH = 24;
/** 'auto' view picks split at/above this terminal width. */
const AUTO_SPLIT_WIDTH = 140;

// ---------------------------------------------------------------------------
// segment painting — one SGR transition per segment, one reset per row
// ---------------------------------------------------------------------------

interface PaintSeg {
  text: string;
  fg?: string | undefined;
  bg?: string | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
}

interface PaintEnv {
  /** 0 when the diff palette is mono — no hue escapes, ever. */
  colorLevel: ColorLevel;
  /** theme.level > 0 — bold/dim survive the mono palette, die at level 0. */
  emphasis: boolean;
}

/** Paint one row of segments. Zero escapes when the env allows none. */
function paintRow(segs: readonly PaintSeg[], env: PaintEnv): string {
  let out = '';
  let open = false;
  for (const seg of segs) {
    if (seg.text === '') continue;
    const parts: string[] = [];
    if (env.emphasis) {
      if (seg.bold === true) parts.push('1');
      if (seg.dim === true) parts.push('2');
    }
    if (env.colorLevel > 0) {
      if (seg.fg !== undefined) {
        const f = fgSgrParams(seg.fg, env.colorLevel);
        if (f !== '') parts.push(f);
      }
      if (seg.bg !== undefined) {
        const b = bgSgrParams(seg.bg, env.colorLevel);
        if (b !== '') parts.push(b);
      }
    }
    if (parts.length === 0) {
      if (open) {
        out += RESET;
        open = false;
      }
      out += seg.text;
    } else {
      out += `${CSI}${parts.join(';')}m${seg.text}`;
      open = true;
    }
  }
  if (open) out += RESET;
  return out;
}

// ---------------------------------------------------------------------------
// text plumbing: control stripping, width-aware truncate, segment truncate
// ---------------------------------------------------------------------------

/**
 * Drop C0 controls (except \t) and DEL from file text. A diff renders file
 * content straight into the user's terminal — an ESC byte in a file would
 * otherwise inject escape sequences into the output.
 */
function stripControls(text: string): string {
  let out = '';
  let dirty = false;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if ((code < 32 && code !== 9) || code === 127) {
      dirty = true;
      continue;
    }
    out += ch;
  }
  return dirty ? out : text;
}

/**
 * Truncate to `max` DISPLAY columns, appending '…' when cut. Iterates code
 * points (never splits a surrogate pair) and measures with string-width
 * (never splits a wide char; the ellipsis takes the last reserved column).
 */
function truncateVis(s: string, max: number): string {
  if (max <= 0) return '';
  if (stringWidth(s) <= max) return s;
  if (max === 1) return ELLIPSIS;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = stringWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + ELLIPSIS;
}

/**
 * Truncate a SEGMENT LIST to `max` display columns: whole segments are kept
 * until one doesn't fit; that one is cut with '…' and the rest dropped.
 */
function truncateSegs<T extends { text: string }>(segs: readonly T[], max: number): T[] {
  if (max <= 0) return [];
  const out: T[] = [];
  let used = 0;
  for (const seg of segs) {
    if (seg.text === '') continue;
    const w = stringWidth(seg.text);
    if (used + w <= max) {
      out.push(seg);
      used += w;
      continue;
    }
    out.push({ ...seg, text: truncateVis(seg.text, max - used) });
    break;
  }
  return out;
}

function segsWidth(segs: readonly { text: string }[]): number {
  let w = 0;
  for (const s of segs) w += stringWidth(s.text);
  return w;
}

// ---------------------------------------------------------------------------
// small formatters
// ---------------------------------------------------------------------------

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Unix mode as git-style 6 octal digits: 0o644 and 0o100644 both → '100644'. */
function octal(mode: number): string {
  const s = mode.toString(8);
  return s.length <= 3 ? `100${s.padStart(3, '0')}` : s.padStart(6, '0');
}

/** GNU-style range: count 1 omits ',1'. */
function hunkHeaderText(h: Hunk): string {
  const range = (start: number, lines: number): string =>
    lines === 1 ? `${start}` : `${start},${lines}`;
  const base = `@@ -${range(h.oldStart, h.oldLines)} +${range(h.newStart, h.newLines)} @@`;
  return h.header === '' ? base : `${base} ${h.header}`;
}

/** The between-hunk separator: '⋯ N unchanged lines ⋯' (singular when 1). */
function sepText(skipped: number): string {
  return `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'} ⋯`;
}

// ---------------------------------------------------------------------------
// render context + body row model
// ---------------------------------------------------------------------------

interface RenderCtx {
  theme: Theme;
  pal: DiffPalette;
  isMono: boolean;
  env: PaintEnv;
  maxLines: number;
  syntax: boolean;
  wordDiff: boolean;
  showWs: boolean;
  /** Highlight hint (the new path; renames highlight as the new file). */
  path: string;
}

type BodyRow =
  | { t: 'note'; text: string }
  | { t: 'hunk'; text: string }
  /** Separator between distant hunks: how many unchanged lines were skipped. */
  | { t: 'sep'; skipped: number }
  | { t: 'cap'; text: string }
  | { t: 'line'; line: DiffLine }
  | { t: 'pair'; left: DiffLine | null; right: DiffLine | null };

/** Zip one hunk's lines into side-by-side pairs (ctx duplicated both sides). */
function pairsOf(lines: readonly DiffLine[]): Array<[DiffLine | null, DiffLine | null]> {
  const out: Array<[DiffLine | null, DiffLine | null]> = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.kind === 'ctx') {
      out.push([l, l]);
      i += 1;
      continue;
    }
    if (l.kind === 'del') {
      const dels: DiffLine[] = [];
      while (i < lines.length && lines[i]!.kind === 'del') {
        dels.push(lines[i]!);
        i += 1;
      }
      const adds: DiffLine[] = [];
      while (i < lines.length && lines[i]!.kind === 'add') {
        adds.push(lines[i]!);
        i += 1;
      }
      const n = Math.max(dels.length, adds.length);
      for (let k = 0; k < n; k += 1) out.push([dels[k] ?? null, adds[k] ?? null]);
      continue;
    }
    out.push([null, l]); // a pure insertion with no deletion counterpart
    i += 1;
  }
  return out;
}

/**
 * The '\ No newline at end of file' marker, inserted after the last rendered
 * line of the affected side. Created files only have a new side, deleted only
 * an old side; for modified/renamed the marker shows only when the two sides
 * actually differ in trailing-newline state.
 */
function insertNewlineNote(diff: FileDiff, rows: BodyRow[]): void {
  const kind = diff.change.kind;
  let side: 'old' | 'new' | null = null;
  if (kind === 'created') {
    if (!diff.newEndsWithNewline) side = 'new';
  } else if (kind === 'deleted') {
    if (!diff.oldEndsWithNewline) side = 'old';
  } else if (diff.oldEndsWithNewline !== diff.newEndsWithNewline) {
    side = diff.oldEndsWithNewline ? 'new' : 'old';
  }
  if (side === null) return;
  const carries = (line: DiffLine): boolean =>
    side === 'old' ? line.oldNo !== null : line.newNo !== null;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const r = rows[i]!;
    if (r.t === 'line' && carries(r.line)) {
      rows.splice(i + 1, 0, { t: 'note', text: '\\ No newline at end of file' });
      return;
    }
    if (r.t === 'pair') {
      const line = side === 'old' ? r.left : r.right;
      if (line !== null && carries(line)) {
        rows.splice(i + 1, 0, { t: 'note', text: '\\ No newline at end of file' });
        return;
      }
    }
  }
}

function assembleBodyRows(diff: FileDiff, view: 'unified' | 'split'): BodyRow[] {
  const rows: BodyRow[] = [];
  if (diff.whitespaceOnly) rows.push({ t: 'note', text: 'whitespace-only changes' });
  if (diff.modeChange !== undefined) {
    rows.push({
      t: 'note',
      text: `mode ${octal(diff.modeChange.from)} → ${octal(diff.modeChange.to)}`,
    });
  }
  let prev: Hunk | null = null;
  for (const hunk of diff.hunks) {
    // Distant hunks get a '⋯ N unchanged lines ⋯' separator row (the skipped
    // span between them); touching hunks flow on without one.
    if (prev !== null && hunk.oldStart > prev.oldStart + prev.oldLines) {
      rows.push({ t: 'sep', skipped: hunk.oldStart - (prev.oldStart + prev.oldLines) });
    }
    rows.push({ t: 'hunk', text: hunkHeaderText(hunk) });
    if (view === 'split') {
      for (const [left, right] of pairsOf(hunk.lines)) rows.push({ t: 'pair', left, right });
    } else {
      for (const line of hunk.lines) rows.push({ t: 'line', line });
    }
    prev = hunk;
  }
  insertNewlineNote(diff, rows);
  return rows;
}

/** Cap rendered body rows; the cap row reports unrendered LINE rows. */
function applyCap(rows: BodyRow[], maxLines: number): BodyRow[] {
  if (maxLines === 0 || rows.length <= maxLines) return rows;
  const visible = rows.slice(0, maxLines);
  const rest = rows.slice(maxLines);
  let n = 0;
  for (const r of rest) {
    if (r.t === 'line' || r.t === 'pair') n += 1;
  }
  if (n === 0) n = rest.length;
  visible.push({ t: 'cap', text: `${ELLIPSIS} ${n} more lines · press e to expand` });
  return visible;
}

// ---------------------------------------------------------------------------
// display text: whitespace markers, word segments, syntax roles
// ---------------------------------------------------------------------------

/** The text as displayed (controls stripped; tabs/trailing spaces visible when showWs). */
function displayText(text: string, showWs: boolean): string {
  let t = stripControls(text);
  if (showWs) {
    t = t.replace(/\t/g, '→ ');
    t = t.replace(/ +$/, (m) => '·'.repeat(m.length));
  }
  return t;
}

function roleFg(
  role: HighlightRole,
  ctx: RenderCtx,
  baseFg: string | undefined,
): string | undefined {
  const p = ctx.theme.palette;
  switch (role) {
    case 'keyword':
      return p.violet;
    case 'string':
      return p.cyan;
    case 'comment':
      return p.space;
    case 'number':
      return p.magenta;
    case 'plain':
      return baseFg;
  }
}

/**
 * The styled text segments of one diff line, truncated to `textW` display
 * columns: word-diff segments (when present and enabled) carry the brighter
 * word bg on changed spans; syntax roles recolor foregrounds; the row bg
 * (or word bg) is layered under every segment.
 */
function lineTextSegs(
  line: DiffLine,
  ctx: RenderCtx,
  textW: number,
  baseFg: string | undefined,
  rowBg: string | undefined,
  rowDim: boolean,
): PaintSeg[] {
  const raw =
    ctx.wordDiff && line.words !== undefined && line.words.length > 0
      ? line.words.map((wd) => ({ text: stripControls(wd.text), changed: wd.changed }))
      : [{ text: stripControls(line.text), changed: false }];
  let disp = raw;
  if (ctx.showWs) {
    disp = raw.map((s) => ({ ...s, text: s.text.replace(/\t/g, '→ ') }));
    // Trailing spaces live at the tail of the last non-empty segment.
    for (let k = disp.length - 1; k >= 0; k -= 1) {
      const s = disp[k]!;
      if (s.text === '') continue;
      const m = /( +)$/.exec(s.text);
      if (m !== null) {
        const spaces = m[1] ?? '';
        disp[k] = {
          text: s.text.slice(0, s.text.length - spaces.length) + '·'.repeat(spaces.length),
          changed: s.changed,
        };
      }
      break;
    }
  }
  const cut = truncateSegs(disp, textW);
  const out: PaintSeg[] = [];
  for (const seg of cut) {
    if (seg.text === '') continue;
    let wordBg: string | undefined;
    if (seg.changed && ctx.wordDiff && !ctx.isMono) {
      if (line.kind === 'add') wordBg = ctx.pal.addedWordBg;
      else if (line.kind === 'del') wordBg = ctx.pal.removedWordBg;
    }
    const bg = wordBg ?? rowBg;
    if (ctx.syntax && !ctx.isMono) {
      for (const tok of highlightLine(seg.text, ctx.path)) {
        if (tok.text === '') continue;
        out.push({ text: tok.text, fg: roleFg(tok.role, ctx, baseFg), bg, dim: rowDim });
      }
    } else {
      out.push({ text: seg.text, fg: baseFg, bg, dim: rowDim });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------

function borderFgOf(ctx: RenderCtx): string | undefined {
  return ctx.isMono ? undefined : ctx.pal.borderFg;
}

/** Full-inner-width meta row (hunk headers, notes, separators, caps). */
function metaRow(
  text: string,
  ctx: RenderCtx,
  inner: number,
  style: { hunk?: boolean; center?: boolean },
): string {
  const border = borderFgOf(ctx);
  const fg = ctx.isMono ? undefined : style.hunk === true ? ctx.pal.hunkHeaderFg : ctx.pal.metaFg;
  const area = Math.max(0, inner - 1);
  let content: string;
  if (style.center === true) {
    const cut = truncateVis(text, area);
    const leftPad = Math.floor(Math.max(0, area - stringWidth(cut)) / 2);
    content = ' '.repeat(leftPad) + cut;
  } else {
    content = truncateVis(text, area);
  }
  const pad = Math.max(0, area - stringWidth(content));
  return paintRow(
    [
      { text: '│', fg: border },
      { text: ' ' },
      { text: content, fg, dim: true },
      { text: ' '.repeat(pad) },
      { text: '│', fg: border },
    ],
    ctx.env,
  );
}

function unifiedLineRow(
  line: DiffLine,
  ctx: RenderCtx,
  inner: number,
  w: number,
  full: boolean,
): string {
  const pal = ctx.pal;
  const isAdd = line.kind === 'add';
  const isDel = line.kind === 'del';
  const bg = ctx.isMono ? undefined : isAdd ? pal.addedBg : isDel ? pal.removedBg : undefined;
  const baseFg = ctx.isMono
    ? undefined
    : isAdd
      ? pal.addedFg
      : isDel
        ? pal.removedFg
        : pal.contextFg;
  const marker = isAdd ? '+' : isDel ? MINUS : ' ';
  const markerFg = ctx.isMono
    ? undefined
    : isAdd
      ? pal.addedMarker
      : isDel
        ? pal.removedMarker
        : undefined;
  const gutterFg = ctx.isMono ? undefined : pal.gutterFg;
  const rowDim = ctx.isMono && isDel; // mono: deletions read dimmer
  const chromeW = full ? 2 * w + 7 : 2 * w + 4;
  const border = borderFgOf(ctx);

  if (inner - chromeW < 2) {
    // Ultra-narrow (tiny terminal or huge line numbers): gutters would leave
    // no room for text — drop them and keep marker + text. Widths still exact.
    const tW = Math.max(0, inner - 2);
    const segs: PaintSeg[] = [
      { text: '│', fg: border },
      { text: marker, fg: markerFg, bg, bold: ctx.isMono && (isAdd || isDel) },
      { text: ' ', bg },
    ];
    let used = 0;
    for (const s of lineTextSegs(line, ctx, tW, baseFg, bg, rowDim)) {
      used += stringWidth(s.text);
      segs.push(s);
    }
    const pad = Math.max(0, tW - used);
    if (pad > 0) segs.push({ text: ' '.repeat(pad), bg });
    segs.push({ text: '│', fg: border });
    return paintRow(segs, ctx.env);
  }
  const textW = inner - chromeW;

  const oldStr = line.oldNo === null ? ' '.repeat(w) : String(line.oldNo).padStart(w);
  const newStr = line.newNo === null ? ' '.repeat(w) : String(line.newNo).padStart(w);

  const segs: PaintSeg[] = [{ text: '│', fg: border }];
  const onBg = (text: string, extra?: Partial<PaintSeg>): void => {
    segs.push({ text, bg, ...extra });
  };
  if (full) onBg(' ');
  onBg(oldStr, { fg: gutterFg, dim: true });
  onBg(' ');
  onBg(newStr, { fg: gutterFg, dim: true });
  if (full) {
    onBg(' ');
    onBg('│', { fg: gutterFg });
    onBg(' ');
  } else {
    onBg(' ');
  }
  onBg(marker, { fg: markerFg, bold: ctx.isMono && (isAdd || isDel) });
  onBg(' ');

  let used = 0;
  for (const s of lineTextSegs(line, ctx, textW, baseFg, bg, rowDim)) {
    used += stringWidth(s.text);
    segs.push(s);
  }
  const pad = Math.max(0, textW - used);
  if (pad > 0) onBg(' '.repeat(pad));
  segs.push({ text: '│', fg: borderFgOf(ctx) });
  return paintRow(segs, ctx.env);
}

/** One side of a split row, padded to exactly `cellW` display columns. */
function splitCellSegs(
  line: DiffLine | null,
  side: 'old' | 'new',
  ctx: RenderCtx,
  w: number,
  cellW: number,
): PaintSeg[] {
  if (cellW <= 0) return [];
  if (line === null) return [{ text: ' '.repeat(cellW) }];
  const pal = ctx.pal;
  const isDel = line.kind === 'del';
  const isAdd = line.kind === 'add';
  const isCtx = line.kind === 'ctx';
  const bg = ctx.isMono
    ? undefined
    : side === 'old'
      ? isDel
        ? pal.removedBg
        : undefined
      : isAdd
        ? pal.addedBg
        : undefined;
  const baseFg = ctx.isMono
    ? undefined
    : isDel
      ? pal.removedFg
      : isAdd
        ? pal.addedFg
        : pal.contextFg;
  const marker = isDel ? MINUS : isAdd ? '+' : ' ';
  const markerFg = ctx.isMono
    ? undefined
    : isDel
      ? pal.removedMarker
      : isAdd
        ? pal.addedMarker
        : undefined;
  const gutterFg = ctx.isMono ? undefined : pal.gutterFg;
  const no = side === 'old' ? line.oldNo : line.newNo;
  const noStr = no === null ? ' '.repeat(w) : String(no).padStart(w);
  // mono: deletions dim; split ctx rows are duplicated dim by design.
  const dim = (ctx.isMono && isDel) || isCtx;

  const textW = cellW - w - 3;
  const segs: PaintSeg[] = [];
  const onBg = (text: string, extra?: Partial<PaintSeg>): void => {
    segs.push({ text, bg, ...extra });
  };
  if (textW < 1) {
    // Degenerate narrow cell: gutters no longer fit — show what text fits.
    for (const s of lineTextSegs(line, ctx, cellW, baseFg, bg, dim)) segs.push(s);
    const used = segsWidth(segs);
    if (used < cellW) onBg(' '.repeat(cellW - used));
    return segs;
  }
  if (side === 'old') {
    onBg(noStr, { fg: gutterFg, dim: true });
    onBg(' ');
    onBg(marker, { fg: markerFg, bold: ctx.isMono && !isCtx });
    onBg(' ');
  } else {
    onBg(marker, { fg: markerFg, bold: ctx.isMono && !isCtx });
    onBg(' ');
  }
  let used = 0;
  for (const s of lineTextSegs(line, ctx, textW, baseFg, bg, dim)) {
    used += stringWidth(s.text);
    segs.push(s);
  }
  const pad = Math.max(0, textW - used);
  if (pad > 0) onBg(' '.repeat(pad));
  if (side === 'new') {
    onBg(' ');
    onBg(noStr, { fg: gutterFg, dim: true });
  }
  return segs;
}

function splitPairRow(
  left: DiffLine | null,
  right: DiffLine | null,
  ctx: RenderCtx,
  w: number,
  leftW: number,
  rightW: number,
): string {
  const border = borderFgOf(ctx);
  return paintRow(
    [
      { text: '│', fg: border },
      ...splitCellSegs(left, 'old', ctx, w, leftW),
      { text: '│', fg: border },
      ...splitCellSegs(right, 'new', ctx, w, rightW),
      { text: '│', fg: border },
    ],
    ctx.env,
  );
}

// ---------------------------------------------------------------------------
// header
// ---------------------------------------------------------------------------

interface HeaderSpec {
  titleSegs: PaintSeg[];
  stats: { added: number; removed: number } | null;
}

function buildHeader(diff: FileDiff, ctx: RenderCtx, showStats: boolean): HeaderSpec {
  const change = diff.change;
  const pal = ctx.pal;
  let icon: string;
  let label: string;
  let pathText: string;
  let iconFg: string | undefined;
  switch (change.kind) {
    case 'created':
      icon = '✚';
      label = 'Created';
      pathText = change.path;
      iconFg = pal.addedMarker;
      break;
    case 'modified':
      icon = '✎';
      label = 'Modified';
      pathText = change.path;
      iconFg = pal.hunkHeaderFg;
      break;
    case 'deleted':
      icon = '✖';
      label = 'Deleted';
      pathText = change.path;
      iconFg = pal.removedMarker;
      break;
    case 'renamed':
      icon = '➜';
      label = 'Renamed';
      pathText = `${change.oldPath} → ${change.path}`;
      iconFg = pal.metaFg;
      break;
  }
  if (ctx.isMono) iconFg = undefined;
  const titleSegs: PaintSeg[] = [
    { text: icon, fg: iconFg },
    { text: ' ' },
    { text: label, bold: true },
    { text: '  ' },
    { text: pathText },
  ];
  return {
    titleSegs,
    stats: showStats ? { added: diff.stats.added, removed: diff.stats.removed } : null,
  };
}

function titleRow(header: HeaderSpec, ctx: RenderCtx, W: number): string {
  const border = borderFgOf(ctx);
  if (W < 8) {
    // Degenerate width: a bare frame line, nothing else fits honestly.
    return paintRow([{ text: `╭${'─'.repeat(Math.max(0, W - 2))}╮`, fg: border }], ctx.env);
  }
  let stats = header.stats;
  let sW = stats === null ? 0 : String(stats.added).length + String(stats.removed).length + 3; // '+A −R'
  // Row: '╭─ ' + title + ' ' + dashes(k≥1) + (' ' + stats)? + ' ─╮' — solve the title budget.
  let titleMax = W - sW - (stats === null ? 8 : 9);
  if (stats !== null && titleMax < 4) {
    stats = null; // a narrow box drops the stats before butchering the path
    sW = 0;
    titleMax = W - 8;
  }
  const cut = truncateSegs(header.titleSegs, Math.max(0, titleMax));
  const tW = segsWidth(cut);
  // Without stats the closing '─╮' fragment would read as a stray '── ╮' —
  // the dashes simply run to the corner instead (width math stays exact).
  const dashes = Math.max(1, W - tW - sW - (stats === null ? 5 : 8));
  const segs: PaintSeg[] = [
    { text: '╭─ ', fg: border },
    ...cut,
    { text: ' ' },
    { text: '─'.repeat(dashes), fg: border },
  ];
  if (stats !== null) {
    segs.push({ text: ' ' });
    segs.push({ text: `+${stats.added}`, fg: ctx.isMono ? undefined : ctx.pal.addedMarker });
    segs.push({ text: ' ' });
    segs.push({
      text: `${MINUS}${stats.removed}`,
      fg: ctx.isMono ? undefined : ctx.pal.removedMarker,
    });
  }
  segs.push({ text: stats === null ? '╮' : ' ─╮', fg: border });
  return paintRow(segs, ctx.env);
}

function bottomRow(ctx: RenderCtx, W: number): string {
  return paintRow([{ text: `╰${'─'.repeat(Math.max(0, W - 2))}╯`, fg: borderFgOf(ctx) }], ctx.env);
}

// ---------------------------------------------------------------------------
// width resolution
// ---------------------------------------------------------------------------

function gutterDigits(diff: FileDiff): number {
  let max = 0;
  for (const h of diff.hunks) {
    for (const l of h.lines) {
      if (l.oldNo !== null && l.oldNo > max) max = l.oldNo;
      if (l.newNo !== null && l.newNo > max) max = l.newNo;
    }
  }
  return Math.max(1, String(max).length);
}

interface Measure {
  /** The widest inner width the rows + header would LIKE (before truncation). */
  natural: number;
  /** Split view: natural column widths (0 when a side has no content). */
  leftMax: number;
  rightMax: number;
}

function measure(
  rows: readonly BodyRow[],
  header: HeaderSpec,
  view: 'unified' | 'split',
  w: number,
  full: boolean,
  ctx: RenderCtx,
): Measure {
  const statsW =
    header.stats === null
      ? 0
      : String(header.stats.added).length + String(header.stats.removed).length + 3;
  // Title row needs W ≥ title + stats + 9 (with stats) / + 8 — as INNER width: −2.
  let natural = segsWidth(header.titleSegs) + statsW + (statsW > 0 ? 7 : 6);
  let leftMax = 0;
  let rightMax = 0;
  if (view === 'split') {
    for (const r of rows) {
      if (r.t === 'pair') {
        if (r.left !== null) {
          leftMax = Math.max(leftMax, w + 3 + stringWidth(displayText(r.left.text, ctx.showWs)));
        }
        if (r.right !== null) {
          rightMax = Math.max(rightMax, 3 + stringWidth(displayText(r.right.text, ctx.showWs)) + w);
        }
      } else if (r.t === 'note' || r.t === 'hunk' || r.t === 'cap') {
        natural = Math.max(natural, 1 + stringWidth(r.text));
      }
    }
    if (leftMax + rightMax > 0) natural = Math.max(natural, leftMax + 1 + rightMax);
    return { natural, leftMax, rightMax };
  }
  const chromeW = full ? 2 * w + 7 : 2 * w + 4;
  for (const r of rows) {
    if (r.t === 'line') {
      natural = Math.max(natural, chromeW + stringWidth(displayText(r.line.text, ctx.showWs)));
    } else if (r.t === 'note' || r.t === 'hunk' || r.t === 'cap') {
      natural = Math.max(natural, 1 + stringWidth(r.text));
    } else if (r.t === 'sep') {
      natural = Math.max(natural, 1 + stringWidth(sepText(r.skipped)));
    }
  }
  return { natural, leftMax, rightMax };
}

/**
 * Split column widths for a given inner width: when the content fits, each
 * side gets its natural width (no pointless truncation); when it doesn't, the
 * space is shared evenly. Always sums to inner − 1 (the divider column).
 */
function splitColumns(m: Measure, inner: number): { leftW: number; rightW: number } {
  if (m.leftMax + 1 + m.rightMax <= inner && m.leftMax + m.rightMax > 0) {
    const leftW = Math.max(1, m.leftMax);
    return { leftW, rightW: Math.max(1, inner - 1 - leftW) };
  }
  const leftW = Math.max(1, Math.floor((inner - 1) / 2));
  return { leftW, rightW: Math.max(1, inner - 1 - leftW) };
}

// ---------------------------------------------------------------------------
// the entry point
// ---------------------------------------------------------------------------

/**
 * Render one FileDiff to boxed rows. Pure: same inputs → same strings.
 * Width handling never throws and never emits a negative repeat; below
 * COMPACT_WIDTH the gutters compact, below MIN_SPLIT_WIDTH split falls back
 * to unified.
 */
export function renderFileDiff(diff: FileDiff, theme: Theme, opts: RenderOptions = {}): string[] {
  const width = Math.max(4, Math.floor(opts.width ?? 80));
  const maxLines = Math.max(0, Math.floor(opts.maxLines ?? 300));
  const scheme = opts.scheme ?? detectScheme(process.env);
  const pal = opts.paletteOverride ?? diffPaletteFor(opts.palette ?? 'classic', scheme, theme);
  const isMono = pal.name === 'mono';
  const ctx: RenderCtx = {
    theme,
    pal,
    isMono,
    env: { colorLevel: isMono ? 0 : theme.level, emphasis: theme.level > 0 },
    maxLines,
    syntax: opts.syntaxHighlight ?? true,
    wordDiff: opts.wordDiff ?? true,
    showWs: opts.showWhitespace ?? false,
    path: diff.change.path,
  };

  // No content difference and no mode change: one dim line, no box.
  if (diff.unchanged && diff.modeChange === undefined) {
    return [
      paintRow(
        [
          {
            text: `${diff.change.path} — no changes`,
            fg: isMono ? undefined : pal.metaFg,
            dim: true,
          },
        ],
        ctx.env,
      ),
    ];
  }

  // View resolution (auto → split when the terminal is wide enough).
  const want = opts.view ?? 'auto';
  let view: 'unified' | 'split' = 'unified';
  if (want === 'split') view = width >= MIN_SPLIT_WIDTH ? 'split' : 'unified';
  else if (want === 'auto' && width >= AUTO_SPLIT_WIDTH) view = 'split';

  const expandGenerated = opts.expandGenerated ?? false;

  // Body rows.
  let rows: BodyRow[];
  let binary: BinaryInfo | undefined;
  if ((binary = diff.binary) !== undefined) {
    const kind = diff.change.kind;
    const text =
      kind === 'created'
        ? `Binary file created (${fmtBytes(binary.newSize)})`
        : kind === 'deleted'
          ? `Binary file deleted (${fmtBytes(binary.oldSize)})`
          : `Binary file changed (${fmtBytes(binary.oldSize)} → ${fmtBytes(binary.newSize)})`;
    rows = [{ t: 'note', text }];
  } else if (diff.generated && !expandGenerated) {
    rows = [
      {
        t: 'note',
        text: `+${diff.stats.added} ${MINUS}${diff.stats.removed} (collapsed — generated/lockfile; press e to expand)`,
      },
    ];
  } else {
    rows = assembleBodyRows(diff, view);
  }
  rows = applyCap(rows, maxLines);

  // Header + box width: hug the content, never exceed the terminal.
  const showStats = diff.binary === undefined && !(diff.generated && !expandGenerated);
  const header = buildHeader(diff, ctx, showStats);
  const w = gutterDigits(diff);
  const full = width >= COMPACT_WIDTH;
  const m = measure(rows, header, view, w, full, ctx);
  const W = Math.max(4, Math.min(width, Math.max(8, m.natural + 2)));
  const inner = W - 2;
  const cols = view === 'split' ? splitColumns(m, inner) : null;

  const out: string[] = [titleRow(header, ctx, W)];
  for (const r of rows) {
    switch (r.t) {
      case 'note':
        out.push(metaRow(r.text, ctx, inner, {}));
        break;
      case 'hunk':
        out.push(metaRow(r.text, ctx, inner, { hunk: true }));
        break;
      case 'sep':
        out.push(metaRow(sepText(r.skipped), ctx, inner, { center: true }));
        break;
      case 'cap':
        out.push(metaRow(r.text, ctx, inner, {}));
        break;
      case 'line':
        out.push(unifiedLineRow(r.line, ctx, inner, w, full));
        break;
      case 'pair':
        out.push(splitPairRow(r.left, r.right, ctx, w, cols?.leftW ?? 1, cols?.rightW ?? 1));
        break;
    }
  }
  out.push(bottomRow(ctx, W));
  return out;
}
