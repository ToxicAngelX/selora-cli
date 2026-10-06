/**
 * playFrames tests: a recording sink + instant sleep drive the player
 * hermetically. Assertions cover the write shapes: single-frame passthrough,
 * first frame without cursor moves, redraw writes with \r + cursor-up +
 * per-row clear-line, trailing-space trimming, the terminating newline, and
 * the empty-input no-op.
 */

import { describe, expect, it } from 'vitest';
import { playFrames, STARTUP_FRAME_MS, type FrameSink } from '../src/ui/animate.js';

function recorder(): { sink: FrameSink; writes: string[]; sleeps: number[] } {
  const writes: string[] = [];
  const sleeps: number[] = [];
  return {
    writes,
    sleeps,
    sink: {
      write: (s) => {
        writes.push(s);
      },
      sleep: (ms) => {
        sleeps.push(ms);
        return Promise.resolve();
      },
    },
  };
}

describe('playFrames', () => {
  it('zero frames is a no-op', async () => {
    const { sink, writes, sleeps } = recorder();
    await playFrames([], sink);
    expect(writes).toEqual([]);
    expect(sleeps).toEqual([]);
  });

  it('a single frame prints plainly with a trailing newline', async () => {
    const { sink, writes, sleeps } = recorder();
    await playFrames([['a', 'b']], sink);
    expect(writes).toEqual(['a\nb\n']);
    expect(sleeps).toEqual([]);
  });

  it('multi-frame: first write has no cursor moves, redraws cursor-up + clear each row', async () => {
    const { sink, writes, sleeps } = recorder();
    const frames = [
      ['a0', 'b0', 'c0'],
      ['a1', 'b1', 'c1'],
      ['a2', 'b2', 'c2'],
    ];
    await playFrames(frames, sink);
    expect(writes.length).toBe(4); // frame0 + frame1 + frame2 + final newline
    expect(writes[0]).toBe('a0\nb0\nc0'); // no trailing newline, no escapes
    expect(writes[0]!.includes('\x1b')).toBe(false);
    // redraws: \r, cursor up N-1 = 2 rows, each row cleared then rewritten
    expect(writes[1]).toBe('\r\x1b[2A\x1b[2Ka1\n\x1b[2Kb1\n\x1b[2Kc1');
    expect(writes[2]).toBe('\r\x1b[2A\x1b[2Ka2\n\x1b[2Kb2\n\x1b[2Kc2');
    expect(writes[3]).toBe('\n');
    // one sleep per redraw, at the default cadence
    expect(sleeps).toEqual([STARTUP_FRAME_MS, STARTUP_FRAME_MS]);
  });

  it('trailing spaces are trimmed so padded rows never auto-wrap', async () => {
    const { sink, writes } = recorder();
    await playFrames(
      [
        ['x   ', 'y  '],
        ['z ', 'w'],
      ],
      sink,
    );
    expect(writes[0]).toBe('x\ny');
    expect(writes[1]).toBe('\r\x1b[1A\x1b[2Kz\n\x1b[2Kw');
  });

  it('a custom interval reaches sleep; one-row frames cursor-up 0 (a no-op CUU)', async () => {
    const { sink, writes, sleeps } = recorder();
    await playFrames([['one'], ['two']], sink, 5);
    expect(sleeps).toEqual([5]);
    expect(writes[1]).toBe('\r\x1b[0A\x1b[2Ktwo');
  });
});
