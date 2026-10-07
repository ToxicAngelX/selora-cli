/**
 * The galaxy spinner: `✦ Warping… 12s · 1.4K tokens · ctrl+c to interrupt`
 * on one stderr line, redrawn in place every ~150 ms. Frames cycle ✦ ✧ ⋆ ˚;
 * the word SHIMMERS — a per-character gradient whose hue rotates one char per
 * frame (shimmerText) — and rotates every ~3.5s through a galaxy verb list;
 * elapsed seconds are honest (floor); the token count is whatever the
 * caller's tokenSource reports (previous turns only — never invented).
 *
 * The caller starts the spinner ONLY on a TTY (NO_COLOR/non-TTY/--json never
 * see it) and must stop() before printing anything else on that stream.
 * stop() erases the line. Everything degrades to plain text when the theme
 * is disabled — the frames and words are still characters, just uncolored.
 */

import { sampleGradient, type Theme } from './theme.js';

export const SPINNER_FRAMES: readonly string[] = ['✦', '✧', '⋆', '˚'];

export const SPINNER_WORDS: readonly string[] = [
  'Orbiting…',
  'Warping…',
  'Charting stars…',
  'Scanning the void…',
  'Aligning constellations…',
  'Reading stardust…',
  'Consulting the ephemeris…',
  'Riding the solar wind…',
  'Polishing the telescope…',
  'Triangulating pulsars…',
];

const CLEAR_LINE = '\r\x1b[2K';

/**
 * Line discipline between the in-place spinner and everything else that
 * shares the terminal. Two rules, both enforced here:
 *
 *  1. stopForContent() — streamed REPLY text always stops the spinner
 *     outright. A live spinner redraws its row every ~150 ms, so any content
 *     printed while it runs lands glued onto the spinner's line — the v1.2
 *     corruption (`✦ Thinking… 2s · ctrl+c to interruptDone! …`). Thinking
 *     models interleave reasoning deltas between paragraphs and re-arm the
 *     spinner each time; a one-shot stop cannot cover that.
 *  2. uiLine() — a UI line (footer, tool row, queue notice) YIELDS the row
 *     instead: the spinner's line is erased first, the line prints, and the
 *     spinner's next tick redraws itself on the fresh row below. Work is
 *     still in flight, so the spinner keeps running — it just can never glue.
 *
 * The spinner is read through a getter so a mid-session /theme swap (which
 * replaces the Spinner instance) never strands the arbiter.
 */
export class SpinnerArbiter {
  constructor(
    private readonly spinner: () => Spinner,
    private readonly write: (s: string) => void,
  ) {}

  /** Rule 1 — before writing streamed reply text. Cheap when already stopped. */
  stopForContent(): void {
    this.spinner().stop();
  }

  /** Rule 2 — one UI line on the spinner's channel, yielded when the row is owned. */
  uiLine(line: string): void {
    const s = this.spinner();
    if (s.running) this.write(CLEAR_LINE);
    this.write(`${line}\n`);
  }
}

/**
 * Per-character gradient that rotates by `offset` chars per call — a hue
 * shimmer sweeping across the word. Whitespace stays bare; identity when the
 * theme is disabled. The rotation wraps (modulo), so a seam travels through
 * the word — it reads as moving energy, which is the point.
 */
export function shimmerText(theme: Theme, text: string, offset: number): string {
  if (theme.level === 0 || text === '') return text;
  const chars = Array.from(text); // code points — never split a surrogate pair
  if (chars.length === 0) return text;
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    if (ch.trim() === '') {
      out += ch;
      continue;
    }
    const t = chars.length <= 1 ? 0 : ((i + offset) % chars.length) / (chars.length - 1);
    out += theme.wrap(sampleGradient(theme.palette.gradient, t), ch);
  }
  return out;
}

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
  /**
   * A pinned word (v0.5: 'Thinking…' while reasoning deltas stream) —
   * overrides the rotating word list. start() clears it, so each wait phase
   * begins on the galaxy words again.
   */
  private fixedWord: string | undefined;

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

  /** Pin a word (undefined returns to the rotating list). Redraws if running. */
  setFixedWord(word: string | undefined): void {
    this.fixedWord = word;
    if (this.timer !== undefined) this.draw();
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.fixedWord = undefined;
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
    // The word changes ~every 24 frames (3.5s at 150ms) — unless pinned.
    const word = this.fixedWord ?? this.words[Math.floor(this.frame / 24) % this.words.length]!;
    const elapsed = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    const tokens = this.tokenSource?.();
    const meta =
      tokens !== undefined && tokens > 0
        ? `${elapsed}s · ${tokens.toLocaleString('en-US')} tokens · ctrl+c to interrupt`
        : `${elapsed}s · ctrl+c to interrupt`;
    const line =
      t !== undefined
        ? `${t.violet(frameChar)} ${shimmerText(t, word, this.frame)} ${t.dim(meta)}`
        : `${frameChar} ${word} ${meta}`;
    this.io.write(`${CLEAR_LINE}${line}`);
    this.visible = true;
  }
}
