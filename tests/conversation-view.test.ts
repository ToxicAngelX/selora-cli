/**
 * tests/conversation-view.test.ts — the tool-call display lifecycle in the
 * terminal-surface chat UI: the header sits DIM in the live region while a
 * tool runs and commits with the outcome-colored ● at the result; the flat
 * file-change diff renders under it; ctrl+r (PromptInput onExpand) toggles
 * the collapsed/expanded body and yields to history search when there is
 * nothing to expand.
 */

import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationView } from '../src/ui/conversation-view.js';
import { PromptInput } from '../src/ui/prompt-input.js';
import { TerminalSurface } from '../src/ui/terminal-surface.js';
import { themeFor } from '../src/ui/theme.js';
import type { AgentEvent } from '../src/agent/loop.js';

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;:?]*[a-zA-Z~]`, 'g');
const strip = (s: string): string => s.replace(ANSI_RE, '');

const views: ConversationView[] = [];
const inputs: PromptInput[] = [];
afterEach(() => {
  for (const v of views.splice(0)) v.dispose();
  for (const i of inputs.splice(0)) i.detach();
});

function harness(color = false) {
  const writes: string[] = [];
  const size = { cols: 80, rows: 24 };
  const surface = new TerminalSurface({
    write: (s) => writes.push(s),
    cols: () => size.cols,
    rows: () => size.rows,
  });
  const theme = color
    ? themeFor('galaxy', true, { COLORTERM: 'truecolor' })
    : themeFor('galaxy', false, {});
  const view = new ConversationView(surface, () => theme, () => size.cols, {
    diffPalette: 'classic',
  });
  views.push(view);
  return { writes, size, surface, view, theme, text: () => strip(writes.join('')) };
}

const start: AgentEvent = { type: 'assistant-start', id: 'a1', turn: 1 };
const toolStart = (name: string, label: string): AgentEvent => ({
  type: 'tool-start',
  id: 't1',
  callId: 'c1',
  name,
  label,
});
const toolResult = (
  name: string,
  label: string,
  extra: Partial<Extract<AgentEvent, { type: 'tool-result' }>> = {},
): AgentEvent => ({
  type: 'tool-result',
  id: 't1',
  callId: 'c1',
  name,
  label,
  kind: 'write',
  ok: true,
  summary: 'done',
  ...extra,
});

describe('ConversationView — tool display lifecycle', () => {
  it('the header is dim while running, green + result line + flat diff at the result', () => {
    const h = harness(true);
    h.view.event(start);
    h.view.event(toolStart('write_file', 'write_file(src/a.ts)'));
    const running = h.writes.join('');
    // dim gray ● in the live region, no success green anywhere yet
    expect(strip(running)).toContain('● Write(src/a.ts)');
    expect(running).toContain('38;2;107;114;128');
    expect(running).not.toContain('38;2;52;211;153');
    expect(strip(running)).not.toContain('Wrote');

    h.view.event(
      toolResult('write_file', 'write_file(src/a.ts)', {
        summary: 'wrote src/a.ts (12 B)',
        diffPayload: { before: '', after: 'one\ntwo\n', path: 'src/a.ts', kind: 'created' },
      }),
    );
    const all = h.writes.join('');
    // committed: green ● header, computed result line, numbered + rows
    expect(all).toContain('38;2;52;211;153');
    expect(h.text()).toContain('⎿  Wrote 2 lines to src/a.ts');
    expect(h.text()).toContain('1 + one');
    expect(h.text()).toContain('2 + two');
    h.view.finish();
  });

  it('a failed tool result commits a red ● and keeps the error summary', () => {
    const h = harness(true);
    h.view.event(start);
    h.view.event(toolStart('write_file', 'write_file(src/a.ts)'));
    h.view.event(
      toolResult('write_file', 'write_file(src/a.ts)', { ok: false, summary: 'denied by user' }),
    );
    const all = h.writes.join('');
    expect(all).toContain('38;2;251;113;133'); // error red ●
    expect(h.text()).toContain('⎿ denied by user');
    h.view.finish();
  });

  it('ctrl+r toggles the elided body: full rows, then the compact view again', () => {
    const h = harness(false);
    const big = Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
    h.view.event(start);
    h.view.event(toolStart('write_file', 'write_file(f.ts)'));
    h.view.event(
      toolResult('write_file', 'write_file(f.ts)', {
        diffPayload: { before: '', after: big, path: 'f.ts', kind: 'created' },
      }),
    );
    expect(h.text()).toContain('… +4 lines (ctrl+r to expand)');
    expect(h.text()).not.toContain('14 + line 14');

    expect(h.view.toggleLastChange()).toBe(true);
    expect(h.text()).toContain('14 + line 14'); // expanded

    expect(h.view.toggleLastChange()).toBe(true); // back to the compact view
    const compactViews = h.text().match(/… \+4 lines/g) ?? [];
    expect(compactViews.length).toBeGreaterThanOrEqual(2);
    h.view.finish();
  });

  it('toggleLastChange returns false when nothing is elided (ctrl+r falls back)', () => {
    const h = harness(false);
    h.view.event(start);
    h.view.event(toolStart('write_file', 'write_file(f.ts)'));
    h.view.event(
      toolResult('write_file', 'write_file(f.ts)', {
        diffPayload: { before: '', after: 'tiny\n', path: 'f.ts', kind: 'created' },
      }),
    );
    expect(h.view.toggleLastChange()).toBe(false);
    h.view.finish();
  });
});

describe('PromptInput — ctrl+r precedence', () => {
  function promptHarness(onExpand: () => boolean, history: string[] = []) {
    const stdin = new PassThrough() as PassThrough & {
      isRaw: boolean;
      setRawMode: ReturnType<typeof vi.fn>;
    };
    stdin.isRaw = false;
    stdin.setRawMode = vi.fn((raw: boolean) => {
      stdin.isRaw = raw;
    });
    const size = { cols: 40, rows: 12 };
    const surface = new TerminalSurface({
      write: () => {},
      cols: () => size.cols,
      rows: () => size.rows,
    });
    const input = new PromptInput({
      stdin,
      surface,
      theme: () => themeFor('mono', true, {}),
      cols: () => size.cols,
      rows: () => size.rows,
      footer: () => [],
      commands: () => [],
      history: () => history,
      cwd: '/tmp',
      onSubmit: () => {},
      onInterrupt: () => {},
      onExit: () => {},
      onMode: () => {},
      onExpand,
    });
    inputs.push(input);
    input.attach();
    input.prompt();
    return { input, feed: (s: string) => stdin.emit('data', s) };
  }

  it('ctrl+r is consumed by an expandable diff — history search stays closed', () => {
    const onExpand = vi.fn(() => true);
    const h = promptHarness(onExpand, ['older prompt']);
    h.input.setValue('draft');
    h.feed('\x12');
    expect(onExpand).toHaveBeenCalledTimes(1);
    // searchHistory() would have cleared the draft and opened the menu
    expect(h.input.line).toBe('draft');
  });

  it('ctrl+r falls back to history search when there is nothing to expand', () => {
    const onExpand = vi.fn(() => false);
    const h = promptHarness(onExpand, ['older prompt']);
    h.input.setValue('draft');
    h.feed('\x12');
    expect(onExpand).toHaveBeenCalledTimes(1);
    // searchHistory opened: the draft is stashed and the buffer cleared
    expect(h.input.line).toBe('');
  });
});
