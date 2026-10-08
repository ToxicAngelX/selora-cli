/**
 * src/ui/filediff.ts — the Claude-Code-style FLAT renderer for file-change
 * tool results (write_file / edit_file / remove). This replaces the boxed
 * panel (╭─ ✚ Created … +N −M ─╮) in the transcript: no frame chrome, a
 * right-aligned line-number gutter on the LEFT, +/-/space markers, and a
 * full-row green/red background on added/removed lines:
 *
 *   ● Write(src/foo.ts)                       (the header — chatui.ts)
 *     ⎿  Wrote 12 lines to src/foo.ts
 *    1 + import { x } from './x';
 *    2 + …
 *     … +2 lines (ctrl+r to expand)
 *
 *   ● Update(src/foo.ts)
 *     ⎿  Updated src/foo.ts with 1 addition and 1 removal
 *    9   const before = 1;
 *   10 - const gone = 2;
 *   10 + const here = 3;
 *    11   const after = 4;
 *       ...
 *
 * Design rules:
 *  - Removed rows carry OLD-file line numbers, added/context rows NEW-file
 *    numbers (one gutter, never two).
 *  - The diff is a real Myers line diff (diff/engine.ts → ui/diff.ts), never
 *    string-replace guessing; context is 3 lines around each change and
 *    non-adjacent hunks are separated by a single dim '...' row.
 *  - Add/del row backgrounds span the FULL row width (minus one column of
    wrap safety); context rows have no background. Gutter numbers sit dim on
 *    the row's background.
 *  - Color level 0 (NO_COLOR / non-TTY / mono THEME): zero escapes — plain
 *    +/- markers and the gutter carry everything, and rows are NOT padded
 *    with trailing spaces (clean copy/paste and logs).
 *  - File text is sanitized (ANSI/control bytes stripped) and truncated by
 *    display width; a row never wraps — wrapping would break the gutter.
 *  - Long creates/deletes preview the first ~10 lines and elide the rest
 *    ('  … +N lines (ctrl+r to expand)'); renderFileChangeRows with
 *    expanded: true is the ctrl+r view. Eliding a single leftover line
 *    shows it instead — elision must save rows, not spend them.
 *
 * Pure module: no I/O; the only ambient read is the documented default
 * scheme detection (same convention as diff/renderer.ts) and tests always
 * pass `scheme` explicitly.
 */

import { computeFileDiff } from '../diff/engine.js';
import { detectScheme, diffPaletteFor, bgSgrParams, fgSgrParams } from '../diff/theme.js';
import type { ColorScheme, DiffPalette, DiffPaletteName, FileChange } from '../diff/types.js';
import { sanitizeTerminalText, terminalTextWidth, truncateTerminalText } from './terminal-text.js';
import type { ColorLevel, Theme } from './theme.js';

/** The diff payload every file tool result carries (mirrors ToolResult['diff']). */
export interface FileChangePayload {
  before: string;
  after: string;
  path?: string | undefined;
  kind?: 'created' | 'modified' | 'deleted' | undefined;
}

export interface FlatDiffOptions {
  /** Terminal columns. Default 80. */
  width?: number | undefined;
  /** Context lines kept around each change. Default 3. */
  context?: number | undefined;
  /** Diff palette. Default 'classic'. */
  palette?: DiffPaletteName | undefined;
  /** Force the color scheme; default = detect (COLORFGBG) then 'dark'. */
  scheme?: ColorScheme | undefined;
  /** Append '(ctrl+r to expand)' to elision rows. Default false. */
  expandHint?: boolean | undefined;
  /** Preview lines for created/deleted content before elision. Default 10. */
  previewLines?: number | undefined;
  /** Cap on edit body rows before '… N more lines'. Default 200; 0 = no cap. */
  maxRows?: number | undefined;
  /** Render everything (the ctrl+r view): no preview cap, no row cap. */
  expanded?: boolean | undefined;
}

export interface FlatDiffRender {
  /** Body rows, ready to print (gutter included, no header/result line). */
  rows: string[];
  /** True when a fuller view exists (ctrl+r has something to show). */
  expandable: boolean;
}

/** Lines shown of a freshly created/deleted file before the '… +N lines' row. */
const PREVIEW_LINES = 10;
/** Body-row cap for edits — a full-file rewrite must not flood the transcript. */
const MAX_EDIT_ROWS = 200;

const MINUS = '-';

// ---------------------------------------------------------------------------
// row model + painting
// ---------------------------------------------------------------------------

type FlatRow =
  | { t: 'line'; no: number | null; kind: 'add' | 'del' | 'ctx'; text: string }
  /** Non-adjacent hunks separator — the dim '...' row. */
  | { t: 'sep' }
  /** Dim elision note, already composed ('… +N lines (ctrl+r to expand)'). */
  | { t: 'note'; text: string };

interface PaintSeg {
  text: string;
  fg?: string | undefined;
  bg?: string | undefined;
  bold?: boolean | undefined;
  dim?: boolean | undefined;
}

const CSI = '\x1b[';
const RESET = '\x1b[0m';

/**
 * Paint one row of segments. SGR state is TRACKED across segments: a
 * transition resets and restates the wanted attributes, so a dim gutter
 * never leaks dim onto the marker/code that follow it (SGR 2 would otherwise
 * persist until the row-end reset). Zero escapes at color level 0.
 */
function paintRow(segs: readonly PaintSeg[], level: ColorLevel, emphasis: boolean): string {
  let out = '';
  // Current terminal state: '' = default fg/bg, false = intensity normal.
  let curFg = '';
  let curBg = '';
  let curBold = false;
  let curDim = false;
  for (const seg of segs) {
    if (seg.text === '') continue;
    const wantFg = level > 0 && seg.fg !== undefined ? fgSgrParams(seg.fg, level) : '';
    const wantBg = level > 0 && seg.bg !== undefined ? bgSgrParams(seg.bg, level) : '';
    const wantBold = emphasis && seg.bold === true;
    const wantDim = emphasis && seg.dim === true;
    if (wantFg !== curFg || wantBg !== curBg || wantBold !== curBold || wantDim !== curDim) {
      const parts: string[] = [];
      if (wantBold) parts.push('1');
      if (wantDim) parts.push('2');
      if (wantFg !== '') parts.push(wantFg);
      if (wantBg !== '') parts.push(wantBg);
      out += RESET;
      if (parts.length > 0) out += `${CSI}${parts.join(';')}m`;
      curFg = wantFg;
      curBg = wantBg;
      curBold = wantBold;
      curDim = wantDim;
    }
    out += seg.text;
  }
  if (curFg !== '' || curBg !== '' || curBold || curDim) out += RESET;
  return out;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/** ui/diff semantics: 'a\nb\n' → ['a','b'] (trailing newline terminates). */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const parts = text.split('\n');
  if (text.endsWith('\n')) parts.pop();
  return parts;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function resolvedKind(p: FileChangePayload): 'created' | 'modified' | 'deleted' {
  if (p.kind !== undefined) return p.kind;
  if (p.before === '' && p.after !== '') return 'created';
  if (p.after === '' && p.before !== '') return 'deleted';
  return 'modified';
}

function displayPath(p: FileChangePayload): string {
  return p.path ?? 'file';
}

// ---------------------------------------------------------------------------
// the public result line (⎿ text — no mark, no color)
// ---------------------------------------------------------------------------

/**
 * The Claude-Code-style result line for a file-change tool result:
 * 'Wrote 182 lines to path' · 'Updated path with 3 additions and 1 removal'
 * · 'Deleted path'. Returns undefined for a payload with no displayable
 * change (binary, or identical before/after) — the caller then falls back to
 * the tool's own summary.
 */
export function fileChangeResultLine(p: FileChangePayload): string | undefined {
  const kind = resolvedKind(p);
  const path = displayPath(p);
  if (kind === 'created') return `Wrote ${plural(splitLines(p.after).length, 'line')} to ${path}`;
  if (kind === 'deleted') return `Deleted ${path}`;
  if (p.before === p.after) return undefined; // no-op overwrite — the tool summary says more
  const diff = computeFileDiff(
    { kind: 'modified', path, oldText: p.before, newText: p.after },
    { context: 3 },
  );
  if (diff.binary !== undefined || diff.unchanged) return undefined;
  return `Updated ${path} with ${plural(diff.stats.added, 'addition')} and ${plural(diff.stats.removed, 'removal')}`;
}

// ---------------------------------------------------------------------------
// row painting
// ---------------------------------------------------------------------------

interface PaintCtx {
  pal: DiffPalette;
  isMono: boolean;
  level: ColorLevel;
  emphasis: boolean;
}

function paintCtxFor(theme: Theme, pal: DiffPalette): PaintCtx {
  const isMono = pal.name === 'mono';
  return { pal, isMono, level: isMono ? 0 : theme.level, emphasis: theme.level > 0 };
}

/** One numbered code row: '<no> <marker> <code>', full-width bg on add/del. */
function paintLineRow(row: { no: number | null; kind: 'add' | 'del' | 'ctx'; text: string }, w: number, width: number, c: PaintCtx): string {
  const pal = c.pal;
  const isAdd = row.kind === 'add';
  const isDel = row.kind === 'del';
  const bg = c.level > 0 ? (isAdd ? pal.addedBg : isDel ? pal.removedBg : undefined) : undefined;
  const baseFg = isAdd ? pal.addedFg : isDel ? pal.removedFg : pal.contextFg;
  const marker = isAdd ? '+' : isDel ? MINUS : ' ';
  const markerFg = isAdd ? pal.addedMarker : isDel ? pal.removedMarker : undefined;
  // mono: no hues — bold the change markers, dim the deletion text instead.
  const markerBold = c.isMono && (isAdd || isDel);
  const codeDim = c.isMono && isDel;

  const gutter = row.no === null ? ' '.repeat(w) : String(row.no).padStart(w);
  const codeBudget = Math.max(0, width - (w + 3));
  const code = truncateTerminalText(sanitizeTerminalText(row.text), codeBudget);

  const segs: PaintSeg[] = [];
  if (bg !== undefined) {
    segs.push({ text: gutter, fg: pal.gutterFg, bg, dim: true });
    segs.push({ text: ' ', bg });
    segs.push({ text: marker, fg: markerFg, bg, bold: markerBold });
    segs.push({ text: ' ', bg });
    segs.push({ text: code, fg: baseFg, bg, dim: codeDim });
    const used = w + 3 + terminalTextWidth(code);
    const pad = Math.max(0, width - used);
    if (pad > 0) segs.push({ text: ' '.repeat(pad), bg });
  } else {
    const dimText = codeDim || row.kind === 'ctx';
    segs.push({ text: gutter, fg: pal.gutterFg, dim: true });
    segs.push({ text: ' ' });
    segs.push({ text: marker, fg: markerFg, bold: markerBold });
    segs.push({ text: ' ' });
    segs.push({ text: code, fg: baseFg, dim: dimText });
  }
  return paintRow(segs, c.level, c.emphasis);
}

/** The dim '...' between hunks: dots sit on the marker column. */
function paintSepRow(w: number, c: PaintCtx): string {
  return paintRow(
    [{ text: `${' '.repeat(w + 1)}...`, fg: c.pal.contextFg, dim: true }],
    c.level,
    c.emphasis,
  );
}

/** An elision note row ('  … +N lines (ctrl+r to expand)'), dim, indented. */
function paintNoteRow(text: string, c: PaintCtx): string {
  return paintRow([{ text: `  ${text}`, fg: c.pal.contextFg, dim: true }], c.level, c.emphasis);
}

/** Elision text for a capped create/delete preview or an over-cap edit. */
function elisionText(hidden: number, sign: '+' | '-' | '', expandHint: boolean): string {
  const hint = expandHint ? ' (ctrl+r to expand)' : '';
  return sign === '' ? `… ${plural(hidden, 'more line')}${hint}` : `… ${sign}${plural(hidden, 'line')}${hint}`;
}

// ---------------------------------------------------------------------------
// the builders
// ---------------------------------------------------------------------------

/**
 * Created/deleted body: every line a '+'/'-' row; collapsed to the first
 * `previewLines` when long. A single hidden line is shown — eliding it would
 * cost the row it saves.
 */
function previewRows(
  text: string,
  kind: 'add' | 'del',
  opts: { previewLines: number; expandHint: boolean; expanded: boolean },
): { rows: FlatRow[]; expandable: boolean } {
  const lines = splitLines(text);
  const expanded = opts.expanded === true;
  const cap = Math.max(1, opts.previewLines);
  const showAll = expanded || lines.length <= cap + 1;
  const shown = showAll ? lines : lines.slice(0, cap);
  const rows: FlatRow[] = shown.map((text, i) => ({
    t: 'line',
    no: i + 1,
    kind,
    text,
  }));
  const hidden = lines.length - shown.length;
  if (hidden > 0) {
    rows.push({ t: 'note', text: elisionText(hidden, kind === 'add' ? '+' : '-', opts.expandHint) });
  }
  return { rows, expandable: hidden > 0 };
}

/** Edit body: engine hunks, '...' between them, capped at maxRows line rows. */
function editRows(
  before: string,
  after: string,
  path: string,
  opts: { context: number; maxRows: number; expandHint: boolean; expanded: boolean },
): { rows: FlatRow[]; expandable: boolean } | undefined {
  const diff = computeFileDiff(
    { kind: 'modified', path, oldText: before, newText: after },
    { context: opts.context },
  );
  if (diff.binary !== undefined || diff.unchanged) return undefined;

  const expanded = opts.expanded === true;
  const cap = Math.max(0, opts.maxRows);
  const rows: FlatRow[] = [];
  let emitted = 0; // line rows emitted
  let remaining = 0; // line rows dropped by the cap
  let capped = false;
  diff.hunks.forEach((hunk, hi) => {
    const lineRows = hunk.lines.length;
    if (!expanded && cap > 0 && emitted + lineRows > cap) {
      capped = true;
      remaining += lineRows;
      return;
    }
    if (capped) {
      remaining += lineRows;
      return;
    }
    if (hi > 0) rows.push({ t: 'sep' });
    for (const line of hunk.lines) {
      rows.push({
        t: 'line',
        no: line.kind === 'del' ? line.oldNo : line.newNo,
        kind: line.kind,
        text: line.text,
      });
      emitted += 1;
    }
  });
  if (remaining > 0) {
    rows.push({ t: 'note', text: elisionText(remaining, '', opts.expandHint) });
  }
  return { rows, expandable: remaining > 0 };
}

// ---------------------------------------------------------------------------
// the entry points
// ---------------------------------------------------------------------------

interface ResolvedOpts {
  width: number;
  context: number;
  palette: DiffPaletteName;
  scheme: ColorScheme | undefined;
  expandHint: boolean;
  previewLines: number;
  maxRows: number;
  expanded: boolean;
}

function resolveOpts(opts: FlatDiffOptions): ResolvedOpts {
  return {
    width: Math.max(8, Math.floor(opts.width ?? 80)),
    context: Math.max(0, Math.floor(opts.context ?? 3)),
    palette: opts.palette ?? 'classic',
    scheme: opts.scheme,
    expandHint: opts.expandHint ?? false,
    previewLines: Math.max(1, Math.floor(opts.previewLines ?? PREVIEW_LINES)),
    maxRows: Math.max(0, Math.floor(opts.maxRows ?? MAX_EDIT_ROWS)),
    expanded: opts.expanded ?? false,
  };
}

/**
 * Render the diff body rows for a file-change payload. Returns undefined
 * when there is nothing displayable (binary content, or an edit whose
 * before/after are identical) — the caller falls back to the summary line.
 */
export function renderFileChangeRows(
  payload: FileChangePayload,
  theme: Theme,
  opts: FlatDiffOptions = {},
): FlatDiffRender | undefined {
  const o = resolveOpts(opts);
  const scheme = o.scheme ?? detectScheme(process.env);
  const pal = diffPaletteFor(o.palette, scheme, theme);
  const c = paintCtxFor(theme, pal);
  const kind = resolvedKind(payload);
  const path = displayPath(payload);

  let built: { rows: FlatRow[]; expandable: boolean } | undefined;
  if (kind === 'created') {
    if (splitLines(payload.after).length === 0) return undefined; // empty write: summary suffices
    built = previewRows(payload.after, 'add', o);
  } else if (kind === 'deleted') {
    if (splitLines(payload.before).length === 0) return undefined;
    built = previewRows(payload.before, 'del', o);
  } else {
    built = editRows(payload.before, payload.after, path, o);
  }
  if (built === undefined || built.rows.length === 0) return undefined;

  // Gutter width = widest line number actually shown.
  let w = 1;
  for (const r of built.rows) {
    if (r.t === 'line' && r.no !== null) w = Math.max(w, String(r.no).length);
  }
  const rows = built.rows.map((r): string => {
    if (r.t === 'sep') return paintSepRow(w, c);
    if (r.t === 'note') return paintNoteRow(r.text, c);
    return paintLineRow(r, w, o.width, c);
  });
  return { rows, expandable: built.expandable };
}

export interface FileChangeToolRender {
  /** The ⎿ result line text (plain — the caller adds mark + color). */
  result: string;
  rows: string[];
  expandable: boolean;
}

/**
 * The full display for a successful file-change tool result: the result line
 * plus the flat body rows. Undefined when there is nothing diff-worthy to
 * show (binary or no-op) — fall back to the tool's summary then.
 */
export function renderFileChangeToolResult(
  payload: FileChangePayload,
  theme: Theme,
  opts: FlatDiffOptions = {},
): FileChangeToolRender | undefined {
  const result = fileChangeResultLine(payload);
  if (result === undefined) return undefined;
  const body = renderFileChangeRows(payload, theme, opts);
  const kind = resolvedKind(payload);
  // A create/delete with empty content has a result line but no body.
  if (body === undefined) {
    if (kind === 'modified') return undefined;
    return { result, rows: [], expandable: false };
  }
  return { result, rows: body.rows, expandable: body.expandable };
}

/** Re-exported so callers can build FileChanges without importing engine types. */
export type { FileChange };
