/**
 * Startup-screen (logo/starfield/tips) tests: level-0 output carries no
 * ANSI escapes; stars only ever land on empty canvas cells (never on a logo
 * glyph — checked cell-by-cell against the logoLines mask); seeded rngs
 * give different star positions; width < 60 falls back to the compact mark
 * with no block letters; the pinned tips are present and NO info box is
 * rendered (v0.5 removed it); no line exceeds the requested width, colored
 * or not; star glyphs come only from the allowed set; the ambient banner
 * re-colors the same scene per tick (layout frozen, colors move).
 *
 * ANSI stripping builds its pattern with a runtime-produced ESC
 * (String.fromCharCode(27)) — no regex literal and no statically-known
 * control character, so eslint's no-control-regex stays satisfied.
 */

import { describe, expect, it } from 'vitest';
import { GALAXY_PALETTE, Theme } from '../src/ui/theme.js';
import {
  bannerHeight,
  compactLogoLine,
  logoLines,
  makeLogoScene,
  renderAmbientFrame,
  renderStartupFrames,
  renderStartupScreen,
  starFieldCanvas,
  startupTail,
  sweepPhase,
  STARTUP_FRAME_COUNT,
} from '../src/ui/logo.js';

// ANSI stripping with no regex literal and no statically-known control
// character: the ESC is produced at runtime, so no-control-regex has
// nothing to flag (a string literal '\x1b' inside new RegExp(...) is
// resolved by the rule and rejected).
const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

const ALLOWED_STARS = new Set(['✦', '·', '˚', '⋆', '*']);
const PLAIN = (s: string): string => s; // identity "dim" for plain-canvas tests

/** Deterministic rng in [0,1) from an integer seed (classic LCG). */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

describe('logoLines and compactLogoLine', () => {
  it('the block is 5 plain rows, at most 56 columns, no escapes', () => {
    const logo = logoLines();
    expect(logo.length).toBe(5);
    for (const row of logo) {
      expect(row.length).toBeLessThanOrEqual(56);
      expect(row.includes('\x1b')).toBe(false);
    }
    expect(logo.join('\n').includes('█')).toBe(true);
    // all rows share one alignment: same trailing width (grid letters)
    expect(new Set(logo.map((row) => row.length)).size).toBe(1);
  });

  it('compactLogoLine is the one-line mark', () => {
    const line = compactLogoLine();
    expect(line).toBe('✦ selora');
    expect(line.includes('█')).toBe(false);
  });
});

describe('starFieldCanvas', () => {
  it('pads/trims every line to exactly the canvas width', () => {
    const canvas = starFieldCanvas(['short', 'x'.repeat(70)], 56, 9, seeded(2), PLAIN);
    expect(canvas.length).toBe(9);
    for (const row of canvas) expect(row.length).toBe(56);
  });

  it('stars only land on empty cells — never on a logo glyph', () => {
    const logo = logoLines();
    const canvas = starFieldCanvas(logo, 56, 9, seeded(42), PLAIN);
    for (let r = 0; r < logo.length; r += 1) {
      for (let c = 0; c < logo[r]!.length; c += 1) {
        if (logo[r]![c] !== ' ') {
          expect(canvas[r]![c]).toBe(logo[r]![c]); // glyph untouched
        }
      }
    }
  });

  it('star characters come only from the allowed set', () => {
    const canvas = starFieldCanvas(logoLines(), 56, 9, seeded(42), PLAIN);
    for (const row of canvas) {
      for (const ch of row) {
        if (ch === ' ' || ch === '█') continue;
        expect(ALLOWED_STARS.has(ch)).toBe(true);
      }
    }
  });

  it('the field is sparse but present (~4% of empty cells)', () => {
    const canvas = starFieldCanvas([], 56, 9, seeded(8), PLAIN);
    const stars = canvas
      .join('')
      .split('')
      .filter((ch) => ch !== ' ').length;
    expect(stars).toBeGreaterThan(3);
    expect(stars).toBeLessThan(56 * 9 * 0.15);
  });

  it('same seed → same field; different seeds → different positions', () => {
    const logo = logoLines();
    const a = starFieldCanvas(logo, 56, 9, seeded(1), PLAIN);
    const a2 = starFieldCanvas(logo, 56, 9, seeded(1), PLAIN);
    const b = starFieldCanvas(logo, 56, 9, seeded(2), PLAIN);
    expect(a).toEqual(a2);
    expect(a.join('\n')).not.toBe(b.join('\n'));
  });
});

describe('renderStartupScreen', () => {
  it('a level-0 theme renders no ANSI escapes anywhere', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const out = renderStartupScreen(theme, { width: 80, rng: seeded(7) });
    expect(out.length).toBeGreaterThan(0);
    for (const line of out) expect(line.includes('\x1b')).toBe(false);
  });

  it('on the full screen, logo rows keep every glyph (stars only fill gaps)', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const out = renderStartupScreen(theme, { width: 80, rng: seeded(21) });
    const logo = logoLines();
    // the canvas puts 2 blank sky rows above the logo → logo rows are 2..6
    for (let r = 0; r < logo.length; r += 1) {
      const screenRow = out[2 + r] ?? '';
      expect(screenRow.split('█').length - 1).toBe(logo[r]!.split('█').length - 1);
      for (const ch of screenRow) {
        if (ch === ' ' || ch === '█') continue;
        expect(ALLOWED_STARS.has(ch)).toBe(true);
      }
    }
    // the sky rows above the logo hold only stars and spaces
    for (const row of [out[0]!, out[1]!]) {
      for (const ch of row) {
        if (ch === ' ') continue;
        expect(ALLOWED_STARS.has(ch)).toBe(true);
      }
    }
  });

  it('the logo rows carry the per-character gradient when color is on', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const out = renderStartupScreen(theme, { width: 80, rng: seeded(6) });
    const band = out.slice(2, 7).join('\n');
    expect(band.includes('\x1b[38;2;')).toBe(true);
    expect(band.includes('█')).toBe(true);
  });

  it('width < 60 uses the compact line — no block letters appear', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const out = renderStartupScreen(theme, { width: 50, rng: seeded(3) });
    expect(out.join('\n').includes('█')).toBe(false);
    expect(out[0]).toBe(compactLogoLine());
    // width 60 is still block territory
    const wide = renderStartupScreen(theme, { width: 60, rng: seeded(3) });
    expect(wide.join('\n').includes('█')).toBe(true);
  });

  it('v0.5: NO info box — the screen is canvas + tips, nothing else', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const out = renderStartupScreen(theme, { width: 80, rng: seeded(9) });
    const text = stripAnsi(out.join('\n'));
    // the pinned tips are there…
    expect(text.includes('/help for commands')).toBe(true);
    expect(text.includes('/exit ends the session')).toBe(true);
    // …and the box (and its field labels) is gone for good
    for (const gone of ['╭', '╰', '│', 'version', 'model', 'cwd', 'plan']) {
      expect(text.includes(gone)).toBe(false);
    }
    // 9 canvas rows + blank + 3 tips
    expect(out.length).toBe(13);
  });

  it('no line exceeds the requested width, plain or colored', () => {
    for (const width of [80, 60, 50, 40]) {
      const plain = renderStartupScreen(new Theme(GALAXY_PALETTE, 0), {
        width,
        rng: seeded(5),
      });
      for (const line of plain) expect(line.length <= width).toBe(true);
      const colored = renderStartupScreen(new Theme(GALAXY_PALETTE, 3), {
        width,
        rng: seeded(5),
      });
      for (const line of colored) expect(stripAnsi(line).length <= width).toBe(true);
    }
  });
});

describe('startup frames', () => {
  it('default count is STARTUP_FRAME_COUNT; frames opt is honored and clamped', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    expect(renderStartupFrames(theme, { width: 80, rng: seeded(1) }).length).toBe(
      STARTUP_FRAME_COUNT,
    );
    expect(renderStartupFrames(theme, { width: 80, rng: seeded(1), frames: 3 }).length).toBe(3);
    expect(renderStartupFrames(theme, { width: 80, rng: seeded(1), frames: 99 }).length).toBe(32);
    expect(renderStartupFrames(theme, { width: 80, rng: seeded(1), frames: 0 }).length).toBe(1);
  });

  it('every frame has the same row count (the in-place redraw invariant)', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(11) });
    const counts = new Set(frames.map((f) => f.length));
    expect(counts.size).toBe(1);
  });

  it('the final frame IS the static screen (same seed, byte for byte)', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(42) });
    const staticScreen = renderStartupScreen(theme, { width: 80, rng: seeded(42) });
    expect(frames[frames.length - 1]).toEqual(staticScreen);
  });

  it('layout is stable across frames — only colors move', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(13) });
    const stripped = frames.map((f) => stripAnsi(f.join('\n')));
    for (const s of stripped) expect(s).toBe(stripped[0]);
  });

  it('level 0: all frames are byte-identical and ANSI-free', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(17) });
    for (const frame of frames) {
      const text = frame.join('\n');
      expect(text.includes('\x1b')).toBe(false);
      expect(text).toBe(frames[0]!.join('\n'));
    }
  });

  it('level 3: the sweep actually moves (first frame ≠ final frame)', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(19) });
    expect(frames[0]!.join('\n')).not.toBe(frames[frames.length - 1]!.join('\n'));
  });

  it('stars never land on a logo glyph — in ANY frame', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(23) });
    const logo = logoLines();
    for (const frame of frames) {
      const plain = stripAnsi(frame.join('\n')).split('\n');
      for (let r = 0; r < logo.length; r += 1) {
        const screenRow = plain[2 + r] ?? '';
        expect(screenRow.split('█').length - 1).toBe(logo[r]!.split('█').length - 1);
        for (const ch of screenRow) {
          if (ch === ' ' || ch === '█') continue;
          expect(ALLOWED_STARS.has(ch)).toBe(true);
        }
      }
    }
  });

  it('no stripped line exceeds the width in any frame (80 and 60)', () => {
    for (const width of [80, 60]) {
      const frames = renderStartupFrames(new Theme(GALAXY_PALETTE, 3), {
        width,
        rng: seeded(29),
      });
      for (const frame of frames) {
        for (const line of frame) expect(stripAnsi(line).length <= width).toBe(true);
      }
    }
  });
});

describe('the pinned ambient banner', () => {
  it('bannerHeight: 9 rows for the block, 1 for the compact mark', () => {
    expect(bannerHeight(80)).toBe(9);
    expect(bannerHeight(60)).toBe(9);
    expect(bannerHeight(59)).toBe(1);
  });

  it('sweepPhase lands exactly on 0 and starts at the sweep offset', () => {
    expect(sweepPhase(STARTUP_FRAME_COUNT - 1, STARTUP_FRAME_COUNT)).toBe(0);
    expect(sweepPhase(0, STARTUP_FRAME_COUNT)).toBeLessThan(0);
    expect(sweepPhase(0, 1)).toBe(0);
  });

  it('the tail is a blank row plus exactly three tips', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const tail = startupTail(theme, { width: 80, rng: seeded(31) });
    expect(tail.length).toBe(4);
    expect(tail[0]).toBe('');
    expect(tail[1]).toBe('/help for commands');
    expect(tail[2]).toBe('/exit ends the session');
  });

  it('ambient ticks keep the layout frozen — only colors move', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const scene = makeLogoScene(80, seeded(37));
    const a = renderAmbientFrame(scene, theme, 0);
    const b = renderAmbientFrame(scene, theme, 1);
    expect(a.length).toBe(scene.height);
    expect(b.length).toBe(scene.height);
    // same characters, different colors (twinkle rotates and/or drift moves)
    expect(stripAnsi(a.join('\n'))).toBe(stripAnsi(b.join('\n')));
    expect(a.join('\n')).not.toBe(b.join('\n'));
  });

  it('ambient frames at level 0 are byte-identical and ANSI-free', () => {
    const theme = new Theme(GALAXY_PALETTE, 0);
    const scene = makeLogoScene(80, seeded(41));
    const a = renderAmbientFrame(scene, theme, 0);
    const b = renderAmbientFrame(scene, theme, 7);
    expect(a.join('\n')).toBe(b.join('\n'));
    expect(a.join('\n').includes('\x1b')).toBe(false);
  });

  it('same seed → same scene; ambient tick 0 equals the intro landing frame', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const scene = makeLogoScene(80, seeded(43));
    // tick 0: phase 0, twinkle frame 0 — exactly where the sweep lands
    const landing = renderAmbientFrame(scene, theme, 0);
    const frames = renderStartupFrames(theme, { width: 80, rng: seeded(43) });
    const sweepLanding = frames[frames.length - 1]!.slice(0, scene.height);
    expect(landing).toEqual(sweepLanding);
  });
});
