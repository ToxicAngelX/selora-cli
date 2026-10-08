import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PromptInput } from '../src/ui/prompt-input.js';
import { TerminalSurface } from '../src/ui/terminal-surface.js';
import { themeFor } from '../src/ui/theme.js';
import type { SlashCommand } from '../src/ui/promptmenu.js';

const inputs: PromptInput[] = [];
afterEach(() => { for (const input of inputs.splice(0)) input.detach(); vi.useRealTimers(); });

function harness(history: string[] = [], commands: SlashCommand[] = []) {
  const stdin = new PassThrough() as PassThrough & { isRaw: boolean; setRawMode: ReturnType<typeof vi.fn> };
  stdin.isRaw = false;
  stdin.setRawMode = vi.fn((raw: boolean) => { stdin.isRaw = raw; });
  const writes: string[] = [];
  const size = { cols: 40, rows: 12 };
  const surface = new TerminalSurface({ write: (s) => writes.push(s), cols: () => size.cols, rows: () => size.rows });
  const onSubmit = vi.fn(); const onInterrupt = vi.fn(); const onExit = vi.fn(); const onMode = vi.fn();
  const input = new PromptInput({ stdin, surface, theme: () => themeFor('mono', true, {}), cols: () => size.cols, rows: () => size.rows, footer: () => ['model · cwd · 0 tokens'], commands: () => commands, history: () => history, cwd: '/root/selora-cli', onSubmit, onInterrupt, onExit, onMode });
  inputs.push(input); input.attach(); input.prompt();
  const feed = (...chunks: (Buffer | string)[]) => { for (const chunk of chunks) stdin.emit('data', chunk); };
  return { input, stdin, writes, size, surface, feed, onSubmit, onInterrupt, onExit, onMode };
}

describe('PromptInput raw public seams', () => {
  it('inserts split multiline bracketed paste literally and never submits controls inside it', () => {
    const h = harness();
    h.feed('\x1b[20', '0~first\r', '\nsecond\rthird\x03\x1b[2J\x1b[20', '1~');
    expect(h.input.line).toBe('first\nsecond\nthird');
    expect(h.onSubmit).not.toHaveBeenCalled(); expect(h.onInterrupt).not.toHaveBeenCalled();
    h.feed('\r\n');
    expect(h.onSubmit).toHaveBeenCalledExactlyOnceWith('first\nsecond\nthird');
    expect(h.input.line).toBe('');
  });

  it('handles paste markers batched with text and normalizes lone CR', () => {
    const h = harness();
    h.feed('a\x1b[200~b\rc\x1b[201~d');
    expect(h.input.line).toBe('ab\ncd');
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it('reassembles split UTF8 and edits combining/ZWJ graphemes', () => {
    const h = harness(); const utf8 = Buffer.from('é👨‍👩‍👧‍👦');
    for (const byte of utf8) h.feed(Buffer.from([byte]));
    expect(h.input.line).toBe('é👨‍👩‍👧‍👦');
    h.feed('\x7f'); expect(h.input.line).toBe('é');
    h.feed('\x1b[', 'D', '\x1b[3', '~'); expect(h.input.line).toBe('');
  });

  it('supports multiline arrows, Home/End, word motions, and newline keys', () => {
    const h = harness();
    h.feed('one', '\x1b[13;', '2u', 'two', '\n', 'three\\\r', 'four');
    expect(h.input.line).toBe('one\ntwo\nthree\nfour'); expect(h.onSubmit).not.toHaveBeenCalled();
    h.feed('\x1b[A', '\x1b[H', 'X', '\x1b[F', '\x1b[1;5D', '\x1b[3~');
    expect(h.input.line).toBe('one\ntwo\nthree\nfour');
    expect(h.input.cursor).toBe(8);
    h.feed('\x1b[Z'); expect(h.onMode).toHaveBeenCalledTimes(1);
  });

  it('browses history at first/last logical row and restores the original draft', () => {
    const h = harness(['latest', 'older']); h.input.setValue('draft');
    h.feed('\x1b[A'); expect(h.input.line).toBe('latest');
    h.feed('\x1b[A'); expect(h.input.line).toBe('older');
    h.feed('\x1b[B', '\x1b[B'); expect(h.input.line).toBe('draft');
    h.input.setValue('a\nb'); h.feed('\x1b[A'); expect(h.input.line).toBe('a\nb'); expect(h.input.cursor).toBe(1);
  });

  it('Ctrl+R inserts a full history pick without submitting, Esc restores the draft', () => {
    vi.useFakeTimers(); const h = harness(['first prompt', 'second prompt']);
    h.input.setValue('draft'); h.feed('\x12', 'second', '\r');
    expect(h.input.line).toBe('second prompt'); expect(h.onSubmit).not.toHaveBeenCalled();
    h.input.setValue('draft'); h.feed('\x12', 'first', '\x1b'); vi.advanceTimersByTime(51);
    expect(h.input.line).toBe('draft'); expect(h.onInterrupt).not.toHaveBeenCalled();
  });

  it('Tab only completes and Enter requires exact or explicit slash selection', () => {
    const run = vi.fn(); const h = harness([], [{ name: 'help', description: 'help', run }, { name: 'hello', description: 'hello', run }]);
    h.feed('/he\t'); expect(h.input.line).toBe('/help'); expect(h.onSubmit).not.toHaveBeenCalled(); expect(run).not.toHaveBeenCalled();
    h.feed('\r'); expect(h.onSubmit).toHaveBeenCalledExactlyOnceWith('/help');
    h.onSubmit.mockClear(); h.feed('/he\r'); expect(h.input.line).toBe('/help'); expect(h.onSubmit).not.toHaveBeenCalled();
    h.input.setValue('/he'); h.feed('\x1b[B\r'); expect(h.onSubmit).toHaveBeenCalledExactlyOnceWith('/hello');
  });

  it('completes @files through pure menu helpers without submitting', () => {
    const h = harness(); h.feed('read @CONTRI\t');
    expect(h.input.line).toBe('read @CONTRIBUTING.md'); expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it('Ctrl+C interrupts, Esc dismisses completion first, Ctrl+D exits only empty', () => {
    vi.useFakeTimers(); const h = harness([], [{ name: 'help', description: '', run: () => {} }]);
    h.feed('/h\x1b'); vi.advanceTimersByTime(51); expect(h.onInterrupt).not.toHaveBeenCalled();
    h.feed('\x1b'); vi.advanceTimersByTime(51); expect(h.onInterrupt).toHaveBeenCalledTimes(1);
    h.feed('\x03'); expect(h.onInterrupt).toHaveBeenCalledTimes(2);
    h.input.setValue('😀'); h.feed('\x01\x04'); expect(h.input.line).toBe(''); expect(h.onExit).not.toHaveBeenCalled();
    h.feed('\x04'); expect(h.onExit).toHaveBeenCalledTimes(1);
  });

  it('clears before synchronous submit callbacks and coalesces CRLF', () => {
    const h = harness();
    h.onSubmit.mockImplementation(() => { expect(h.input.line).toBe(''); h.input.prompt(); });
    h.feed('value\r', '\n'); expect(h.onSubmit).toHaveBeenCalledTimes(1);
  });

  it('owns one listener/raw mode, restores on pause/detach, and retains hidden drafts', () => {
    const h = harness(); h.input.attach(); expect(h.stdin.listenerCount('data')).toBe(1);
    expect(h.stdin.isRaw).toBe(true); h.input.setValue('draft'); h.input.hide(); expect(h.input.line).toBe('draft');
    h.input.prompt(); h.input.pause(); h.input.pause(); expect(h.stdin.isRaw).toBe(false); expect(h.input.paused).toBe(true);
    h.feed('ignored'); expect(h.input.line).toBe('draft');
    h.input.resume(); h.input.resume(); expect(h.stdin.isRaw).toBe(true); expect(h.input.paused).toBe(false);
    h.input.detach(); h.input.detach(); expect(h.stdin.listenerCount('data')).toBe(0); expect(h.stdin.isRaw).toBe(false);
    expect(h.writes.join('')).toContain('\x1b[?2004h'); expect(h.writes.join('')).toContain('\x1b[?2004l');
    h.input.attach(); h.input.prompt(); h.feed('!'); expect(h.input.line).toBe('draft!');
  });

  it('keeps the draft visible while streaming and bounds tiny-terminal/menu redraws', () => {
    const h = harness([], Array.from({ length: 30 }, (_, i) => ({ name: `command${i}`, description: '', run: () => {} })));
    h.input.setValue('draft'); h.surface.setLive(['stream']); expect(h.writes.at(-1)).toContain('draft');
    h.size.rows = 7; h.input.setValue('/'); h.input.refresh();
    const clear = new RegExp(`${String.fromCharCode(27)}\\[2K`, 'g');
    expect((h.writes.at(-1)!.match(clear) ?? []).length).toBeLessThanOrEqual(10);
    h.surface.resize(); h.input.refresh();
    expect((h.writes.at(-1)!.match(clear) ?? []).length).toBeLessThanOrEqual(5);
    h.size.cols = 3; h.size.rows = 3; h.input.setValue('界界'); h.surface.resize(); h.input.refresh();
    expect(h.writes.at(-1)).not.toContain('\x1b[2J');
  });
});
