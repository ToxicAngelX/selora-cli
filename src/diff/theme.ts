/**
 * src/diff/theme.ts — the diff color layer. The ONLY place diff colors are
 * produced: every hex the renderer paints comes from a DiffPalette built
 * here, derived per palette name (classic | colorblind | mono) × color scheme
 * (dark | light). Structure colors (gutter, meta, borders, warnings) are not
 * hardcoded — they are borrowed from the active Selora Theme's palette
 * (space/violet/indigo/warning), so a /theme swap recolors the chrome of
 * every diff while the add/removed hues stay deliberate.
 *
 * The ui Theme wraps FOREGROUND hexes and degrades them per color level
 * (truecolor → 256 → 16 → plain). Diff rows additionally need BACKGROUNDS
 * (full-width added/removed row fills and the brighter word-level spans), so
 * this module mirrors the Theme's degradation math for the `48;…` family:
 * bgWrap / fgBgWrap take a raw ColorLevel and emit `48;2;r;g;b` at level 3,
 * the nearest `48;5;n` at level 2, the nearest ANSI-16 background code
 * (fg code + 10) at level 1, and PLAIN TEXT at level 0 — the renderer decides
 * what level to pass (mono palette → 0), these helpers honor what they are
 * given and nothing else. The rgb helpers (hexToRgb / rgbTo256Code /
 * rgbTo16Code) are reused from ui/theme.ts, never reimplemented.
 *
 * `mono` fills every field with grays as honest documentation of intent; the
 * renderer additionally suppresses all hues for mono and falls back to
 * bold/dim — see renderer.ts. Nothing here does I/O or throws: a malformed
 * hex simply yields the plain text.
 */

import type { ColorLevel, Theme } from '../ui/theme.js';
import { hexToRgb, rgbTo256Code, rgbTo16Code } from '../ui/theme.js';
import type { ColorScheme, DiffPalette, DiffPaletteName } from './types.js';

const CSI = '\x1b[';
const RESET = '\x1b[0m';

// ---------------------------------------------------------------------------
// scheme detection
// ---------------------------------------------------------------------------

/**
 * Resolve dark vs light from COLORFGBG ("fg;bg", sometimes more fields): the
 * LAST field is the background color index — 0-6 (dark colors) → 'dark',
 * 7 or 15 (white/bright white) → 'light'. Absent or unparseable → 'dark',
 * the Selora default.
 */
export function detectScheme(env: NodeJS.ProcessEnv): ColorScheme {
  const raw = env['COLORFGBG'];
  if (raw === undefined) return 'dark';
  const fields = raw.split(';');
  const last = fields[fields.length - 1];
  if (last === undefined) return 'dark';
  const bg = Number.parseInt(last.trim(), 10);
  if (Number.isNaN(bg)) return 'dark';
  if (bg === 7 || bg === 15) return 'light';
  return 'dark';
}

// ---------------------------------------------------------------------------
// background SGR helpers (the ui Theme only wraps foregrounds)
// ---------------------------------------------------------------------------

/**
 * The SGR parameters (without CSI/`m`) that paint `hex` as a BACKGROUND at
 * `level`: `48;2;r;g;b` truecolor, `48;5;n` xterm-256, ANSI-16 bg code at
 * level 1. '' when the color cannot be honored (level 0 / malformed hex).
 */
export function bgSgrParams(hex: string, level: ColorLevel): string {
  if (level === 0) return '';
  const rgb = hexToRgb(hex);
  if (rgb === null) return '';
  const [r, g, b] = rgb;
  if (level === 3) return `48;2;${r};${g};${b}`;
  if (level === 2) return `48;5;${rgbTo256Code(r, g, b)}`;
  // ANSI-16: background codes are the foreground code + 10 (30-37 → 40-47,
  // bright 90-97 → 100-107).
  return String(rgbTo16Code(r, g, b) + 10);
}

/** The SGR parameters for `hex` as a FOREGROUND at `level` (mirrors ui/theme's private sgrFor). */
export function fgSgrParams(hex: string, level: ColorLevel): string {
  if (level === 0) return '';
  const rgb = hexToRgb(hex);
  if (rgb === null) return '';
  const [r, g, b] = rgb;
  if (level === 3) return `38;2;${r};${g};${b}`;
  if (level === 2) return `38;5;${rgbTo256Code(r, g, b)}`;
  return String(rgbTo16Code(r, g, b));
}

/** Paint `text` with a background color. Plain text at level 0 / bad hex. */
export function bgWrap(hex: string, text: string, level: ColorLevel): string {
  if (level === 0 || text === '') return text;
  const sgr = bgSgrParams(hex, level);
  return sgr === '' ? text : `${CSI}${sgr}m${text}${RESET}`;
}

/** Paint `text` with foreground + background in one SGR sequence. Plain at level 0. */
export function fgBgWrap(fgHex: string, bgHex: string, text: string, level: ColorLevel): string {
  if (level === 0 || text === '') return text;
  const parts: string[] = [];
  const fg = fgSgrParams(fgHex, level);
  const bg = bgSgrParams(bgHex, level);
  if (fg !== '') parts.push(fg);
  if (bg !== '') parts.push(bg);
  return parts.length === 0 ? text : `${CSI}${parts.join(';')}m${text}${RESET}`;
}

// ---------------------------------------------------------------------------
// the palettes
// ---------------------------------------------------------------------------

/**
 * The per-palette fixed hues (everything except the theme-derived chrome).
 * Kept as plain data so both schemes of every palette read as one table.
 */
type CoreHues = Pick<
  DiffPalette,
  | 'addedFg'
  | 'addedBg'
  | 'addedMarker'
  | 'addedWordBg'
  | 'removedFg'
  | 'removedBg'
  | 'removedMarker'
  | 'removedWordBg'
  | 'contextFg'
  | 'hunkHeaderFg'
>;

/** classic/dark — the GitHub-dark family. */
const CLASSIC_DARK: CoreHues = {
  addedBg: '#12351f',
  addedFg: '#7ee787',
  addedMarker: '#3fb950',
  addedWordBg: '#1f6f3a',
  removedBg: '#3d1418',
  removedFg: '#ff7b72',
  removedMarker: '#f85149',
  removedWordBg: '#8e2b33',
  contextFg: '#6e7681',
  hunkHeaderFg: '#8b7cf6',
};

/** classic/light — the GitHub-light family, same roles. */
const CLASSIC_LIGHT: CoreHues = {
  addedBg: '#dafbe1',
  addedFg: '#116329',
  addedMarker: '#1a7f37',
  addedWordBg: '#aceebb',
  removedBg: '#ffebe9',
  removedFg: '#a0111f',
  removedMarker: '#cf222e',
  removedWordBg: '#ffcecb',
  contextFg: '#57606a',
  hunkHeaderFg: '#6f42c1',
};

/** colorblind/dark — blue = added, orange = removed (no red/green anywhere). */
const COLORBLIND_DARK: CoreHues = {
  addedBg: '#0c2d6b',
  addedFg: '#82aaff',
  addedMarker: '#3b82f6',
  addedWordBg: '#1d4ed8',
  removedBg: '#4a1f00',
  removedFg: '#ffa657',
  removedMarker: '#d4760a',
  removedWordBg: '#9a4e00',
  contextFg: '#6e7681',
  hunkHeaderFg: '#8b7cf6',
};

/** colorblind/light — blue = added, orange = removed. */
const COLORBLIND_LIGHT: CoreHues = {
  addedBg: '#ddf4ff',
  addedFg: '#0550ae',
  addedMarker: '#0969da',
  addedWordBg: '#b6e3ff',
  removedBg: '#fff1e5',
  removedFg: '#9a4600',
  removedMarker: '#bc4c00',
  removedWordBg: '#ffd8b5',
  contextFg: '#57606a',
  hunkHeaderFg: '#6f42c1',
};

/**
 * mono — every field a gray. These hexes are honest placeholders (a gray ramp
 * dark→light for dark scheme, inverted for light): the RENDERER suppresses
 * all hues for the mono palette and distinguishes add/del with bold/dim, so
 * in practice these are only consulted if a caller wraps with them directly.
 */
const MONO_DARK: CoreHues = {
  addedBg: '#333333',
  addedFg: '#d4d4d4',
  addedMarker: '#a3a3a3',
  addedWordBg: '#4f4f4f',
  removedBg: '#333333',
  removedFg: '#d4d4d4',
  removedMarker: '#a3a3a3',
  removedWordBg: '#4f4f4f',
  contextFg: '#8a8a8a',
  hunkHeaderFg: '#a3a3a3',
};

const MONO_LIGHT: CoreHues = {
  addedBg: '#e0e0e0',
  addedFg: '#3a3a3a',
  addedMarker: '#555555',
  addedWordBg: '#c8c8c8',
  removedBg: '#e0e0e0',
  removedFg: '#3a3a3a',
  removedMarker: '#555555',
  removedWordBg: '#c8c8c8',
  contextFg: '#6e6e6e',
  hunkHeaderFg: '#555555',
};

function coreHuesFor(name: DiffPaletteName, scheme: ColorScheme): CoreHues {
  if (name === 'colorblind') return scheme === 'light' ? COLORBLIND_LIGHT : COLORBLIND_DARK;
  if (name === 'mono') return scheme === 'light' ? MONO_LIGHT : MONO_DARK;
  return scheme === 'light' ? CLASSIC_LIGHT : CLASSIC_DARK;
}

/**
 * Build the full DiffPalette: the fixed add/remove hues for `name` × `scheme`
 * plus the chrome colors borrowed from the active Selora theme (gutter =
 * space gray, meta = violet, border = indigo, warning = warning), so a /theme
 * swap recolors the frame around every diff. For `mono` the chrome fields are
 * grays too — borrowing galaxy hues would defeat the point.
 */
export function diffPaletteFor(
  name: DiffPaletteName,
  scheme: ColorScheme,
  theme: Theme,
): DiffPalette {
  const core = coreHuesFor(name, scheme);
  if (name === 'mono') {
    const g = scheme === 'light' ? MONO_LIGHT : MONO_DARK;
    return {
      name,
      scheme,
      ...core,
      gutterFg: g.contextFg,
      metaFg: g.contextFg,
      borderFg: scheme === 'light' ? '#9a9a9a' : '#6b6b6b',
      warningFg: g.addedFg,
    };
  }
  return {
    name,
    scheme,
    ...core,
    gutterFg: theme.palette.space,
    metaFg: theme.palette.violet,
    borderFg: theme.palette.indigo,
    warningFg: theme.palette.warning,
  };
}
