/**
 * Spinner tests: shimmerText identity/rotation/bare-spaces/strip-roundtrip,
 * and the Spinner class against a recording io — start() draws synchronously
 * once (no fake timers needed), stop() erases the line.
 *
 * ANSI stripping builds its pattern with a runtime-produced ESC
 * (String.fromCharCode(27)) — no regex literal and no statically-known
 * control character, so eslint's no-control-regex stays satisfied.
 */

import { describe, expect, it } from 'vitest';
import { GALAXY_PALETTE, Theme } from '../src/ui/theme.js';
import { shimmerText, Spinner } from '../src/ui/spinner.js';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(ESC + '\\[[0-9;]*m', 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

describe('shimmerText', () => {
  it('is the identity at level 0 and for empty text', () => {
    const t = new Theme(GALAXY_PALETTE, 0);
    expect(shimmerText(t, 'Warping…', 3)).toBe('Warping…');
    expect(shimmerText(new Theme(GALAXY_PALETTE, 3), '', 0)).toBe('');
  });

  it('colors visible glyphs and strips back to the input', () => {
    const t = new Theme(GALAXY_PALETTE, 3);
    const out = shimmerText(t, 'a b', 0);
    expect(out.includes(ESC + '[38;2;')).toBe(true);
    expect(stripAnsi(out)).toBe('a b');
    // the space stays bare between two colored runs
    expect(out).toContain(ESC + '[0m ' + ESC + '[38;2;');
  });

  it('the hue rotates with the offset', () => {
    const t = new Theme(GALAXY_PALETTE, 3);
    expect(shimmerText(t, 'Orbiting…', 0)).not.toBe(shimmerText(t, 'Orbiting…', 1));
  });
});

describe('Spinner', () => {
  function recorder(): { io: { write(s: string): void }; writes: string[] } {
    const writes: string[] = [];
    return { writes, io: { write: (s) => writes.push(s) } };
  }

  it('start() draws synchronously: word, honest 0s, ctrl+c hint; stop() erases', () => {
    const theme = new Theme(GALAXY_PALETTE, 3);
    const { io, writes } = recorder();
    const spinner = new Spinner(io, { theme });
    spinner.start();
    expect(spinner.running).toBe(true);
    expect(writes.length).toBe(1);
    const line = stripAnsi(writes[0]!);
    expect(line.startsWith('\r' + ESC + '[2K')).toBe(true);
    expect(line).toContain('0s');
    expect(line).toContain('ctrl+c to interrupt');
    spinner.stop();
    expect(spinner.running).toBe(false);
    expect(writes[1]).toBe('\r' + ESC + '[2K');
  });

  it('no theme → plain text line (still honest and hinted)', () => {
    const { io, writes } = recorder();
    const spinner = new Spinner(io);
    spinner.start();
    const line = writes[0]!;
    expect(line).toContain('Orbiting… 0s · ctrl+c to interrupt');
    expect(line.includes('[38;2;')).toBe(false);
    spinner.stop();
  });

  it('the token count shows only when the source reports one', () => {
    const { io, writes } = recorder();
    const box: { tokens: number | undefined } = { tokens: undefined };
    const spinner = new Spinner(io, { tokenSource: () => box.tokens });
    spinner.start();
    expect(writes[writes.length - 1]!).not.toContain('tokens');
    spinner.stop();
    box.tokens = 42100;
    const again = new Spinner(io, { tokenSource: () => box.tokens });
    again.start();
    expect(writes[writes.length - 1]!).toContain('42,100 tokens');
    again.stop();
  });
});
