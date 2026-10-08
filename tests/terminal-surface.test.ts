import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import { TerminalSurface, clipSurfaceLine } from '../src/ui/terminal-surface.js';

function harness(cols = 20, rows = 8) {
  const writes: string[] = [];
  const size = { cols, rows };
  const surface = new TerminalSurface({ write: (s) => writes.push(s), cols: () => size.cols, rows: () => size.rows });
  return { writes, size, surface };
}

// Tiny terminal model: LF at the bottom scrolls natively, CSI movement never does.
function terminal(cols: number, rows: number) {
  const screen = Array.from({ length: rows }, () => '');
  const scrollback: string[] = [];
  let row = rows - 1;
  let col = 0;
  return {
    screen, scrollback,
    get cursor() { return { row, col }; },
    feed(text: string) {
      const esc = String.fromCharCode(27);
      const tokens = text.match(new RegExp(`${esc}\\[[0-?]*[ -/]*[@-~]|\\r|\\n|[^${esc}\\r\\n]+`, 'g')) ?? [];
      for (const token of tokens) {
        if (token === '\r') col = 0;
        else if (token === '\n') {
          row += 1;
          if (row === rows) { scrollback.push(screen.shift()!); screen.push(''); row -= 1; }
        } else if (token.startsWith('\x1b[')) {
          const match = new RegExp(`^${String.fromCharCode(27)}\\[(\\d*)([ABCK])$`).exec(token);
          if (match !== null) {
            const n = Number(match[1] || 1);
            if (match[2] === 'A') row = Math.max(0, row - n);
            if (match[2] === 'B') row = Math.min(rows - 1, row + n);
            if (match[2] === 'C') col = Math.min(cols - 1, col + n);
            if (match[2] === 'K') screen[row] = '';
          }
        } else {
          screen[row] = screen[row]!.slice(0, col) + token;
          col += stringWidth(token);
          expect(col).toBeLessThan(cols);
        }
      }
    },
  };
}

describe('TerminalSurface', () => {
  it('clips styled rows without splitting escapes, graphemes, or permitting layout injection', () => {
    const clipped = clipSurfaceLine('\x1b[36mé👨‍👩‍👧‍👦界\x1b[0m', 3);
    expect(clipped).toContain('é👨‍👩‍👧‍👦');
    expect(clipped).not.toContain('界');
    expect(clipped.endsWith('\x1b[0m')).toBe(true);
    expect(stringWidth(clipped)).toBe(3);
    expect(clipSurfaceLine('x\x1b[2J\x1b]0;evil\x07\ny', 8)).toBe('x y');
  });

  it('bounds dynamic rows, batches synchronized redraw, and never clears the screen', () => {
    const { surface, writes } = harness(10, 6);
    surface.setPrompt({ lines: ['prompt', 'footer'], cursor: { row: 0, col: 3 } });
    surface.setLive(Array.from({ length: 20 }, (_, i) => `live${i}xxxxxxxx`));
    expect(writes).toHaveLength(2);
    for (const write of writes) {
      expect(write.startsWith('\x1b[?2026h')).toBe(true);
      expect(write.endsWith('\x1b[?2026l')).toBe(true);
      const esc = String.fromCharCode(27);
      expect(write).not.toMatch(new RegExp(`${esc}\\[(?:[0123]J|\\?1049[hl]|\\d*;\\d*r)`));
      expect((write.match(new RegExp(`${esc}\\[2K`, 'g')) ?? []).length).toBeLessThanOrEqual(4);
    }
    expect(writes.at(-1)).not.toContain('live17');
    expect(writes.at(-1)).toContain('live18');
    expect(writes.at(-1)).toContain('live19');
  });

  it('keeps the draft cursor correct while live output grows, shrinks, and commits', () => {
    const { surface, writes } = harness(20, 8);
    const tty = terminal(20, 8);
    const flush = () => { while (writes.length) tty.feed(writes.shift()!); };
    surface.setPrompt({ lines: ['draft', 'footer'], cursor: { row: 0, col: 3 } }); flush();
    surface.setLive(['one', 'two', 'three']); flush();
    expect(tty.screen[tty.cursor.row]).toBe('draft');
    expect(tty.cursor.col).toBe(3);
    surface.setLive(['last']); flush();
    expect(tty.screen[tty.cursor.row]).toBe('draft');
    surface.commitLive(); flush();
    expect(tty.screen[tty.cursor.row]).toBe('draft');
    expect(tty.screen.filter((line) => line === 'last')).toHaveLength(1);
    surface.writeOutput('transcript\n'); flush();
    expect(tty.screen[tty.cursor.row]).toBe('draft');
    expect(tty.cursor.col).toBe(3);
    surface.writeOutput('scroll\n'.repeat(20)); flush();
    expect(tty.scrollback).toContain('transcript');
    expect(tty.screen[tty.cursor.row]).toBe('draft');
  });

  it('clears only owned rows and makes suspend/resume/dispose idempotent', () => {
    const { surface, writes, size } = harness();
    surface.setPrompt({ lines: ['draft'], cursor: { row: 0, col: 2 } });
    surface.suspend(); const n = writes.length;
    surface.suspend(); surface.setLive(['stream']); expect(writes).toHaveLength(n);
    surface.resume(); const resumed = writes.length;
    surface.resume(); expect(writes).toHaveLength(resumed);
    size.rows = 3; surface.resize();
    expect((writes.at(-1)!.match(new RegExp(`${String.fromCharCode(27)}\\[2K`, 'g')) ?? []).length).toBeLessThanOrEqual(1);
    surface.dispose(); const disposed = writes.length;
    surface.dispose(); surface.resume(); surface.setLive(['ignored']); surface.writeOutput('ignored');
    expect(writes).toHaveLength(disposed);
  });
});
