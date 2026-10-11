import { describe, expect, it } from 'vitest';
import { GALAXY_PALETTE, MONO_PALETTE, Theme } from '../src/ui/theme.js';
import { VERSION } from '../src/version.js';
import {
  BANNER_GRADIENT,
  BLOCK_BANNER_LINES,
  colorizeBannerLines,
  DEFAULT_SUBTITLE,
  ELECTRIC_CYAN,
  NEON_VIOLET,
  renderBanner,
  renderCompactMark,
  renderHeaderBadge,
  renderVersionBadge,
  SLANT_BANNER_LINES,
} from '../src/ui/banner.js';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

describe('banner typography and constants', () => {
  it('slant typography fits within 60 columns and has 5 rows', () => {
    expect(SLANT_BANNER_LINES.length).toBe(5);
    for (const row of SLANT_BANNER_LINES) {
      expect(row.length).toBeLessThan(60);
      expect(row.includes('\x1b')).toBe(false);
    }
  });

  it('block typography fits within 60 columns and has 5 rows', () => {
    expect(BLOCK_BANNER_LINES.length).toBe(5);
    for (const row of BLOCK_BANNER_LINES) {
      expect(row.length).toBeLessThan(60);
      expect(row.includes('\x1b')).toBe(false);
    }
  });

  it('gradient stops include Neon Violet and Electric Cyan', () => {
    expect(BANNER_GRADIENT[0]).toBe(NEON_VIOLET);
    expect(BANNER_GRADIENT[BANNER_GRADIENT.length - 1]).toBe(ELECTRIC_CYAN);
  });
});

describe('renderHeaderBadge & renderVersionBadge', () => {
  it('renders bracketed version badge with theme colors', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const badge = renderHeaderBadge(theme);
    expect(badge).toContain(`v${VERSION}`);
    expect(badge).toContain('[');
    expect(badge).toContain(']');
    expect(badge).toContain('\x1b[');
  });

  it('renders plain plain text with level-0 mono theme (no ANSI)', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const badge = renderHeaderBadge(mono);
    expect(badge).toBe(`[ v${VERSION} ]`);
    expect(badge.includes('\x1b')).toBe(false);
  });

  it('formats custom version string and strips redundant v prefix', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    expect(renderHeaderBadge(mono, { version: '2.0.0' })).toBe('[ v2.0.0 ]');
    expect(renderHeaderBadge(mono, { version: 'v3.1.4' })).toBe('[ v3.1.4 ]');
  });

  it('supports plain style without brackets', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    expect(renderHeaderBadge(mono, { style: 'plain' })).toBe(`v${VERSION}`);
  });

  it('renderVersionBadge is an alias to renderHeaderBadge', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    expect(renderVersionBadge(mono)).toBe(renderHeaderBadge(mono));
  });
});

describe('renderCompactMark', () => {
  it('renders ✦ SELORA-CLI with gradient escapes in color mode', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const mark = renderCompactMark(theme);
    expect(stripAnsi(mark)).toBe('✦ SELORA-CLI');
    expect(mark).toContain('\x1b[');
  });

  it('renders clean plain text without ANSI escapes in mono mode', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const mark = renderCompactMark(mono);
    expect(mark).toBe('✦ SELORA-CLI');
    expect(mark.includes('\x1b')).toBe(false);
  });
});

describe('colorizeBannerLines', () => {
  it('retains line count and colors visible glyphs', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const colored = colorizeBannerLines(SLANT_BANNER_LINES, theme);
    expect(colored.length).toBe(SLANT_BANNER_LINES.length);
    for (let i = 0; i < colored.length; i += 1) {
      expect(stripAnsi(colored[i]!)).toBe(SLANT_BANNER_LINES[i]);
      expect(colored[i]!).toContain('\x1b[');
    }
  });

  it('leaves mono theme byte-identical and ANSI-free', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const plain = colorizeBannerLines(SLANT_BANNER_LINES, mono);
    expect(plain).toEqual(SLANT_BANNER_LINES);
    for (const row of plain) {
      expect(row.includes('\x1b')).toBe(false);
    }
  });
});

describe('renderBanner wide mode (terminal width >= 60)', () => {
  it('renders wide ASCII art, subtitle, and badge by default', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const banner = renderBanner(theme, { width: 80 });
    const plain = stripAnsi(banner);

    expect(plain).toContain(DEFAULT_SUBTITLE);
    expect(plain).toContain(`[ v${VERSION} ]`);
    expect(banner).toContain('\x1b[');

    // Verify all rows fit within 60 columns
    const lines = plain.split('\n');
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it('supports block typography style', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { width: 80, style: 'block' });
    expect(banner).toContain('██████');
    expect(banner.includes('\x1b')).toBe(false);
  });

  it('omits subtitle when showSubtitle is false', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { width: 80, showSubtitle: false });
    expect(banner).not.toContain(DEFAULT_SUBTITLE);
    expect(banner).toContain(`[ v${VERSION} ]`);
  });

  it('omits badge when showBadge is false', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { width: 80, showBadge: false });
    expect(banner).toContain(DEFAULT_SUBTITLE);
    expect(banner).not.toContain(`[ v${VERSION} ]`);
  });

  it('renders only ASCII art when showSubtitle and showBadge are false', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { width: 80, showSubtitle: false, showBadge: false });
    expect(banner).toBe(SLANT_BANNER_LINES.join('\n'));
  });

  it('preserves clean plain ASCII with mono theme (no ANSI escapes)', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { width: 80 });
    expect(banner.includes('\x1b')).toBe(false);
  });
});

describe('renderBanner compact mode (width < 60 or opts.compact: true)', () => {
  it('switches to compact mode when width < 60', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const banner = renderBanner(theme, { width: 50 });
    const plain = stripAnsi(banner);

    expect(plain).toContain('✦ SELORA-CLI');
    expect(plain).toContain(`[ v${VERSION} ]`);
    expect(plain).toContain(DEFAULT_SUBTITLE);
    expect(plain.includes('/ ___/')).toBe(false);
  });

  it('switches to compact mode when compact option is true', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const banner = renderBanner(theme, { compact: true, width: 100 });
    const plain = stripAnsi(banner);

    expect(plain).toContain('✦ SELORA-CLI');
    expect(plain.includes('/ ___/')).toBe(false);
  });

  it('compact mode omits subtitle line when showSubtitle is false', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { compact: true, showSubtitle: false });
    expect(banner).toBe(`✦ SELORA-CLI [ v${VERSION} ]`);
    expect(banner.includes('\n')).toBe(false);
  });

  it('compact mode renders with zero ANSI escapes in mono theme', () => {
    const mono = new Theme(MONO_PALETTE, 0);
    const banner = renderBanner(mono, { compact: true });
    expect(banner.includes('\x1b')).toBe(false);
    expect(banner).toContain('✦ SELORA-CLI');
  });
});

describe('renderBanner default arguments', () => {
  it('renderBanner() executes without arguments and returns valid banner', () => {
    const banner = renderBanner();
    expect(banner.length).toBeGreaterThan(0);
    expect(banner).toContain(DEFAULT_SUBTITLE);
  });

  it('renderHeaderBadge() executes without arguments', () => {
    const badge = renderHeaderBadge();
    expect(badge).toContain(`v${VERSION}`);
  });
});
