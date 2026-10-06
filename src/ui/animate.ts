/**
 * Frame playback on a real terminal: write the first frame, then redraw in
 * place with carriage-return + cursor-up + clear-line. Only plain cursor
 * addressing (CUU/EL) is used — no DEC-private modes, no alternate screen —
 * so Windows Terminal, kitty, xterm and tmux all behave the same way.
 *
 * The CALLER gates: play only on a real TTY with an enabled theme (level >
 * 0); NO_COLOR / TERM=dumb / mono / pipes never reach this module. Every
 * frame must have the SAME row count (renderStartupFrames guarantees it) —
 * the cursor-up math assumes the previous frame occupies exactly the rows
 * the next one redraws.
 *
 * io and sleep are injected, so tests drive it with a recording sink and an
 * instant sleep — no timers, no TTY.
 */

export interface FrameSink {
  /** Raw write with NO added newline (the player owns the cursor). */
  readonly write: (s: string) => void;
  readonly sleep: (ms: number) => Promise<void>;
}

/** Default frame cadence: 9 frames × 70ms ≈ a 0.63s intro. */
export const STARTUP_FRAME_MS = 70;

const CLEAR_LINE = '\x1b[2K';

/**
 * Strip trailing bare spaces. Only glyph/star cells are ever color-wrapped,
 * so padding is plain spaces; trimming it is a visual no-op that avoids the
 * auto-wrap edge case (a padded row exactly `width` columns wide would wrap
 * and corrupt the cursor-up count). No control characters involved.
 *
 * Exported for the pinned banner's ambient redraw, which plays by the same
 * never-wrap rule.
 */
export const trimEnd = (s: string): string => s.replace(/ +$/, '');

/**
 * Play `frames` in place. Zero frames is a no-op; a single frame prints
 * plainly with a trailing newline. Otherwise: frame 0 with NO trailing
 * newline, then per subsequent frame `\r` + cursor-up(N-1) + N cleared rows,
 * and a final '\n' — the terminal is left exactly as if the last frame had
 * been printed line by line.
 */
export async function playFrames(
  frames: ReadonlyArray<readonly string[]>,
  sink: FrameSink,
  intervalMs: number = STARTUP_FRAME_MS,
): Promise<void> {
  if (frames.length === 0) return;
  if (frames.length === 1) {
    sink.write(`${frames[0]!.map(trimEnd).join('\n')}\n`);
    return;
  }
  let prevRows = 0;
  for (let k = 0; k < frames.length; k += 1) {
    const rows = frames[k]!;
    if (k === 0) {
      sink.write(rows.map(trimEnd).join('\n'));
    } else {
      await sink.sleep(intervalMs);
      const up = `\x1b[${prevRows - 1}A`; // CUU 0 is a valid no-op
      sink.write(`\r${up}${rows.map((row) => `${CLEAR_LINE}${trimEnd(row)}`).join('\n')}`);
    }
    prevRows = rows.length;
  }
  sink.write('\n');
}
