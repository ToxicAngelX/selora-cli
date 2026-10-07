/**
 * src/config/diff.ts — the DIFF subsystem's config resolution. Turns a parsed
 * ConfigFile (config/index.ts owns config.json parsing + per-field
 * warn-and-ignore) plus the CLI's diff flags into a complete DiffConfig — the
 * single object every diff module (engine / renderer / review / history)
 * reads. Nothing here does I/O.
 *
 * Precedence (lowest → highest):
 *
 *   DEFAULT_DIFF_CONFIG
 *     ← config file sections (diff.*, permissions.mode, history.maxSizeMB)
 *     ← CLI flags (flags win)
 *
 * Validation happens TWICE by design. loadConfig validates while parsing and
 * warns on stderr per bad field (the repo's "never throw on malformed config"
 * rule). resolveDiffConfig then re-validates DEFENSIVELY and SILENTLY: a
 * ConfigFile can also be built in memory by another caller, so out-of-range
 * or wrong-typed values fall back to the default for that field with no
 * warning (loadConfig already warned when the value came from disk). Invalid
 * FLAG values likewise fall back silently — commander-level validation lives
 * at the flag parsing site, not here.
 *
 * Mapping notes: permissions.mode ('ask' | 'auto' | 'dry-run') becomes
 * reviewMode; the --dry-run flag forces reviewMode 'dry-run' and beats the
 * file. history.maxSizeMB becomes historyMaxSizeMB. Every call returns a
 * FRESH object — the shared defaults are never mutated.
 */

import type { ConfigFile } from './index.js';
import type { DiffConfig, DiffPaletteName, DiffView, ReviewMode } from '../diff/types.js';
import { DEFAULT_DIFF_CONFIG } from '../diff/types.js';

/** CLI flags that map onto the diff config (all optional; strings arrive raw from commander). */
export interface DiffCliFlags {
  diffView?: string | undefined;
  diffPalette?: string | undefined;
  diffMaxLines?: number | undefined;
  diffContext?: number | undefined;
  syntaxHighlight?: boolean | undefined; // false from --no-syntax-highlight
  showWhitespace?: boolean | undefined;
  dryRun?: boolean | undefined; // maps to reviewMode 'dry-run'
}

// Field ranges — keep in sync with the loadConfig validators in index.ts.
const CONTEXT_MIN = 0;
const CONTEXT_MAX = 20;
const MAX_LINES_MIN = 0;
const MAX_LINES_MAX = 100_000;
const HISTORY_MIN_MB = 1;
const HISTORY_MAX_MB = 1024;

function asView(v: unknown): DiffView | undefined {
  return v === 'unified' || v === 'split' || v === 'auto' ? v : undefined;
}

function asPalette(v: unknown): DiffPaletteName | undefined {
  return v === 'classic' || v === 'colorblind' || v === 'mono' ? v : undefined;
}

function asReviewMode(v: unknown): ReviewMode | undefined {
  return v === 'ask' || v === 'auto' || v === 'dry-run' ? v : undefined;
}

/** Integer within [min, max], else undefined. NaN / fractional / non-number → undefined. */
function asIntInRange(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

/** Narrow an in-memory section value that TS types but a cast could still break. */
function section<T>(v: T | undefined): T | undefined {
  return typeof v === 'object' && v !== null ? v : undefined;
}

/**
 * Resolve the effective diff config: defaults ← file ← flags. Invalid values
 * at ANY layer fall back to the layer below for that field only, silently.
 * Returns a fresh object every call; DEFAULT_DIFF_CONFIG is never mutated.
 */
export function resolveDiffConfig(file: ConfigFile, flags?: DiffCliFlags): DiffConfig {
  const out: DiffConfig = { ...DEFAULT_DIFF_CONFIG };

  const d = section(file.diff);
  if (d !== undefined) {
    const view = asView(d.view);
    if (view !== undefined) out.view = view;
    const context = asIntInRange(d.context, CONTEXT_MIN, CONTEXT_MAX);
    if (context !== undefined) out.context = context;
    const maxLines = asIntInRange(d.maxLines, MAX_LINES_MIN, MAX_LINES_MAX);
    if (maxLines !== undefined) out.maxLines = maxLines;
    const palette = asPalette(d.palette);
    if (palette !== undefined) out.palette = palette;
    const syntaxHighlight = asBool(d.syntaxHighlight);
    if (syntaxHighlight !== undefined) out.syntaxHighlight = syntaxHighlight;
    const wordDiff = asBool(d.wordDiff);
    if (wordDiff !== undefined) out.wordDiff = wordDiff;
    const showWhitespace = asBool(d.showWhitespace);
    if (showWhitespace !== undefined) out.showWhitespace = showWhitespace;
    const collapseGenerated = asBool(d.collapseGenerated);
    if (collapseGenerated !== undefined) out.collapseGenerated = collapseGenerated;
    const secretScan = asBool(d.secretScan);
    if (secretScan !== undefined) out.secretScan = secretScan;
  }

  const permissions = section(file.permissions);
  if (permissions !== undefined) {
    const mode = asReviewMode(permissions.mode);
    if (mode !== undefined) out.reviewMode = mode;
  }

  const history = section(file.history);
  if (history !== undefined) {
    const maxSizeMB = asIntInRange(history.maxSizeMB, HISTORY_MIN_MB, HISTORY_MAX_MB);
    if (maxSizeMB !== undefined) out.historyMaxSizeMB = maxSizeMB;
  }

  if (flags !== undefined) {
    const view = asView(flags.diffView);
    if (view !== undefined) out.view = view;
    const palette = asPalette(flags.diffPalette);
    if (palette !== undefined) out.palette = palette;
    const maxLines = asIntInRange(flags.diffMaxLines, MAX_LINES_MIN, MAX_LINES_MAX);
    if (maxLines !== undefined) out.maxLines = maxLines;
    const context = asIntInRange(flags.diffContext, CONTEXT_MIN, CONTEXT_MAX);
    if (context !== undefined) out.context = context;
    const syntaxHighlight = asBool(flags.syntaxHighlight);
    if (syntaxHighlight !== undefined) out.syntaxHighlight = syntaxHighlight;
    const showWhitespace = asBool(flags.showWhitespace);
    if (showWhitespace !== undefined) out.showWhitespace = showWhitespace;
    // --dry-run is a hard override: it beats permissions.mode from the file.
    if (flags.dryRun === true) out.reviewMode = 'dry-run';
  }

  return out;
}
