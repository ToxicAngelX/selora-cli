/**
 * src/diff/index.ts — the public API of the diff subsystem. One import site
 * for the integration layer (commands/chat.ts, commands/run.ts) and for the
 * demo. Everything here is documented in its own module:
 *   types.ts     the shared contract (FileChange union, FileDiff, …)
 *   engine.ts    pure diff computation, hunk apply, unified-patch export
 *   theme.ts     palettes (classic/colorblind/mono × dark/light)
 *   highlight.ts the zero-dep syntax tokenizer
 *   renderer.ts  FileDiff → ANSI strings (unified + split)
 *   safety.ts    path guard, snapshots/conflicts, atomic write, secret scan
 *   history.ts   checkpoints, undo/redo (.selora/history)
 *   review.ts    the interactive approve/reject flow
 */

export type {
  DiffLineKind,
  WordSegment,
  DiffLine,
  Hunk,
  DiffStats,
  EolStyle,
  FileModeChange,
  FileChange,
  CreatedChange,
  ModifiedChange,
  DeletedChange,
  RenamedChange,
  BinaryInfo,
  FileDiff,
  DiffOptions,
  DiffPaletteName,
  ColorScheme,
  DiffPalette,
  DiffView,
  RenderOptions,
  ReviewMode,
  ReviewDecision,
  ChangeSetEntry,
  DiffErrorCode,
  DiffError,
  SafeResult,
  SecretFinding,
  FileSnapshot,
  Checkpoint,
  HistoryInfo,
  DiffConfig,
} from './types.js';
export { DEFAULT_DIFF_CONFIG } from './types.js';

export {
  computeFileDiff,
  applyHunks,
  toUnifiedPatch,
  pairRenames,
  detectEol,
  isBinaryText,
  isBinaryData,
  isGeneratedPath,
  similarity,
} from './engine.js';

export { diffPaletteFor, detectScheme } from './theme.js';

export { highlightLine } from './highlight.js';
export type { HighlightRole, HighlightSegment } from './highlight.js';

export { renderFileDiff } from './renderer.js';

export {
  guardPath,
  readSnapshot,
  SnapshotTracker,
  atomicWriteFile,
  detectEolOf,
  scanSecrets,
} from './safety.js';

export { DiffHistory } from './history.js';

export { reviewChange, renderChangeSetSummary, parseReviewKey } from './review.js';
export type { ReviewIo, ReviewRequest, ReviewOptions, ReviewKey } from './review.js';

// The Theme engine the renderer consumes — re-exported so programmatic users
// (and the demo) can construct one without reaching into the bundle internals.
export { Theme, themeFor, paletteFor, GALAXY_PALETTE } from '../ui/theme.js';
export type { ThemeName, ColorLevel, Palette } from '../ui/theme.js';
