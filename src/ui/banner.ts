/**
 * Modern ASCII art branding and header system for the Selora CLI.
 *
 * Provides:
 * - High-precision modern slant and block ASCII art typography.
 * - Responsive rendering: wide mode (terminal width >= 60) and sleek compact
 *   mode (width < 60, e.g. `✦ SELORA-CLI [ v1.5.0 ]`).
 * - Cyberpunk/neon gradient from Neon Violet (`#a855f7`) to Electric Cyan (`#22d3ee`).
 * - Compact version badge (`[ v1.5.0 ]`) and subtitle line.
 * - Strict NO_COLOR and mono theme support (clean plain ASCII without ANSI escapes).
 */

import { sampleGradient, Theme, themeFor } from './theme.js';
import { VERSION } from '../version.js';

// ---------------------------------------------------------------------------
// Constants & Color Palette
// ---------------------------------------------------------------------------

/** Neon Violet / Purple start stop. */
export const NEON_VIOLET = '#a855f7';

/** Electric Indigo mid stop for smooth cosmic interpolation. */
export const ELECTRIC_INDIGO = '#6366f1';

/** Electric Cyan / Teal end stop. */
export const ELECTRIC_CYAN = '#22d3ee';

/** Default gradient stops: Neon Violet -> Electric Indigo -> Electric Cyan. */
export const BANNER_GRADIENT: readonly string[] = [NEON_VIOLET, ELECTRIC_INDIGO, ELECTRIC_CYAN];

/** Default subtitle for the CLI branding. */
export const DEFAULT_SUBTITLE = 'Open-source AI Gateway & Agent CLI';

/** Minimum width in columns for wide ASCII art banner mode. */
export const MIN_WIDE_WIDTH = 60;

/** Default terminal column fallback when stdout size is unavailable. */
const DEFAULT_TERMINAL_COLUMNS = 80;

// ---------------------------------------------------------------------------
// ASCII Art Typography
// ---------------------------------------------------------------------------

/**
 * Modern slant ASCII art for "SELORA".
 * 5 rows, 41 columns wide. Fits cleanly within any terminal >= 60 columns.
 */
export const SLANT_BANNER_LINES: readonly string[] = [
  '   _____ ______ __    ____  ____     ___ ',
  '  / ___// ____// /   / __ \\/ __ \\   /   |',
  '  \\__ \\/ __/  / /   / / / / /_/ /  / /| |',
  ' ___/ / /___ / /___/ /_/ / _, _/  / ___ |',
  '/____/_____//_____/\\____/_/ |_|  /_/  |_|',
];

/**
 * Modern block/futuristic ASCII art for "SELORA".
 * 5 rows, 50 columns wide.
 */
export const BLOCK_BANNER_LINES: readonly string[] = [
  '  ██████ ███████ ██       ██████  ██████   █████  ',
  '  ██     ██      ██      ██    ██ ██   ██ ██   ██ ',
  '  ██████ █████   ██      ██    ██ ██████  ███████ ',
  '      ██ ██      ██      ██    ██ ██   ██ ██   ██ ',
  '  ██████ ███████ ███████  ██████  ██   ██ ██   ██ ',
];

// ---------------------------------------------------------------------------
// Types & Options
// ---------------------------------------------------------------------------

export type BannerTypographyStyle = 'slant' | 'block';

export interface RenderBannerOptions {
  /**
   * If true, force compact mode (e.g. `✦ SELORA-CLI [ v1.5.0 ]`).
   * If false, force wide ASCII art mode.
   * If undefined, auto-detects based on `width` (or terminal columns):
   * width < 60 -> compact mode, width >= 60 -> wide mode.
   */
  compact?: boolean;

  /**
   * Whether to display the subtitle underneath the banner.
   * Defaults to true.
   */
  showSubtitle?: boolean;

  /**
   * Whether to display the version badge.
   * Defaults to true.
   */
  showBadge?: boolean;

  /**
   * Custom version string to display. Defaults to package VERSION.
   */
  version?: string;

  /**
   * Custom subtitle string. Defaults to DEFAULT_SUBTITLE.
   */
  subtitle?: string;

  /**
   * Terminal width to use for auto-detecting compact mode.
   * Defaults to process.stdout.columns or 80.
   */
  width?: number;

  /**
   * Typography style for wide mode: 'slant' (default) or 'block'.
   */
  style?: BannerTypographyStyle;

  /**
   * Custom gradient stops (hex codes).
   * Defaults to BANNER_GRADIENT ([NEON_VIOLET, ELECTRIC_INDIGO, ELECTRIC_CYAN]).
   */
  gradientStops?: readonly string[];
}

export interface HeaderBadgeOptions {
  /**
   * Version string to format. Defaults to package VERSION.
   */
  version?: string;

  /**
   * Format style: 'bracket' (e.g. `[ v1.5.0 ]`) or 'plain' (e.g. `v1.5.0`).
   * Defaults to 'bracket'.
   */
  style?: 'bracket' | 'plain';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Get a safe default theme respecting NO_COLOR and TTY detection. */
function resolveTheme(theme?: Theme): Theme {
  if (theme !== undefined) return theme;
  const isTTY = typeof process !== 'undefined' && Boolean(process.stdout?.isTTY);
  return themeFor(undefined, isTTY);
}

/** Normalize version string so it always starts with 'v'. */
function formatVersionString(version?: string): string {
  const ver = (version ?? VERSION).trim();
  return ver.startsWith('v') ? ver : `v${ver}`;
}

/**
 * Apply per-character horizontal gradient to a single line of text.
 * Whitespace is never colored so that ANSI resets are minimal and clean.
 */
function gradientText(
  text: string,
  theme: Theme,
  stops: readonly string[],
  opts: { bold?: boolean; totalWidth?: number; offset?: number } = {},
): string {
  if (theme.level === 0 || theme.palette.name === 'mono' || text === '') {
    return text;
  }
  const chars = Array.from(text);
  const total = opts.totalWidth ?? chars.length;
  const offset = opts.offset ?? 0;
  let out = '';

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch === ' ') {
      out += ' ';
      continue;
    }
    const colIndex = offset + i;
    const t = total <= 1 ? 0 : Math.max(0, Math.min(1, colIndex / (total - 1)));
    const hex = sampleGradient(stops, t);
    out += theme.wrap(hex, ch, opts.bold ? { bold: true } : {});
  }

  return out;
}

/**
 * Colorize multiline ASCII art with a smooth left-to-right horizontal gradient.
 * When theme is mono or level 0, returns identical plain text lines.
 */
export function colorizeBannerLines(
  lines: readonly string[],
  theme: Theme,
  stops: readonly string[] = BANNER_GRADIENT,
): string[] {
  if (theme.level === 0 || theme.palette.name === 'mono' || lines.length === 0) {
    return [...lines];
  }
  const maxLen = Math.max(...lines.map((l) => l.length));
  return lines.map((line) => gradientText(line, theme, stops, { totalWidth: maxLen }));
}

// ---------------------------------------------------------------------------
// Public Render Functions
// ---------------------------------------------------------------------------

/**
 * Render a compact version badge in electric cyan / violet.
 *
 * Example:
 * - Color: `[ v1.5.0 ]` with brackets in `#a855f7` and version in `#22d3ee`
 * - Mono / NO_COLOR: `[ v1.5.0 ]` without ANSI escape codes
 */
export function renderHeaderBadge(theme?: Theme, opts?: HeaderBadgeOptions): string {
  const t = resolveTheme(theme);
  const vStr = formatVersionString(opts?.version);

  if (opts?.style === 'plain') {
    return t.wrap(ELECTRIC_CYAN, vStr, { bold: true });
  }

  const openBracket = t.wrap(NEON_VIOLET, '[');
  const versionText = t.wrap(ELECTRIC_CYAN, vStr, { bold: true });
  const closeBracket = t.wrap(NEON_VIOLET, ']');

  return `${openBracket} ${versionText} ${closeBracket}`;
}

/** Alias for renderHeaderBadge. */
export const renderVersionBadge = renderHeaderBadge;

/**
 * Render the sleek compact brand mark: `✦ SELORA-CLI`.
 * Gradient flows from Neon Violet to Electric Cyan across the text.
 */
export function renderCompactMark(
  theme?: Theme,
  stops: readonly string[] = BANNER_GRADIENT,
): string {
  const t = resolveTheme(theme);
  if (t.level === 0 || t.palette.name === 'mono') {
    return '✦ SELORA-CLI';
  }
  const star = t.wrap(stops[0] ?? NEON_VIOLET, '✦');
  const markText = gradientText('SELORA-CLI', t, stops, { bold: true });
  return `${star} ${markText}`;
}

/**
 * Render the complete SELORA banner.
 *
 * Supports:
 * - Wide mode (width >= 60): High-precision modern block or slant ASCII art
 *   with horizontal gradient, followed by the version badge and subtitle.
 * - Compact mode (width < 60, or opts.compact: true): Sleek one/two-line header:
 *   `✦ SELORA-CLI [ v1.5.0 ]`
 *   `  Open-source AI Gateway & Agent CLI`
 * - NO_COLOR and mono themes: Produces clean plain ASCII text without any ANSI escapes.
 */
export function renderBanner(theme?: Theme, opts: RenderBannerOptions = {}): string {
  const t = resolveTheme(theme);
  const terminalCols =
    opts.width ??
    (typeof process !== 'undefined' && process.stdout?.columns
      ? process.stdout.columns
      : DEFAULT_TERMINAL_COLUMNS);

  const isCompact = opts.compact ?? terminalCols < MIN_WIDE_WIDTH;
  const showSubtitle = opts.showSubtitle ?? true;
  const showBadge = opts.showBadge ?? true;
  const subtitle = opts.subtitle ?? DEFAULT_SUBTITLE;
  const stops = opts.gradientStops ?? BANNER_GRADIENT;
  const badge = renderHeaderBadge(t, opts.version !== undefined ? { version: opts.version } : {});

  if (isCompact) {
    const mark = renderCompactMark(t, stops);
    const headerLine = showBadge ? `${mark} ${badge}` : mark;
    if (!showSubtitle) {
      return headerLine;
    }
    const subtitleLine = `  ${t.dim(subtitle)}`;
    return `${headerLine}\n${subtitleLine}`;
  }

  // Wide mode ASCII art
  const rawLines = opts.style === 'block' ? BLOCK_BANNER_LINES : SLANT_BANNER_LINES;
  const coloredLines = colorizeBannerLines(rawLines, t, stops);
  const bannerArt = coloredLines.join('\n');

  if (!showSubtitle && !showBadge) {
    return bannerArt;
  }

  const metaParts: string[] = [];
  if (showSubtitle) {
    metaParts.push(t.dim(subtitle));
  }
  if (showBadge) {
    metaParts.push(badge);
  }

  const metaLine = `   ${metaParts.join('  ')}`;
  return `${bannerArt}\n\n${metaLine}`;
}
