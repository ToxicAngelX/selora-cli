/**
 * The galaxy spinner (v0.3): `✦ Warping… 12s · 1.4K tokens` on one stderr
 * line, redrawn in place every ~150 ms. Frames cycle ✦ ✧ ⋆ ˚ through the
 * theme's gradient; the word rotates every ~3.5s through a galaxy verb list;
 * elapsed seconds are honest (floor); the token count is whatever the
 * caller's tokenSource reports (previous turns only — never invented).
 *
 * The caller starts the spinner ONLY on a TTY (NO_COLOR/non-TTY/--json never
 * see it) and must stop() before printing anything else on that stream.
 * stop() erases the line. Everything degrades to plain text when the theme
 * is disabled — the frames and words are still characters, just uncolored.
 */

import type { Theme } from './theme.js';

export const SPINNER_FRAMES: readonly string[] = ['✦', '✧', '⋆', '˚'];

export const SPINNER_WORDS: readonly string[] = [
  'Orbiting…',
  'Warping…',
  'Charting stars…',
  'Scanning the void…',
  'Aligning constellations…',
  'Reading stardust…',
];

const CLEAR_LINE = '\r\x1b[2K';

export interface SpinnerOptions {
  theme?: Theme | undefined;
  /** Words to rotate through (default SPINNER_WORDS). */
  words?: readonly string[];
  /** Redraw interval in ms (default 150). */
  intervalMs?: number;
  /** Honest token count so far (previous turns); undefined = not shown. */
  tokenSource?: (() => number | undefined) | undefined;
}

export interface SpinnerIo {
  /** Raw stderr write with NO added newline (the spinner owns the line). */
  write: (s: string) => void;
}

export class Spinner {
  private readonly io: SpinnerIo;
  private readonly theme: Theme | undefined;
  private readonly words: readonly string[];
  private readonly intervalMs: number;
  private readonly tokenSource: (() => number | undefined) | undefined;
  private timer: NodeJS.Timeout | undefined;
  private frame = 0;
  private startedAt = 0;
  private visible = false;

  constructor(io: SpinnerIo, opts: SpinnerOptions = {}) {
    this.io = io;
    this.theme = opts.theme;
    this.words = opts.words ?? SPINNER_WORDS;
    this.intervalMs = opts.intervalMs ?? 150;
    this.tokenSource = opts.tokenSource;
  }

  get running(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.startedAt = Date.now();
    this.frame = 0;
    this.draw();
    this.timer = setInterval(() => {
      this.frame += 1;
      this.draw();
    }, this.intervalMs);
    // The interval must not keep the process alive on its own.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.visible) {
      this.io.write(CLEAR_LINE);
      this.visible = false;
    }
  }

  private draw(): void {
    const t = this.theme;
    const frameChar = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!;
    // The word changes ~every 24 frames (3.5s at 150ms).
    const word = this.words[Math.floor(this.frame / 24) % this.words.length]!;
    const elapsed = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const parts = [word, `${elapsed}s`];
    const tokens = this.tokenSource?.();
    if (tokens !== undefined && tokens > 0) parts.push(`${tokens.toLocaleString('en-US')} tokens`);
    const text = parts.join(' · ');
    const line = t !== undefined ? `${t.violet(frameChar)} ${t.dim(text)}` : `${frameChar} ${text}`;
    this.io.write(`${CLEAR_LINE}${line}`);
    this.visible = true;
  }
}
