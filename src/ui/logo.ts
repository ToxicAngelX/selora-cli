/**
 * The startup screen: the SELORA block logo drifting on a sparse star field,
 * an info box underneath, and dim tips. Pure layout — the caller prints the
 * returned lines.
 *
 * Design decisions (the honest ones):
 * - The logo is a hand-tuned 5-row block font on a strict 7-column letter
 *   grid (49 columns total, under the 56-column cap). It is assembled from
 *   per-letter glyphs rather than pasted as literal rows, so a spacing edit
 *   can never shear one row out of alignment. The draft block in the ticket
 *   had inconsistent row widths; these letters are the same shapes re-spaced.
 * - Everything here is pure. The only nondeterminism is the star field, and
 *   it is injectable: renderStartupScreen takes opts.rng (default
 *   Math.random — different stars every launch) and starFieldCanvas demands
 *   one outright, so tests drive it with seeded generators.
 * - Stars land only on cells that are spaces in the PLAIN canvas, so a star
 *   can never sit on a logo glyph. starFieldCanvas is the plain-in primitive
 *   (dim-colored stars, the given text untouched); renderStartupScreen
 *   colors the logo first — theme.gradientLines, per-line gradient — and
 *   then splices stars into the colored rows, re-emitting the row's SGR
 *   after each star's reset so glyphs after a star keep their color.
 * - A level-0 Theme makes every wrap the identity, so the whole screen is
 *   ANSI-free there; the stars are still characters, which is the point.
 * - width < 60 drops the block for the one-line compact mark. Values that
 *   do not fit the box are middle-truncated with '…' (cwd included, long
 *   paths are the common case); the box never exceeds the terminal width.
 * No regexes live in this file, so no escape sequence is ever pattern-
 * matched — string ops only.
 */

import type { Theme } from './theme.js';

// ---------------------------------------------------------------------------
// the logo
// ---------------------------------------------------------------------------

/** 7-column × 5-row block glyphs for the letters of "selora". */
const FONT: Readonly<Record<'s' | 'e' | 'l' | 'o' | 'r' | 'a', readonly string[]>> = {
  s: [' ██████', '██     ', ' ██████', '     ██', '██████ '],
  e: ['███████', '██     ', '██████ ', '██     ', '███████'],
  l: ['██     ', '██     ', '██     ', '██     ', '███████'],
  o: [' █████ ', '██   ██', '██   ██', '██   ██', ' █████ '],
  r: ['██████ ', '██   ██', '██████ ', '██  ██ ', '██   ██'],
  a: ['  ███  ', ' ██ ██ ', '███████', '██   ██', '██   ██'],
};

const WORD: readonly (keyof typeof FONT)[] = ['s', 'e', 'l', 'o', 'r', 'a'];

/** Two leading spaces so the block does not hug the terminal edge. */
const LOGO_LEFT_PAD = 2;
const LOGO_ROWS = 5;

/** The plain block-letter logo (no colors). 5 rows, 49 columns. */
export function logoLines(): string[] {
  return Array.from(
    { length: LOGO_ROWS },
    (_, r) => ' '.repeat(LOGO_LEFT_PAD) + WORD.map((letter) => FONT[letter][r]!).join(' '),
  );
}

/** The one-line fallback mark for narrow terminals. */
export function compactLogoLine(): string {
  return '✦ selora';
}

export interface StartupInfo {
  readonly version: string;
  readonly model: string;
  readonly cwd: string;
  readonly plan: string;
}

// ---------------------------------------------------------------------------
// the star field
// ---------------------------------------------------------------------------

const STARS: readonly string[] = ['✦', '·', '˚', '⋆', '*'];
/** ~4% of the empty cells get a star. */
const STAR_DENSITY = 0.04;
/** Blank rows above/below the logo, and the minimum column margin beside it. */
const CANVAS_MARGIN = 2;

interface StarCell {
  readonly row: number;
  readonly col: number;
  readonly ch: string;
}

/**
 * Normalize `lines` onto a width × height canvas: rows past `height` are
 * dropped, short rows are space-padded, long rows are trimmed. Non-positive
 * dimensions collapse to an empty (or all-blank) canvas instead of throwing.
 */
function canvasRows(lines: readonly string[], width: number, height: number): string[] {
  const w = Math.max(0, width);
  const h = Math.max(0, height);
  const rows: string[] = [];
  for (let r = 0; r < h; r += 1) {
    const line = lines[r] ?? '';
    const trimmed = line.length > w ? line.slice(0, w) : line;
    rows.push(trimmed + ' '.repeat(w - trimmed.length));
  }
  return rows;
}

/**
 * Decide the star cells for a plain canvas: every space cell rolls the rng
 * once; a roll under the density plants a star whose glyph is picked from
 * the same roll (v/density maps [0, density) onto the star list). Only
 * space cells consume rng draws, so the output is a pure function of
 * (rows, rng).
 */
function scatterStars(rows: readonly string[], rng: () => number): StarCell[] {
  const cells: StarCell[] = [];
  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r]!;
    for (let c = 0; c < row.length; c += 1) {
      if (row[c] !== ' ') continue;
      const v = rng();
      if (v < STAR_DENSITY) {
        const idx = Math.min(STARS.length - 1, Math.floor((v / STAR_DENSITY) * STARS.length));
        cells.push({ row: r, col: c, ch: STARS[idx]! });
      }
    }
  }
  return cells;
}

/**
 * Scatter dim-colored stars over a plain-text canvas. Stars land ONLY on
 * cells that are spaces (or outside the given text); the given glyphs are
 * never touched. Every returned line is padded/trimmed to exactly `width`
 * visible columns — `dim` may add escapes around stars, which do not count
 * as columns. Input is expected plain; ANSI in the input would be treated
 * as content (and mangled by trimming), so pass uncolored lines. Columns
 * are UTF-16 units, which is exact for the BMP-only text this is built for.
 */
export function starFieldCanvas(
  lines: readonly string[],
  width: number,
  height: number,
  rng: () => number,
  dim: (s: string) => string,
): string[] {
  const rows = canvasRows(lines, width, height);
  const cells = rows.map((row) => row.split(''));
  for (const star of scatterStars(rows, rng)) {
    cells[star.row]![star.col] = dim(star.ch);
  }
  return cells.map((row) => row.join(''));
}

// ---------------------------------------------------------------------------
// text fitting
// ---------------------------------------------------------------------------

/** Middle-truncate `s` to `limit` visible characters using '…'. */
function middleTruncate(s: string, limit: number): string {
  const max = Math.max(0, limit);
  if (s.length <= max) return s;
  if (max === 0) return '';
  if (max === 1) return '…';
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return s.slice(0, head) + '…' + s.slice(s.length - tail);
}

// ---------------------------------------------------------------------------
// the startup screen
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 80;
/** Below this the block logo is dropped for the compact mark. */
const MIN_BLOCK_WIDTH = 60;
const BOX_OVERHEAD = 4; // '│ ' + ' │'
const LABEL_WIDTH = 7; // 'version' is the longest field label
const FIELDS: readonly (keyof StartupInfo)[] = ['version', 'model', 'cwd', 'plan'];
const TIPS: readonly string[] = [
  '/help for commands',
  'Ctrl+C to stop a reply',
  '/exit ends the session',
];

/**
 * The logo band: the plain block centered on a star canvas (≥2 rows of sky
 * above and below, ≥2 columns of margin), then colored per line with
 * theme.gradientLines, then the stars spliced in.
 */
function logoCanvas(width: number, theme: Theme, rng: () => number): string[] {
  const logo = logoLines();
  const height = logo.length + CANVAS_MARGIN * 2;
  const logoWidth = Math.max(...logo.map((row) => row.length));
  const left = Math.max(CANVAS_MARGIN, Math.floor((width - logoWidth) / 2));
  const plain: string[] = [];
  for (let r = 0; r < height; r += 1) {
    let row = ' '.repeat(left) + (logo[r - CANVAS_MARGIN] ?? '');
    row = row.length >= width ? row.slice(0, width) : row + ' '.repeat(width - row.length);
    plain.push(row);
  }
  const stars = scatterStars(plain, rng);
  const colored = theme.gradientLines(plain).split('\n');
  for (let r = 0; r < colored.length; r += 1) {
    const rowStars = stars.filter((star) => star.row === r);
    if (rowStars.length > 0) {
      colored[r] = spliceStars(colored[r]!, rowStars, (ch) => theme.dim(ch));
    }
  }
  return colored;
}

/**
 * Replace the spaces at the stars' plain columns in one row produced by
 * theme.gradientLines — i.e. `[SGR]plain[reset]`, or bare plain text at
 * level 0. All stars of a row must be applied in a single pass: splicing
 * them one at a time would shift the column arithmetic once earlier stars
 * have planted escapes inside the body. Each star's own reset would kill
 * the row color, so the SGR is re-emitted after every star; at level 0 both
 * affixes are empty and this is a plain one-for-one cell swap.
 */
function spliceStars(row: string, stars: readonly StarCell[], dim: (ch: string) => string): string {
  let prefix = '';
  let body = row;
  let suffix = '';
  if (row.startsWith('\x1b[')) {
    const sgrEnd = row.indexOf('m'); // SGR params are digits and ';' only
    if (sgrEnd !== -1) {
      prefix = row.slice(0, sgrEnd + 1);
      body = row.slice(sgrEnd + 1);
    }
  }
  if (body.endsWith('\x1b[0m')) {
    suffix = '\x1b[0m';
    body = body.slice(0, -4);
  }
  const ordered = [...stars].sort((a, b) => a.col - b.col);
  let out = prefix;
  let cursor = 0;
  for (const star of ordered) {
    out += body.slice(cursor, star.col) + dim(star.ch) + prefix;
    cursor = star.col + 1;
  }
  return out + body.slice(cursor) + suffix;
}

/**
 * The rounded info box: one dim-bordered row per field (label dim, value
 * theme.star), wide enough for the longest line but never wider than the
 * terminal. Overlong values are middle-truncated with '…'.
 */
function infoBoxLines(info: StartupInfo, theme: Theme, width: number): string[] {
  const maxContent = Math.max(0, width - BOX_OVERHEAD);
  const contents = FIELDS.map((field) => {
    const label = field.padEnd(LABEL_WIDTH);
    const valueMax = maxContent - LABEL_WIDTH - 2; // label + two-space gap
    const value = middleTruncate(info[field], valueMax);
    const plain = `${label}  ${value}`;
    if (plain.length > maxContent) {
      // Ultra-narrow: even the padded label does not fit — clip whole, dim.
      const clipped = middleTruncate(plain, maxContent);
      return { plain: clipped, colored: theme.dim(clipped) };
    }
    return { plain, colored: `${theme.dim(label)}  ${theme.star(value)}` };
  });
  const contentWidth = Math.min(
    contents.reduce((w, c) => Math.max(w, c.plain.length), 0),
    maxContent,
  );
  const bar = '─'.repeat(contentWidth + 2);
  const rows = contents.map((c) => {
    const pad = ' '.repeat(Math.max(0, contentWidth - c.plain.length));
    return `${theme.dim('│')} ${c.colored}${pad} ${theme.dim('│')}`;
  });
  return [theme.dim(`╭${bar}╮`), ...rows, theme.dim(`╰${bar}╯`)];
}

/**
 * The complete startup screen as an array of lines (caller prints them).
 * Block logo + star field when width ≥ 60, else the compact gradient mark;
 * then a blank row, the info box, a blank row, and dim tips. No line is
 * ever longer than `width` (visible columns). With a level-0 theme the
 * output contains no ANSI escapes at all.
 */
export function renderStartupScreen(
  info: StartupInfo,
  theme: Theme,
  opts: { width?: number; rng?: () => number } = {},
): string[] {
  const width = opts.width ?? DEFAULT_WIDTH;
  const rng = opts.rng ?? Math.random;
  const lines: string[] = [];
  if (width >= MIN_BLOCK_WIDTH) {
    lines.push(...logoCanvas(width, theme, rng));
  } else {
    lines.push(theme.gradient(middleTruncate(compactLogoLine(), width)));
  }
  lines.push(''); // one blank row between the logo and the box
  lines.push(...infoBoxLines(info, theme, width));
  lines.push('');
  lines.push(...TIPS.map((tip) => theme.dim(middleTruncate(tip, width))));
  return lines;
}
