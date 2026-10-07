/**
 * src/diff/types.ts — THE shared contract of the diff subsystem. Every other
 * module in src/diff/ imports from here; nothing here imports from anywhere
 * else in the subsystem (a leaf module, pure types + defaults).
 *
 * Model in one paragraph: a FileChange (created | modified | deleted |
 * renamed — a discriminated union on `kind`) is what an agent tool wants to
 * do. The ENGINE turns it into a FileDiff: hunks of DiffLines (add/del/ctx)
 * with word-level segments on paired lines, stats, EOL/newline/binary/
 * whitespace/mode metadata. The RENDERER turns a FileDiff into ANSI strings.
 * REVIEW collects the user's decision. SAFETY guards + atomically writes.
 * HISTORY checkpoints originals for undo/redo. Nothing in this file does I/O.
 */

// ---------------------------------------------------------------------------
// line + hunk model
// ---------------------------------------------------------------------------

/** Line role inside a hunk. ('meta' rows — elision markers — are a RENDERER concern.) */
export type DiffLineKind = 'add' | 'del' | 'ctx';

/** One word-level segment inside a paired del/add line; `changed` gets the brighter highlight. */
export interface WordSegment {
  text: string;
  changed: boolean;
}

export interface DiffLine {
  kind: DiffLineKind;
  /** 1-based line number in the OLD file for del/ctx; null for add. */
  oldNo: number | null;
  /** 1-based line number in the NEW file for add/ctx; null for del. */
  newNo: number | null;
  /** The line text WITHOUT its line terminator, EOL-normalized to LF internally. */
  text: string;
  /**
   * Word-level segmentation when this del/add line has a changed counterpart
   * on the other side (segments cover `text` exactly, in order). Absent on
   * ctx lines and on unpaired pure adds/dels.
   */
  words?: WordSegment[] | undefined;
}

export interface Hunk {
  /** 1-based start in the old file (0 when oldLines is 0 — GNU convention). */
  oldStart: number;
  oldLines: number;
  /** 1-based start in the new file (0 when newLines is 0). */
  newStart: number;
  newLines: number;
  /** Section heading shown after the second @@ (best-effort; '' when unknown). */
  header: string;
  lines: DiffLine[];
}

export interface DiffStats {
  /** Added lines (add rows across all hunks). */
  added: number;
  /** Removed lines (del rows). */
  removed: number;
  hunks: number;
}

// ---------------------------------------------------------------------------
// file changes (the discriminated union the whole subsystem keys on)
// ---------------------------------------------------------------------------

export type EolStyle = 'lf' | 'crlf' | 'mixed' | 'none';

/** Unix permission-mode change (e.g. 0o644 → 0o755), when both are known. */
export interface FileModeChange {
  from: number;
  to: number;
}

interface ChangeBase {
  /**
   * Display path, root-relative with forward slashes when inside the project
   * (the agent/paths.ts convention), absolute otherwise.
   */
  path: string;
}

export interface CreatedChange extends ChangeBase {
  kind: 'created';
  newText: string;
  newMode?: number | undefined;
}

export interface ModifiedChange extends ChangeBase {
  kind: 'modified';
  oldText: string;
  newText: string;
  oldMode?: number | undefined;
  newMode?: number | undefined;
}

export interface DeletedChange extends ChangeBase {
  kind: 'deleted';
  oldText: string;
  oldMode?: number | undefined;
}

export interface RenamedChange extends ChangeBase {
  kind: 'renamed';
  /** The pre-rename path (same display convention as `path`, which is the NEW path). */
  oldPath: string;
  oldText: string;
  newText: string;
  /** Content similarity 0..1 that justified pairing (1 = identical). */
  similarity: number;
}

/** What the agent wants to do to one file. */
export type FileChange = CreatedChange | ModifiedChange | DeletedChange | RenamedChange;

// ---------------------------------------------------------------------------
// engine result
// ---------------------------------------------------------------------------

/** Set when either side of the change looks binary (NUL bytes / non-text). */
export interface BinaryInfo {
  /** Byte size of the old content (0 when the file did not exist). */
  oldSize: number;
  /** Byte size of the new content (0 when the file is gone). */
  newSize: number;
}

/**
 * The computed diff of one FileChange. Texts embedded in `change` are the
 * source of truth; hunks are EOL-normalized (LF) views of them.
 */
export interface FileDiff {
  change: FileChange;
  hunks: Hunk[];
  stats: DiffStats;
  /** Present when binary — hunks/stats are then empty and nothing else applies. */
  binary: BinaryInfo | undefined;
  /** The OLD file's EOL style ('none' when absent/empty). */
  oldEol: EolStyle;
  /** The NEW file's EOL style — applyHunks re-encodes with this. */
  newEol: EolStyle;
  oldEndsWithNewline: boolean;
  newEndsWithNewline: boolean;
  /** Every changed line pair differs only in whitespace. */
  whitespaceOnly: boolean;
  modeChange: FileModeChange | undefined;
  /** No content difference at all (hunks empty). */
  unchanged: boolean;
  /** Lockfile/minified/generated — the renderer collapses it by default. */
  generated: boolean;
}

/** Engine knobs. All optional; defaults documented in engine.ts (context 3). */
export interface DiffOptions {
  /** Context lines kept around each change inside a hunk. Default 3. */
  context?: number | undefined;
  /** Similarity floor (0..1) for pairing a delete+create into a rename. Default 0.6. */
  renameThreshold?: number | undefined;
}

// ---------------------------------------------------------------------------
// theme + renderer
// ---------------------------------------------------------------------------

/** Built-in diff palettes. `mono` = symbols + bold/dim only (no hues). */
export type DiffPaletteName = 'classic' | 'colorblind' | 'mono';

/** Dark is the default; light is picked via COLORFGBG or config. */
export type ColorScheme = 'dark' | 'light';

/**
 * Every color the diff renderer uses, as hex. Derived from the Selora theme
 * in theme.ts — the ONLY place these are produced; nothing else hardcodes a
 * color. (mono still fills the fields; the Theme's level-0 wrap ignores them.)
 */
export interface DiffPalette {
  name: DiffPaletteName;
  scheme: ColorScheme;
  /** Line-level addition: text fg, full-width bg, gutter '+' marker fg. */
  addedFg: string;
  addedBg: string;
  addedMarker: string;
  /** Brighter bg on the exact changed tokens of an add line. */
  addedWordBg: string;
  removedFg: string;
  removedBg: string;
  removedMarker: string;
  removedWordBg: string;
  /** Context lines + old/new gutter numbers. */
  contextFg: string;
  gutterFg: string;
  /** @@ hunk headers (galaxy purple/cyan family). */
  hunkHeaderFg: string;
  /** Elision ("N unchanged lines"), caps, rename arrows. */
  metaFg: string;
  /** Box borders and the header rule. */
  borderFg: string;
  /** ⚠ secret-scan warning rows. */
  warningFg: string;
}

export type DiffView = 'unified' | 'split' | 'auto';

/** Renderer knobs (the engine already fixed the hunks). */
export interface RenderOptions {
  /** Default 'auto' → split when the width allows (≥140), else unified. */
  view?: DiffView | undefined;
  /** Terminal columns. Default 80. */
  width?: number | undefined;
  /** Cap on rendered rows per file before "… N more lines". Default 300; 0 = no cap. */
  maxLines?: number | undefined;
  /** Palette choice. Default 'classic'. */
  palette?: DiffPaletteName | undefined;
  /** Force the scheme; default = detect (COLORFGBG) then 'dark'. */
  scheme?: ColorScheme | undefined;
  /** Syntax-highlight line text by file extension. Default true. */
  syntaxHighlight?: boolean | undefined;
  /** Word-level brighter highlights on paired lines. Default true. */
  wordDiff?: boolean | undefined;
  /** Show tabs (→) and trailing spaces (·) visibly. Default false. */
  showWhitespace?: boolean | undefined;
  /** Render generated/lockfile diffs in full instead of the collapsed row. Default false. */
  expandGenerated?: boolean | undefined;
  /** Test seam: an explicit palette replaces derivation. */
  paletteOverride?: DiffPalette | undefined;
}

// ---------------------------------------------------------------------------
// review
// ---------------------------------------------------------------------------

/**
 * The permission stance for file changes. `ask` prompts per change (default);
 * `auto` applies and still prints the diff; `dry-run` prints proposed diffs
 * and writes nothing.
 */
export type ReviewMode = 'ask' | 'auto' | 'dry-run';

/** What the user decided about one presented FileDiff. */
export type ReviewDecision =
  | { action: 'apply' }
  /** Hunk-by-hunk: apply only these hunk indices (into FileDiff.hunks). */
  | { action: 'apply-hunks'; accepted: readonly number[] }
  /** Apply this change AND every remaining change in the set without asking. */
  | { action: 'apply-all' }
  | { action: 'reject'; reason: string | undefined }
  /** Abort the whole review (no further files are presented). */
  | { action: 'cancel' };

/** One row of a change-set summary table. */
export interface ChangeSetEntry {
  diff: FileDiff;
  decision?: ReviewDecision | undefined;
}

// ---------------------------------------------------------------------------
// safety
// ---------------------------------------------------------------------------

/** Typed error codes for the write path — never thrown strings. */
export type DiffErrorCode =
  | 'ENOENT'
  | 'EACCES'
  | 'EPERM'
  | 'EISDIR'
  | 'EBUSY'
  | 'ENOSPC'
  | 'EROFS'
  | 'OUTSIDE_ROOT'
  | 'CONFLICT'
  | 'PATCH_MISMATCH'
  | 'OTHER';

export interface DiffError {
  code: DiffErrorCode;
  message: string;
  /** The path involved, when there is one. */
  path?: string | undefined;
}

/** Result type for every fallible safety/history operation. */
export type SafeResult<T> = { ok: true; value: T } | { ok: false; error: DiffError };

/** A secret-looking string found on an ADDED line. */
export interface SecretFinding {
  /** Rule id, e.g. 'private-key' | 'aws-access-key' | 'api-token' | 'env-assignment'. */
  rule: string;
  /** 1-based line number in the NEW text. */
  line: number;
  /** Redacted preview (the secret itself is truncated/masked). */
  snippet: string;
}

/** A point-in-time snapshot used for conflict detection (read-before-write). */
export interface FileSnapshot {
  text: string;
  mtimeMs: number;
  /** Unix permission bits (0o666 & mask), when stat succeeded. */
  mode: number | undefined;
  eol: EolStyle;
  endsWithNewline: boolean;
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

/** One checkpoint: the state BEFORE a change was applied (plus what it became). */
export interface Checkpoint {
  /** Stable id (time-ordered sequence string). */
  id: string;
  /** ISO timestamp. */
  at: string;
  /** Absolute path on disk. */
  absPath: string;
  /** Display path (root-relative when possible). */
  displayPath: string;
  changeKind: FileChange['kind'];
  /** Full previous content; undefined when the file did not exist (a create). */
  beforeText: string | undefined;
  /** Full resulting content; undefined for a delete. */
  afterText: string | undefined;
  /** Permission bits before the change, when known. */
  mode: number | undefined;
}

export interface HistoryInfo {
  entries: number;
  /** Approximate bytes held on disk. */
  bytes: number;
  /** True once pruning has dropped old checkpoints to fit the cap. */
  pruned: boolean;
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/**
 * The resolved diff configuration (defaults + config file + CLI flags, flags
 * win). Validated at load; every field has a sane default so a resolved
 * config is always complete.
 */
export interface DiffConfig {
  view: DiffView;
  context: number;
  maxLines: number;
  palette: DiffPaletteName;
  syntaxHighlight: boolean;
  wordDiff: boolean;
  showWhitespace: boolean;
  collapseGenerated: boolean;
  secretScan: boolean;
  /** permissions.mode — the review stance. */
  reviewMode: ReviewMode;
  /** history.maxSizeMB — disk cap for .selora/history. */
  historyMaxSizeMB: number;
}

export const DEFAULT_DIFF_CONFIG: DiffConfig = {
  view: 'auto',
  context: 3,
  maxLines: 300,
  palette: 'classic',
  syntaxHighlight: true,
  wordDiff: true,
  showWhitespace: false,
  collapseGenerated: true,
  secretScan: true,
  reviewMode: 'ask',
  historyMaxSizeMB: 50,
};
