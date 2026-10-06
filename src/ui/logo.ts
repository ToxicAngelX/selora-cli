/**
 * The startup screen: the SELORA block logo drifting on a twinkling star
 * field, an info box underneath, and dim tips — plus the ANIMATED intro:
 * renderStartupFrames emits K full-screen frames whose gradient sweeps across
 * the logo while stars twinkle, and renderStartupScreen is just frame K-1
 * (it delegates with frames: 1, so the static screen and the animation's
 * landing state are identical by construction — no parallel implementations
 * that could drift).
 *
 * Design decisions (the honest ones):
 * - The logo is a hand-tuned 5-row block font on a strict 7-column letter
 *   grid (49 columns total, under the 56-column cap), assembled from
 *   per-letter glyphs so a spacing edit can never shear one row out of
 *   alignment.
 * - Coloring is PER CELL, never SGR string surgery: logoScene() splits the
 *   canvas into a plain row set (logo on blank sky) plus a cell list (glyph
 *   cells + star cells, row-major), and colorScene() rebuilds each row by
 *   slicing the plain row between cells. Logo glyphs get the theme gradient
 *   at their horizontal position (with a slight down-right skew for depth);
 *   stars twinkle dim/bright on a fixed schedule per frame. The old
 *   spliceStars() (which pattern-matched escapes back out of colored rows)
 *   is gone — no escape sequence is ever parsed here.
 * - Everything is pure. The only nondeterminism is the star field and the
 *   rotating tip, both driven by an injectable rng (default Math.random).
 *   The tip pick consumes exactly ONE rng draw AFTER the stars, so a seed
 *   that produced a given star field still produces it.
 * - Stars land only on cells that are spaces in the plain canvas, so a star
 *   can never sit on a logo glyph — in any frame.
 * - A level-0 Theme makes every wrap the identity: every frame is then
 *   byte-identical and ANSI-free (the stars are still characters, which is
 *   the point).
 * - width < 60 drops the block for the one-line compact mark (a phased
 *   per-character gradient; at phase 0 byte-identical to the old static
 *   gradient). Values that do not fit the box are middle-truncated with '…'
 *   (cwd included); the box never exceeds the terminal width.
 * No regexes live in this file — string ops only.
 */

import { sampleGradient, type Theme } from './theme.js';

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

const clamp01 = (t: number): number => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Always-positive modulo (frames count DOWN to the landing frame, so n can go negative). */
const posMod = (n: number, m: number): number => ((n % m) + m) % m;

// ---------------------------------------------------------------------------
// the per-cell scene composer
// ---------------------------------------------------------------------------

type CellKind = 'glyph' | 'star';

interface CanvasCell {
  readonly row: number;
  readonly col: number;
  readonly ch: string;
  readonly kind: CellKind;
}

interface LogoScene {
  /** Plain canvas rows: the logo centered on blank sky, NO stars planted. */
  readonly rows: readonly string[];
  /** Glyph + star cells in row-major order (no two cells share a position). */
  readonly cells: readonly CanvasCell[];
  /** Canvas column where the (left-padded) logo block starts. */
  readonly logoLeft: number;
  /** Full logo row width including its left pad. */
  readonly logoWidth: number;
}

/** The gradient drifts slightly down-right across rows — subtle diagonal depth. */
const ROW_SKEW = 0.03;
/** Roughly one star in three is bright per frame; the bright set rotates. */
const TWINKLE_PERIOD = 3;

/**
 * Split the centered-logo canvas into plain rows + a cell list. The rng draw
 * pattern is exactly the old logoCanvas one (glyph walk, then scatterStars),
 * so identical seeds plant identical stars.
 */
function logoScene(width: number, rng: () => number): LogoScene {
  const logo = logoLines();
  const height = logo.length + CANVAS_MARGIN * 2;
  const logoWidth = Math.max(...logo.map((row) => row.length));
  const left = Math.max(CANVAS_MARGIN, Math.floor((width - logoWidth) / 2));
  const rows: string[] = [];
  const cells: CanvasCell[] = [];
  for (let r = 0; r < height; r += 1) {
    let row = ' '.repeat(left) + (logo[r - CANVAS_MARGIN] ?? '');
    row = row.length >= width ? row.slice(0, width) : row + ' '.repeat(width - row.length);
    rows.push(row);
    for (let c = 0; c < row.length; c += 1) {
      const ch = row[c]!;
      if (ch !== ' ') cells.push({ row: r, col: c, ch, kind: 'glyph' });
    }
  }
  for (const star of scatterStars(rows, rng)) {
    cells.push({ row: star.row, col: star.col, ch: star.ch, kind: 'star' });
  }
  // Row-major: positions are unique (stars only land where glyphs are not),
  // so (row, col) is a total order.
  cells.sort((a, b) => a.row - b.row || a.col - b.col);
  return { rows, cells, logoLeft: left, logoWidth };
}

function colorCell(
  cell: CanvasCell,
  scene: LogoScene,
  theme: Theme,
  phase: number,
  frame: number,
): string {
  if (cell.kind === 'star') {
    const bright = posMod(cell.row * 31 + cell.col * 17 + frame, TWINKLE_PERIOD) === 0;
    return bright ? theme.star(cell.ch) : theme.dim(cell.ch);
  }
  const across = (cell.col - scene.logoLeft) / Math.max(1, scene.logoWidth - 1);
  const down = (cell.row - CANVAS_MARGIN) * ROW_SKEW;
  return theme.wrap(sampleGradient(theme.palette.gradient, clamp01(across + down + phase)), cell.ch);
}

/**
 * Rebuild the canvas with colors: each row is its plain text with every cell
 * replaced by its colored glyph — spaces are never wrapped, so a level-0
 * theme yields the plain rows with bare star characters substituted in
 * (byte-identical to the pre-animation static screen).
 */
function colorScene(scene: LogoScene, theme: Theme, phase: number, frame: number): string[] {
  const perRow: CanvasCell[][] = scene.rows.map(() => []);
  for (const cell of scene.cells) perRow[cell.row]!.push(cell);
  return scene.rows.map((row, r) => {
    const cells = perRow[r]!;
    let out = '';
    let cursor = 0;
    for (const cell of cells) {
      out += row.slice(cursor, cell.col) + colorCell(cell, scene, theme, phase, frame);
      cursor = cell.col + 1;
    }
    return out + row.slice(cursor);
  });
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

/**
 * The two pinned tips every launch shows (tests pin them), then ONE rotating
 * tip picked per launch — kiro-style variety without layout drift: the tips
 * block is always exactly three lines.
 */
const PINNED_TIPS: readonly string[] = ['/help for commands', '/exit ends the session'];
const TIP_POOL: readonly string[] = [
  'Ctrl+C to stop a reply',
  '/model switches models mid-chat',
  '/theme repaints the UI',
  'selora run "<task>" for one-shot jobs',
  '/cost shows token spend',
];

/** Pinned tips + one pool pick. Consumes exactly one rng draw. */
function pickTips(rng: () => number): readonly string[] {
  const extra = TIP_POOL[Math.min(TIP_POOL.length - 1, Math.floor(rng() * TIP_POOL.length))]!;
  return [...PINNED_TIPS, extra];
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

/** Everything below the canvas band: blank, box, blank, tips. One tip-pick draw. */
function screenTail(info: StartupInfo, theme: Theme, width: number, rng: () => number): string[] {
  return [
    '',
    ...infoBoxLines(info, theme, width),
    '',
    ...pickTips(rng).map((tip) => theme.dim(middleTruncate(tip, width))),
  ];
}

/** theme.gradient with a phase offset — at phase 0, byte-identical to it. */
function gradientChars(theme: Theme, text: string, phase: number): string {
  if (theme.level === 0 || text === '') return text;
  const chars = Array.from(text); // code points — never split a surrogate pair
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch.trim() === '') {
      out += ch;
      continue;
    }
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    out += theme.wrap(sampleGradient(theme.palette.gradient, clamp01(t + phase)), ch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// the animated intro
// ---------------------------------------------------------------------------

/** 9 frames × 70ms ≈ 0.63s — the intro stays well under one second. */
export const STARTUP_FRAME_COUNT = 9;
/** The gradient travels 45% of its width over the intro (cubic ease-out). */
const STARTUP_SWEEP = 0.45;
const MAX_FRAMES = 32;

export interface StartupFramesOpts {
  width?: number;
  rng?: () => number;
  /** Frame count (default STARTUP_FRAME_COUNT), clamped to [1, 32]. */
  frames?: number;
}

/**
 * The startup screen as K full-screen frames (the caller plays them with a
 * small interval). Only the canvas band animates — the gradient phase sweeps
 * in from -STARTUP_SWEEP and lands exactly on 0 for the last frame (cubic
 * ease-out), and the star twinkle schedule rotates each frame. The info box
 * and tips are colored once and shared, so EVERY frame has the same row
 * count (the player redraws in place and depends on it).
 *
 * Frame K-1 is the static screen; renderStartupScreen is frames:1, so the
 * two can never disagree. At level 0 every frame is byte-identical.
 */
export function renderStartupFrames(
  info: StartupInfo,
  theme: Theme,
  opts: StartupFramesOpts = {},
): string[][] {
  const width = opts.width ?? DEFAULT_WIDTH;
  const rng = opts.rng ?? Math.random;
  const count = Math.max(1, Math.min(MAX_FRAMES, Math.floor(opts.frames ?? STARTUP_FRAME_COUNT)));
  const phase = (k: number): number =>
    count <= 1 ? 0 : -STARTUP_SWEEP * Math.pow(1 - k / (count - 1), 3);

  if (width >= MIN_BLOCK_WIDTH) {
    const scene = logoScene(width, rng); // stars consume their rng draws first…
    const tail = screenTail(info, theme, width, rng); // …then the tip pick
    // The frame index counts DOWN to 0 for the last frame, so the landing
    // frame always has twinkle position 0 — identical to the static screen.
    return Array.from({ length: count }, (_, k) => [
      ...colorScene(scene, theme, phase(k), k - (count - 1)),
      ...tail,
    ]);
  }
  const line = middleTruncate(compactLogoLine(), width);
  const tail = screenTail(info, theme, width, rng);
  return Array.from({ length: count }, (_, k) => [gradientChars(theme, line, phase(k)), ...tail]);
}

/**
 * The complete startup screen as an array of lines (caller prints them) —
 * the animation's final frame: block logo + star field when width ≥ 60, else
 * the compact gradient mark; then a blank row, the info box, a blank row,
 * and dim tips. No line is ever longer than `width` (visible columns). With
 * a level-0 theme the output contains no ANSI escapes at all.
 */
export function renderStartupScreen(
  info: StartupInfo,
  theme: Theme,
  opts: { width?: number; rng?: () => number } = {},
): string[] {
  return renderStartupFrames(info, theme, { ...opts, frames: 1 })[0]!;
}
