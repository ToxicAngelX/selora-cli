/**
 * The "Galaxy" theme layer (v0.3). Truecolor palettes with honest fallbacks:
 * the color LEVEL is detected once (NO_COLOR / TERM=dumb / non-TTY → 0,
 * truecolor signals → 3, 256color → 2, else basic 16) and every wrap degrades
 * to the nearest xterm-256 cube/gray color, then to the nearest ANSI-16 color.
 * Level 0 and the mono theme wrap to plain text — no escapes ever.
 *
 * Gradient: interpolated per character (or per line) across the palette's
 * stops (galaxy: cyan → indigo → violet → magenta). Whitespace is never
 * colored — gradient escapes land on visible glyphs only.
 *
 * All functions are pure; the only env/TTY reads happen in colorLevelFor()
 * and themeFor(), which take injectable inputs so tests stay hermetic. Nothing
 * here throws — a malformed hex degrades to the plain text.
 */

export type ThemeName = 'galaxy' | 'nebula' | 'aurora' | 'mono';

/** 0 = no color, 1 = basic 16, 2 = xterm 256, 3 = truecolor. */
export type ColorLevel = 0 | 1 | 2 | 3;

export interface Palette {
  readonly name: ThemeName;
  /** Dim space gray — secondary text. */
  readonly space: string;
  /** Star white — primary text. */
  readonly star: string;
  readonly cyan: string;
  readonly indigo: string;
  readonly violet: string;
  readonly magenta: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  /** Gradient stops (hex), left to right. */
  readonly gradient: readonly string[];
}

export const THEME_NAMES: readonly ThemeName[] = ['galaxy', 'nebula', 'aurora', 'mono'];

export const GALAXY_PALETTE: Palette = {
  name: 'galaxy',
  space: '#6b7280',
  star: '#e0e7ff',
  cyan: '#22d3ee',
  indigo: '#6366f1',
  violet: '#a855f7',
  magenta: '#ec4899',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#fb7185',
  gradient: ['#22d3ee', '#6366f1', '#a855f7', '#ec4899'],
};

/** nebula — the warm sibling: magenta → pink → orange → amber. */
export const NEBULA_PALETTE: Palette = {
  name: 'nebula',
  space: '#6b7280',
  star: '#ffe4e6',
  cyan: '#fb923c', // orange
  indigo: '#f43f5e', // rose
  violet: '#f472b6', // pink
  magenta: '#ec4899',
  success: '#34d399',
  warning: '#fbbf24',
  error: '#fb7185',
  gradient: ['#ec4899', '#f472b6', '#fb923c', '#fbbf24'],
};

/** aurora — the cool sibling: emerald → teal → cyan → sky. */
export const AURORA_PALETTE: Palette = {
  name: 'aurora',
  space: '#6b7280',
  star: '#ecfdf5',
  cyan: '#22d3ee',
  indigo: '#38bdf8', // sky
  violet: '#2dd4bf', // teal
  magenta: '#34d399', // emerald
  success: '#34d399',
  warning: '#fbbf24',
  error: '#fb7185',
  gradient: ['#34d399', '#2dd4bf', '#22d3ee', '#38bdf8'],
};

/** mono — deliberately colorless; every wrap is the identity. */
export const MONO_PALETTE: Palette = {
  name: 'mono',
  space: '#6b7280',
  star: '#e0e7ff',
  cyan: '#6b7280',
  indigo: '#6b7280',
  violet: '#6b7280',
  magenta: '#6b7280',
  success: '#6b7280',
  warning: '#6b7280',
  error: '#6b7280',
  gradient: ['#6b7280'],
};

export function paletteFor(name: string | undefined): Palette {
  if (name === 'nebula') return NEBULA_PALETTE;
  if (name === 'aurora') return AURORA_PALETTE;
  if (name === 'mono') return MONO_PALETTE;
  return GALAXY_PALETTE; // unknown/absent → galaxy (the default)
}

/** Is `name` one of the four real themes? */
export function isThemeName(name: string): name is ThemeName {
  return (THEME_NAMES as readonly string[]).includes(name);
}

// ---------------------------------------------------------------------------
// color level detection
// ---------------------------------------------------------------------------

/**
 * Detect the color level for a stream. FORCE_COLOR (any non-'0' value) forces
 * color even on a non-TTY (CI logs — the chalk convention: '3' → truecolor,
 * '2' → 256, anything else truthy → basic 16; '0'/'false' → 0). Otherwise
 * NO_COLOR (any value), TERM=dumb, or a non-TTY stream are level 0 — no
 * escapes, ever. Truecolor signals (COLORTERM, 24bit, truecolor, kitty,
 * Windows Terminal's WT_SESSION) are 3; TERM*xterm-256color* is 2; a plain
 * TTY is 1 (conservative).
 */
export function colorLevelFor(isTTY: boolean, env: NodeJS.ProcessEnv = process.env): ColorLevel {
  const force = env['FORCE_COLOR'];
  if (force !== undefined) {
    if (force === '0' || force === 'false') return 0;
    if (force === '2') return 2;
    if (force === '3') return 3;
    return 1;
  }
  if (env['NO_COLOR'] !== undefined) return 0;
  if (!isTTY) return 0;
  const term = env['TERM'] ?? '';
  if (term === 'dumb') return 0;
  const colorterm = (env['COLORTERM'] ?? '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 3;
  if (term.includes('truecolor') || term.includes('24bit')) return 3;
  if (term === 'xterm-kitty') return 3;
  if (env['WT_SESSION'] !== undefined) return 3; // Windows Terminal
  if (term.includes('256color')) return 2;
  return 1;
}

// ---------------------------------------------------------------------------
// hex → rgb → fallback codes
// ---------------------------------------------------------------------------

/** '#22d3ee' → [34, 211, 238]. Returns null for malformed input. */
export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (m === null) return null;
  const n = Number.parseInt(m[1]!, 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/** The 6×6×6 cube levels (index 0..5 → component value). */
const CUBE_LEVELS = [0, 95, 135, 175, 215, 255];

/** The 24 grayscale ramp values (xterm 232..255). */
const GRAY_LEVELS: readonly number[] = Array.from({ length: 24 }, (_, i) => 8 + i * 10);

function distance(r: number, g: number, b: number, r2: number, g2: number, b2: number): number {
  const dr = r - r2;
  const dg = g - g2;
  const db = b - b2;
  return dr * dr + dg * dg + db * db;
}

/** Nearest xterm-256 foreground color index (16..231 cube, 232..255 grays). */
export function rgbTo256Code(r: number, g: number, b: number): number {
  let best = 16;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let ri = 0; ri < 6; ri += 1) {
    for (let gi = 0; gi < 6; gi += 1) {
      for (let bi = 0; bi < 6; bi += 1) {
        const code = 16 + ri * 36 + gi * 6 + bi;
        const d = distance(r, g, b, CUBE_LEVELS[ri]!, CUBE_LEVELS[gi]!, CUBE_LEVELS[bi]!);
        if (d < bestDist) {
          bestDist = d;
          best = code;
        }
      }
    }
  }
  for (let i = 0; i < GRAY_LEVELS.length; i += 1) {
    const gray = GRAY_LEVELS[i]!;
    const d = distance(r, g, b, gray, gray, gray);
    if (d < bestDist) {
      bestDist = d;
      best = 232 + i;
    }
  }
  return best;
}

/** The 16 base ANSI colors (xterm defaults) as [code, r, g, b]. */
const ANSI16: ReadonlyArray<readonly [number, number, number, number]> = [
  [30, 0, 0, 0], // black
  [31, 205, 0, 0], // red
  [32, 0, 205, 0], // green
  [33, 205, 205, 0], // yellow
  [34, 0, 0, 238], // blue
  [35, 205, 0, 205], // magenta
  [36, 0, 205, 205], // cyan
  [37, 229, 229, 229], // white
  [90, 127, 127, 127], // bright black
  [91, 255, 0, 0], // bright red
  [92, 0, 255, 0], // bright green
  [93, 255, 255, 0], // bright yellow
  [94, 92, 92, 255], // bright blue
  [95, 255, 0, 255], // bright magenta
  [96, 0, 255, 255], // bright cyan
  [97, 255, 255, 255], // bright white
];

/** Nearest base-16 ANSI foreground code (30-37 / 90-97). */
export function rgbTo16Code(r: number, g: number, b: number): number {
  let best = 37;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const [code, r2, g2, b2] of ANSI16) {
    const d = distance(r, g, b, r2, g2, b2);
    if (d < bestDist) {
      bestDist = d;
      best = code;
    }
  }
  return best;
}

/** The SGR parameters (without CSI/`m`) that color `hex` at `level`. '' when the color cannot be honored. */
function sgrFor(hex: string, level: ColorLevel): string {
  if (level === 0) return '';
  const rgb = hexToRgb(hex);
  if (rgb === null) return '';
  const [r, g, b] = rgb;
  if (level === 3) return `38;2;${r};${g};${b}`;
  if (level === 2) return `38;5;${rgbTo256Code(r, g, b)}`;
  return String(rgbTo16Code(r, g, b));
}

// ---------------------------------------------------------------------------
// gradient
// ---------------------------------------------------------------------------

/** Linear interpolation of `t` ∈ [0,1] across the hex stops → a hex color. */
export function sampleGradient(stops: readonly string[], t: number): string {
  if (stops.length === 0) return '';
  if (stops.length === 1) return stops[0]!;
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const scaled = clamped * (stops.length - 1);
  const i = Math.min(Math.floor(scaled), stops.length - 2);
  const u = scaled - i;
  const a = hexToRgb(stops[i]!);
  const b = hexToRgb(stops[i + 1]!);
  if (a === null || b === null) return stops[i]!;
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * u);
  const to2 = (n: number): string => n.toString(16).padStart(2, '0');
  return `#${to2(mix(a[0], b[0]))}${to2(mix(a[1], b[1]))}${to2(mix(a[2], b[2]))}`;
}

// ---------------------------------------------------------------------------
// the Theme
// ---------------------------------------------------------------------------

export interface WrapOptions {
  bold?: boolean;
}

const RESET = '\x1b[0m';
const CSI = '\x1b[';

/**
 * A palette + color level pair. `wrap` is the single coloring chokepoint: it
 * returns plain text whenever color is off (level 0) or the palette is mono,
 * so every UI built on a Theme is automatically NO_COLOR/non-TTY clean.
 */
export class Theme {
  readonly palette: Palette;
  readonly level: ColorLevel;

  constructor(palette: Palette, level: ColorLevel) {
    this.palette = palette;
    this.level = palette.name === 'mono' ? 0 : level;
  }

  get enabled(): boolean {
    return this.level !== 0;
  }

  /** Color (and optionally bold) `text`. Plain text when color is off. */
  wrap(hex: string, text: string, opts: WrapOptions = {}): string {
    if (text === '') return '';
    const sgr = sgrFor(hex, this.level);
    if (sgr === '') return text;
    const params = opts.bold === true ? `1;${sgr}` : sgr;
    return `${CSI}${params}m${text}${RESET}`;
  }

  /** Bold text in the default foreground. */
  bold(text: string): string {
    if (this.level === 0 || text === '') return text;
    return `${CSI}1m${text}${RESET}`;
  }

  dim(text: string): string {
    return this.wrap(this.palette.space, text);
  }

  star(text: string): string {
    return this.wrap(this.palette.star, text);
  }

  cyan(text: string): string {
    return this.wrap(this.palette.cyan, text);
  }

  indigo(text: string): string {
    return this.wrap(this.palette.indigo, text);
  }

  violet(text: string): string {
    return this.wrap(this.palette.violet, text);
  }

  magenta(text: string): string {
    return this.wrap(this.palette.magenta, text);
  }

  success(text: string): string {
    return this.wrap(this.palette.success, text);
  }

  warning(text: string): string {
    return this.wrap(this.palette.warning, text);
  }

  error(text: string): string {
    return this.wrap(this.palette.error, text);
  }

  /** One line colored at gradient position `i` of `total` (0-based). */
  gradientAt(text: string, i: number, total: number): string {
    if (this.level === 0 || text === '') return text;
    const t = total <= 1 ? 0 : i / (total - 1);
    return this.wrap(sampleGradient(this.palette.gradient, t), text);
  }

  /** Per-character gradient across the whole text. Whitespace stays plain. */
  gradient(text: string): string {
    if (this.level === 0 || text === '') return text;
    const chars = Array.from(text); // code points — never split a surrogate pair
    if (chars.length === 0) return text;
    let out = '';
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]!;
      if (ch.trim() === '') {
        out += ch;
        continue;
      }
      const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
      out += this.wrap(sampleGradient(this.palette.gradient, t), ch);
    }
    return out;
  }

  /** Per-line gradient — each line colored at its position in the block. */
  gradientLines(lines: readonly string[]): string {
    if (this.level === 0 || lines.length === 0) return lines.join('\n');
    return lines.map((l, i) => this.gradientAt(l, i, lines.length)).join('\n');
  }
}

/** Build a Theme from a name + TTY flag (env injectable for tests). */
export function themeFor(
  name: string | undefined,
  isTTY: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Theme {
  return new Theme(paletteFor(name), colorLevelFor(isTTY, env));
}
