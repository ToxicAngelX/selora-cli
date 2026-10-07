/**
 * Ctrl+R history search (v0.9). Three layers:
 *
 *  1. the collector (agent/session/history.ts): the newest-first deduped pool
 *     — the live session's sent prompts lead, then every persisted session of
 *     the project (the store `selora resume` reads), newest update first,
 *     each session's messages newest-first. Multiline/empty texts are
 *     dropped, malformed files skipped, the pool capped.
 *  2. the pure filter (promptmenu.filterHistoryItems): case-insensitive
 *     substring, pool order preserved, display capped with an honest total.
 *  3. the PromptRouter integration against a REAL readline over a wire: Ctrl+R
 *     opens the search (the typed line is stashed), typing filters, arrows
 *     move, Enter INSERTS without sending, Esc restores the stash, an empty
 *     pool makes the key inert, and a mid-turn prompt never opens it.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import {
  collectPromptHistory,
  promptTextFromMessage,
} from '../src/agent/session/history.js';
import { SESSION_VERSION, sessionsDir, type StoredSession } from '../src/agent/session/store.js';
import { filterHistoryItems, PromptRouter, type SlashCommand } from '../src/ui/promptmenu.js';
import { themeFor } from '../src/ui/theme.js';
import type { ChatMessage } from '../src/api/endpoints/chat.js';

const plain = themeFor('mono', false);

const tempRoots: string[] = [];
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-hist-'));
  tempRoots.push(d);
  return d;
}

afterAll(() => {
  for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

/** Write a session file by hand (fixed updatedAt → deterministic ordering). */
function writeSession(root: string, name: string, updatedAt: string, messages: ChatMessage[]): void {
  const body: StoredSession = {
    version: SESSION_VERSION,
    name,
    model: 'test-model',
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt,
    messages,
  };
  mkdirSync(sessionsDir(root), { recursive: true });
  writeFileSync(join(sessionsDir(root), `${name}.json`), `${JSON.stringify(body)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// promptTextFromMessage
// ---------------------------------------------------------------------------

describe('promptTextFromMessage', () => {
  it('extracts plain user text; non-user roles yield null', () => {
    expect(promptTextFromMessage({ role: 'user', content: 'hello' })).toBe('hello');
    expect(promptTextFromMessage({ role: 'assistant', content: 'hi there' })).toBeNull();
    expect(promptTextFromMessage({ role: 'tool', tool_call_id: 'c1', content: 'x' })).toBeNull();
  });

  it('multimodal user messages yield their text parts (image parts drop)', () => {
    expect(
      promptTextFromMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'compare these' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      }),
    ).toBe('compare these');
  });

  it('empty, whitespace, and multi-line texts are not searchable', () => {
    expect(promptTextFromMessage({ role: 'user', content: '   ' })).toBeNull();
    expect(promptTextFromMessage({ role: 'user', content: 'line1\nline2' })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// collectPromptHistory
// ---------------------------------------------------------------------------

describe('collectPromptHistory', () => {
  it('live prompts lead (newest first), then disk sessions newest-first, deduped', () => {
    const root = tempRoot();
    writeSession(root, 'older', '2026-10-01T00:00:00.000Z', [
      { role: 'user', content: 'older prompt' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'shared prompt' },
    ]);
    writeSession(root, 'newer', '2026-10-02T00:00:00.000Z', [
      { role: 'user', content: 'newer disk prompt' },
      { role: 'assistant', content: 'answer' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'with image' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    const pool = collectPromptHistory(root, ['current one', 'current two']);
    expect(pool).toEqual([
      'current two',
      'current one',
      'with image',
      'newer disk prompt',
      'shared prompt',
      'older prompt',
    ]);
  });

  it('dedupes across the live session and disk (the newest occurrence wins)', () => {
    const root = tempRoot();
    writeSession(root, 'a', '2026-10-01T00:00:00.000Z', [
      { role: 'user', content: 'same question' },
    ]);
    const pool = collectPromptHistory(root, ['same question', 'other']);
    expect(pool).toEqual(['other', 'same question']);
    expect(pool.filter((p) => p === 'same question')).toHaveLength(1);
  });

  it('skips malformed files and multiline/empty prompts; an empty store yields just the live pool', () => {
    const root = tempRoot();
    mkdirSync(sessionsDir(root), { recursive: true });
    writeFileSync(join(sessionsDir(root), 'broken.json'), '{oops\n', 'utf8');
    writeSession(root, 'mixed', '2026-10-01T00:00:00.000Z', [
      { role: 'user', content: 'multi\nline prompt' },
      { role: 'user', content: '' },
      { role: 'user', content: 'kept' },
    ]);
    expect(collectPromptHistory(root, [])).toEqual(['kept']);
    const empty = tempRoot();
    expect(collectPromptHistory(empty, ['just', 'live'])).toEqual(['live', 'just']);
  });

  it('honors the pool cap', () => {
    const root = tempRoot();
    const prompts = Array.from({ length: 10 }, (_, i) => `p${i}`);
    expect(collectPromptHistory(root, prompts, 3)).toEqual(['p9', 'p8', 'p7']);
  });
});

// ---------------------------------------------------------------------------
// filterHistoryItems
// ---------------------------------------------------------------------------

describe('filterHistoryItems', () => {
  const pool = ['deploy the gateway', 'restart nginx', 'deploy the frontend'];

  it('an empty filter returns the pool order, capped, with the honest total', () => {
    const listing = filterHistoryItems(pool, '', 2);
    expect(listing.items.map((i) => i.label)).toEqual(['deploy the gateway', 'restart nginx']);
    expect(listing.total).toBe(3);
    expect(listing.items[0]?.kind).toBe('history');
    expect(listing.items[0]?.insert).toBe('deploy the gateway');
  });

  it('filters case-insensitively by substring, preserving newest-first order', () => {
    expect(filterHistoryItems(pool, 'DEPLOY').items.map((i) => i.label)).toEqual([
      'deploy the gateway',
      'deploy the frontend',
    ]);
    expect(filterHistoryItems(pool, 'nginx').items.map((i) => i.label)).toEqual([
      'restart nginx',
    ]);
    expect(filterHistoryItems(pool, 'zzz').items).toEqual([]);
    expect(filterHistoryItems(pool, 'zzz').total).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the router: Ctrl+R against a real readline
// ---------------------------------------------------------------------------

const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'show this list', run: () => {} },
  { name: 'exit', description: 'end the session', run: () => 'exit' },
];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function makeHistoryRouter(opts: { pool?: string[]; promptActive?: boolean } = {}): {
  stdin: PassThrough;
  rl: readline.Interface;
  router: PromptRouter;
  lines: string[];
  menuOut(): string;
} {
  const stdin = new PassThrough();
  const wire = new PassThrough();
  const echo = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      void chunk;
      cb();
    },
  });
  const rl = readline.createInterface({ input: wire, output: echo, terminal: true });
  rl.setPrompt('❯ ');
  const lines: string[] = [];
  rl.on('line', (l) => lines.push(l));
  let menuText = '';
  const active = opts.promptActive ?? true;
  const router = new PromptRouter({
    stdin,
    rl,
    wire,
    isPromptActive: () => active,
    onShiftTab: () => {},
    slashCommands: () => COMMANDS,
    historyItems: () => opts.pool ?? [],
    cwd: process.cwd(),
    write: (s) => {
      menuText += s;
    },
    theme: () => plain,
    cols: () => 100,
  });
  router.attach();
  return { stdin, rl, router, lines, menuOut: () => menuText };
}

describe('PromptRouter — Ctrl+R history search', () => {
  it('Ctrl+R opens the search newest-first; Enter INSERTS the pick without sending', () => {
    const h = makeHistoryRouter({ pool: ['newest prompt', 'older prompt'] });
    h.stdin.write('\x12');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.menuKind).toBe('history');
    expect(h.router.menu.rows.map((i) => i.label)).toEqual(['newest prompt', 'older prompt']);
    expect(h.menuOut()).toContain('prompt history — type to filter');
    expect(h.menuOut()).toContain('↑/↓ choose · Enter insert · Esc cancel');
    h.stdin.write('\r');
    // inserted at the prompt — NOT submitted
    expect(h.rl.line).toBe('newest prompt');
    expect(h.lines).toEqual([]);
    expect(h.router.menu.isOpen).toBe(false);
    // the user reviews, then sends it themselves
    h.stdin.write('\r');
    expect(h.lines).toEqual(['newest prompt']);
    h.router.detach();
  });

  it('typing filters (case-insensitive substring); arrows move the pick', () => {
    const h = makeHistoryRouter({ pool: ['fix the tests', 'fix the build', 'ship it'] });
    h.stdin.write('\x12');
    h.stdin.write('FIX');
    expect(h.router.menu.rows.map((i) => i.label)).toEqual(['fix the tests', 'fix the build']);
    h.stdin.write('\x1b[B'); // down → second
    expect(h.router.menu.current?.insert).toBe('fix the build');
    h.stdin.write('\r');
    expect(h.rl.line).toBe('fix the build');
    expect(h.lines).toEqual([]);
    h.router.detach();
  });

  it('Esc cancels: the stashed line is restored (cursor too), nothing is sent', async () => {
    const h = makeHistoryRouter({ pool: ['some old prompt'] });
    h.stdin.write('my draft');
    expect(h.rl.line).toBe('my draft');
    h.stdin.write('\x12');
    expect(h.rl.line).toBe(''); // the line is now the search filter
    h.stdin.write('old');
    h.stdin.write('\x1b');
    await sleep(80); // the lone-ESC hold
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.rl.line).toBe('my draft');
    expect(h.lines).toEqual([]);
    h.router.detach();
  });

  it('no matches: the empty state shows, and Enter keeps the typed filter as the line', () => {
    const h = makeHistoryRouter({ pool: ['alpha'] });
    h.stdin.write('\x12');
    h.stdin.write('zzz');
    expect(h.router.menu.rows).toEqual([]);
    expect(h.menuOut()).toContain('no matches');
    h.stdin.write('\r');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.rl.line).toBe('zzz'); // what they typed is what they keep
    expect(h.lines).toEqual([]);
    h.router.detach();
  });

  it('Ctrl+C closes the search (restoring the draft) and never reaches SIGINT', () => {
    const h = makeHistoryRouter({ pool: ['old one'] });
    let sigints = 0;
    h.rl.on('SIGINT', () => {
      sigints += 1;
    });
    h.stdin.write('draft here');
    h.stdin.write('\x12');
    h.stdin.write('\x03');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.rl.line).toBe('draft here');
    expect(sigints).toBe(0);
    h.router.detach();
  });

  it('an empty pool makes Ctrl+R inert; mid-turn (prompt inactive) too', () => {
    const empty = makeHistoryRouter({ pool: [] });
    empty.stdin.write('\x12');
    expect(empty.router.menu.isOpen).toBe(false);
    expect(empty.menuOut()).toBe('');
    empty.router.detach();

    const midTurn = makeHistoryRouter({ pool: ['x'], promptActive: false });
    midTurn.stdin.write('\x12');
    expect(midTurn.router.menu.isOpen).toBe(false);
    expect(midTurn.menuOut()).toBe('');
    midTurn.router.detach();
  });

  it('Tab also inserts (never submits); a long label clamps to the width', () => {
    const long = 'x'.repeat(200);
    const h = makeHistoryRouter({ pool: [long] });
    h.stdin.write('\x12');
    const rows = h.router.menu.rows;
    expect(rows[0]?.insert).toBe(long); // the full text survives for insert
    // the DRAWN label is clamped (cols 100 → budget 97 → 96 chars + '…')
    expect(h.menuOut()).toContain(`${'x'.repeat(96)}…`);
    expect(h.menuOut()).not.toContain('x'.repeat(97));
    h.stdin.write('\t');
    expect(h.rl.line).toBe(long);
    expect(h.lines).toEqual([]);
    h.router.detach();
  });
});
