/**
 * Theme layer tests: color level detection (NO_COLOR, dumb, non-TTY,
 * truecolor signals, 256color), the 256/16 fallback mappings for known
 * colors, gradient sampling and per-char/per-line gradients, mono/no-color
 * identity wrapping, and the `selora theme` command behavior (show/set/
 * invalid + persistence in config.json).
 */

import { describe, expect, it } from 'vitest';
import {
  AURORA_PALETTE,
  colorLevelFor,
  hexToRgb,
  isThemeName,
  paletteFor,
  rgbTo16Code,
  rgbTo256Code,
  sampleGradient,
  Theme,
  themeFor,
  THEME_NAMES,
  GALAXY_PALETTE,
} from '../src/ui/theme.js';
import { capturedIo, cleanup, freshEnv, type TempEnv } from './helpers/env.js';
import { loadConfig, saveConfig } from '../src/config/index.js';
import { runTheme } from '../src/commands/theme.js';
import type { CliContext, CliIo } from '../src/context.js';

describe('color level detection', () => {
  it('NO_COLOR, TERM=dumb, and non-TTY are level 0 — no escapes ever', () => {
    expect(colorLevelFor(true, { NO_COLOR: '1', TERM: 'xterm-256color' })).toBe(0);
    expect(colorLevelFor(true, { TERM: 'dumb' })).toBe(0);
    expect(colorLevelFor(false, { TERM: 'xterm-256color' })).toBe(0);
  });

  it('truecolor signals are level 3; 256color is 2; a plain TTY is 1', () => {
    expect(colorLevelFor(true, { COLORTERM: 'truecolor', TERM: 'xterm' })).toBe(3);
    expect(colorLevelFor(true, { COLORTERM: '24bit', TERM: 'xterm' })).toBe(3);
    expect(colorLevelFor(true, { TERM: 'xterm-256color' })).toBe(2);
    expect(colorLevelFor(true, { TERM: 'screen-256color' })).toBe(2);
    expect(colorLevelFor(true, { TERM: 'xterm' })).toBe(1);
    expect(colorLevelFor(true, { TERM: 'xterm-kitty' })).toBe(3);
    expect(colorLevelFor(true, { TERM: 'xterm', WT_SESSION: 'some-guid' })).toBe(3);
  });
});

describe('hex and fallback conversions', () => {
  it('hexToRgb parses 6-digit hex (with or without #); malformed → null', () => {
    expect(hexToRgb('#22d3ee')).toEqual([34, 211, 238]);
    expect(hexToRgb('22d3ee')).toEqual([34, 211, 238]);
    expect(hexToRgb('#22d3')).toBeNull();
    expect(hexToRgb('nope')).toBeNull();
  });

  it('rgbTo256Code: exact cube and gray matches map to themselves', () => {
    // 16 + 3*6 + 3 = cube slot for (0,175,175) — cube levels are [0,95,135,175,215,255]
    expect(rgbTo256Code(0, 175, 175)).toBe(37);
    // gray 128 = gray ramp index (128-8)/10 = 12 → 232+12 = 244
    expect(rgbTo256Code(128, 128, 128)).toBe(244);
    // pure primaries hit the cube corners
    expect(rgbTo256Code(255, 0, 0)).toBe(196);
    expect(rgbTo256Code(0, 0, 0)).toBe(16);
    expect(rgbTo256Code(255, 255, 255)).toBe(231);
  });

  it('rgbTo16Code: primaries map to their ANSI codes', () => {
    expect(rgbTo16Code(0, 0, 0)).toBe(30);
    expect(rgbTo16Code(205, 0, 0)).toBe(31);
    expect(rgbTo16Code(0, 205, 0)).toBe(32);
    expect(rgbTo16Code(0, 0, 238)).toBe(34);
    expect(rgbTo16Code(255, 0, 0)).toBe(91);
    expect(rgbTo16Code(250, 250, 250)).toBe(97);
  });
});

describe('gradient', () => {
  it('sampleGradient interpolates stops and clamps t', () => {
    // single stop is constant
    expect(sampleGradient(['#123456'], 0.7)).toBe('#123456');
    // t=0 and t=1 are the endpoints
    expect(sampleGradient(GALAXY_PALETTE.gradient, 0)).toBe('#22d3ee');
    expect(sampleGradient(GALAXY_PALETTE.gradient, 1)).toBe('#ec4899');
    // clamping outside [0,1]
    expect(sampleGradient(['#000000', '#ffffff'], -1)).toBe('#000000');
    expect(sampleGradient(['#000000', '#ffffff'], 2)).toBe('#ffffff');
    // midpoint of a two-stop ramp
    expect(sampleGradient(['#000000', '#ffffff'], 0.5)).toBe('#808080');
  });

  it('per-char gradient colors visible glyphs and leaves whitespace plain', () => {
    const t = new Theme(GALAXY_PALETTE, 3);
    const out = t.gradient('a b');
    // first char = first stop; the space sits between two colored runs
    expect(out).toContain('\x1b[38;2;34;211;238ma');
    // the space sits bare between two colored runs
    expect(out).toContain('\x1b[0m \x1b[38;2;');
    // exactly two colored glyphs (a and b), the space is bare
    expect(out.split('\x1b[38;2;').length - 1).toBe(2);
    // level 0: identity
    expect(new Theme(GALAXY_PALETTE, 0).gradient('a b')).toBe('a b');
  });

  it('gradientAt positions lines across the ramp', () => {
    const t = new Theme(GALAXY_PALETTE, 3);
    const first = t.gradientAt('x', 0, 2);
    const last = t.gradientAt('x', 1, 2);
    expect(first).toContain('38;2;34;211;238'); // cyan
    expect(last).toContain('38;2;236;72;153'); // magenta
    // a single line still gets the first stop, not a bare string
    expect(t.gradientAt('x', 0, 1)).toContain('38;2;34;211;238');
  });

  it('gradientLines joins per-line colors', () => {
    const t = new Theme(GALAXY_PALETTE, 0);
    expect(t.gradientLines(['a', 'b'])).toBe('a\nb');
  });
});

describe('Theme wrapping', () => {
  it('level 3 emits truecolor escapes; bold is combined into one SGR', () => {
    const t = new Theme(GALAXY_PALETTE, 3);
    expect(t.cyan('x')).toBe('\x1b[38;2;34;211;238mx\x1b[0m');
    expect(t.wrap('#22d3ee', 'x', { bold: true })).toBe('\x1b[1;38;2;34;211;238mx\x1b[0m');
    expect(t.bold('x')).toBe('\x1b[1mx\x1b[0m');
  });

  it('level 2 degrades to 38;5;N; level 1 to the 16-color codes', () => {
    const t2 = new Theme(GALAXY_PALETTE, 2);
    const t1 = new Theme(GALAXY_PALETTE, 1);
    expect(t2.cyan('x')).toContain('\x1b[38;5;');
    expect(t2.cyan('x').endsWith('x\x1b[0m')).toBe(true);
    expect(t1.cyan('x')).toBe('\x1b[36mx\x1b[0m'); // #22d3ee nearest → cyan
    // error #fb7185 (251,113,133) → nearest 16 is red/magenta family — just check escape shape
    const errSeq = t1.error('x');
    expect(errSeq.startsWith('\x1b[')).toBe(true);
    expect(errSeq.endsWith('x\x1b[0m')).toBe(true);
    expect(errSeq.slice(2, 3)).toMatch(/^[0-9]$/);
  });

  it('level 0 and the mono theme wrap to plain text', () => {
    for (const [palette, level] of [
      [GALAXY_PALETTE, 0],
      [paletteFor('mono'), 3],
    ] as const) {
      const t = new Theme(palette, level);
      expect(t.enabled).toBe(false);
      expect(t.cyan('hello')).toBe('hello');
      expect(t.gradient('hello world')).toBe('hello world');
      expect(t.bold('x')).toBe('x');
    }
  });

  it('themeFor reads the palette name and TTY level together', () => {
    expect(themeFor('nebula', false).palette.name).toBe('nebula');
    expect(themeFor('nebula', false).level).toBe(0);
    expect(themeFor(undefined, true, { COLORTERM: 'truecolor' }).palette.name).toBe('galaxy');
    expect(themeFor('bogus', true, { TERM: 'xterm-256color' }).palette.name).toBe('galaxy');
  });

  it('aurora is a first-class palette: emerald → teal → cyan → sky', () => {
    expect(paletteFor('aurora').name).toBe('aurora');
    expect(AURORA_PALETTE.gradient).toEqual(['#34d399', '#2dd4bf', '#22d3ee', '#38bdf8']);
    expect(isThemeName('aurora')).toBe(true);
    // level 3 emits the exact truecolor escape; sampleGradient endpoints match
    const t = new Theme(AURORA_PALETTE, 3);
    expect(t.cyan('x')).toBe('\x1b[38;2;34;211;238mx\x1b[0m');
    expect(sampleGradient(AURORA_PALETTE.gradient, 0)).toBe('#34d399');
    expect(sampleGradient(AURORA_PALETTE.gradient, 1)).toBe('#38bdf8');
  });
});

describe('selora theme command', () => {
  let env: TempEnv;

  it('no argument shows the current theme (galaxy when unset)', async () => {
    env = freshEnv();
    try {
      const { io, cap } = capturedIo();
      await runTheme(ctx(io), {});
      expect(cap.out.join('\n')).toContain('Theme');
      expect(cap.out.join('\n')).toContain('galaxy');
      expect(cap.out.join('\n')).toContain('nebula');
    } finally {
      cleanup(env.dir);
    }
  });

  it('a valid name is saved to config.json and read back', async () => {
    env = freshEnv();
    try {
      const { io, cap } = capturedIo();
      await runTheme(ctx(io), { name: 'nebula' });
      expect(cap.out.join('\n')).toContain('Theme set to nebula');
      expect(loadConfig().theme).toBe('nebula');
      // over an existing config, other fields survive
      saveConfig({ ...loadConfig(), defaultModel: 'glm-5.3' });
      const { io: io2, cap: cap2 } = capturedIo();
      await runTheme(ctx(io2), { name: 'mono' });
      const cfg = loadConfig();
      expect(cfg.theme).toBe('mono');
      expect(cfg.defaultModel).toBe('glm-5.3');
      // the mono hint is a stderr bullet, not stdout
      expect(cap2.err.join('\n')).toContain('mono disables');
    } finally {
      cleanup(env.dir);
    }
  });

  it('an invalid name fails with the available list; --json stays machine-clean', async () => {
    env = freshEnv();
    try {
      const { io, cap } = capturedIo();
      await runTheme(ctx(io), { name: 'hotdog' });
      expect(process.exitCode).toBe(1);
      expect(cap.err.join('\n')).toContain('unknown theme "hotdog"');
      expect(cap.err.join('\n')).toContain('galaxy');
      const { io: jsonIo, cap: jsonCap } = capturedIo();
      await runTheme(ctx(jsonIo, true), { name: 'hotdog' });
      const parsed = JSON.parse(jsonCap.out.join('')) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    } finally {
      cleanup(env.dir);
    }
  });

  it('--json with no argument reports the current theme', async () => {
    env = freshEnv();
    try {
      const { io, cap } = capturedIo();
      await runTheme(ctx(io, true), {});
      const parsed = JSON.parse(cap.out.join('')) as { ok: boolean; theme: string };
      expect(parsed.ok).toBe(true);
      expect(parsed.theme).toBe('galaxy');
      expect(THEME_NAMES).toEqual(['galaxy', 'nebula', 'aurora', 'mono']);
      expect(isThemeName('galaxy')).toBe(true);
      expect(isThemeName('nope')).toBe(false);
    } finally {
      cleanup(env.dir);
    }
  });

  function ctx(io: CliIo, json = false): CliContext {
    return { debug: false, json, apiUrl: undefined, io };
  }
});
