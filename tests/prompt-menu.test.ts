/**
 * v0.7 prompt-menu tests.
 *
 * Pure core: slash-command filtering (exact → prefix → substring), the
 * trigger computation, the @path listing (ranking, dirs, images, cap,
 * dotfiles, escapes), the menu state machine, row rendering, and the
 * below-prompt renderer's exact byte sequences.
 *
 * Integration: the PromptRouter driven against a REAL readline over a
 * PassThrough wire — the same wiring the REPL uses on a capable TTY — plus
 * the /model picker's raw-mode loop, and the TTY-only capability gate.
 */

import { afterAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import {
  MenuModel,
  MenuRenderer,
  PromptRouter,
  computeMenuTrigger,
  escapePathForInsert,
  filterSlashCommands,
  listPathMenu,
  pickFromList,
  promptMenuCapable,
  renderMenuRows,
  slashCommandItem,
  slashHelpLine,
  unescapePathToken,
  type SlashCommand,
} from '../src/ui/promptmenu.js';
import { themeFor } from '../src/ui/theme.js';

const plain = themeFor('mono', false); // level 0: styling is the identity
const vivid = themeFor('galaxy', true, { COLORTERM: 'truecolor' }); // level 3

// A small registry mirroring the REPL's command set (byte-identity of the
// real registry is pinned in tests/chat.test.ts through the REPL itself).
const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'show this list', run: () => {} },
  {
    name: 'model',
    argsHint: '[id]',
    description: 'show or switch the model (verified before switching)',
    run: () => {},
  },
  {
    name: 'theme',
    argsHint: '[name]',
    description: 'show or switch the UI theme (galaxy, nebula, aurora, mono)',
    run: () => {},
  },
  { name: 'clear', description: 'clear the conversation history', run: () => {} },
  { name: 'tools', description: 'list the agent tools available this session', run: () => {} },
  { name: 'permissions', description: 'show what is auto-allowed this session', run: () => {} },
  { name: 'cost', description: 'session totals (requests, tokens, cost)', run: () => {} },
  { name: 'exit', description: 'end the session (Ctrl+D also works)', run: () => 'exit' },
];

const names = (cmds: readonly SlashCommand[]): string[] => cmds.map((c) => c.name);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ---------------------------------------------------------------------------
// the registry's pure helpers
// ---------------------------------------------------------------------------

describe('slash registry helpers', () => {
  it('slashHelpLine formats with and without the args hint', () => {
    expect(slashHelpLine(COMMANDS[0]!)).toBe('/help — show this list');
    expect(slashHelpLine(COMMANDS[1]!)).toBe(
      '/model [id] — show or switch the model (verified before switching)',
    );
  });

  it('filter: empty returns the registry order', () => {
    expect(names(filterSlashCommands(COMMANDS, ''))).toEqual(names(COMMANDS));
  });

  it('filter: case-insensitive prefix, then substring', () => {
    expect(names(filterSlashCommands(COMMANDS, 'cl'))).toEqual(['clear']);
    expect(names(filterSlashCommands(COMMANDS, 'CL'))).toEqual(['clear']);
    // 'e' is a prefix of exit, substring of several — prefix group first
    const ranked = names(filterSlashCommands(COMMANDS, 'e'));
    expect(ranked[0]).toBe('exit');
    expect(ranked.slice(1)).toContain('help'); // substring group
    expect(ranked.slice(1)).toContain('theme');
    expect(ranked).not.toContain('cost'); // no 'e' in 'cost'
  });

  it('filter: an exact match ranks before prefix matches', () => {
    expect(names(filterSlashCommands(COMMANDS, 'model'))).toEqual(['model']);
    // 'them' is a prefix of theme only
    expect(names(filterSlashCommands(COMMANDS, 'them'))).toEqual(['theme']);
  });

  it('filter: no match → empty (the menu closes; Enter submits as typed)', () => {
    expect(filterSlashCommands(COMMANDS, 'zzz')).toEqual([]);
  });

  it('slashCommandItem: insert is the bare command, label carries the hint', () => {
    const item = slashCommandItem(COMMANDS[1]!);
    expect(item.label).toBe('/model [id]');
    expect(item.insert).toBe('/model');
    expect(item.hint).toBe('show or switch the model (verified before switching)');
    expect(item.kind).toBe('command');
  });
});

// ---------------------------------------------------------------------------
// the trigger
// ---------------------------------------------------------------------------

describe('computeMenuTrigger', () => {
  it('a leading / with no whitespace is a slash filter', () => {
    expect(computeMenuTrigger('/', 1)).toEqual({ kind: 'slash', filter: '', tokenStart: 0 });
    expect(computeMenuTrigger('/cl', 3)).toEqual({ kind: 'slash', filter: 'cl', tokenStart: 0 });
  });

  it('a space ends the slash filter (args zone)', () => {
    expect(computeMenuTrigger('/theme neb', 10)).toBeNull();
  });

  it('the menu lives at the end of the line only', () => {
    expect(computeMenuTrigger('/cl', 1)).toBeNull();
  });

  it('an @-token anywhere in the line is a path trigger', () => {
    expect(computeMenuTrigger('@', 1)).toEqual({ kind: 'path', filter: '', tokenStart: 0 });
    expect(computeMenuTrigger('look @sr', 8)).toEqual({
      kind: 'path',
      filter: 'sr',
      tokenStart: 5,
    });
  });

  it('escaped whitespace inside an @-token stays in the filter, unescaped', () => {
    expect(computeMenuTrigger('look @my\\ sh', 12)).toEqual({
      kind: 'path',
      filter: 'my sh',
      tokenStart: 5,
    });
  });

  it('\\@ is a literal at-sign, never a trigger', () => {
    expect(computeMenuTrigger('\\@foo', 5)).toBeNull();
    expect(computeMenuTrigger('a@b', 3)).toBeNull(); // token does not START with @
    expect(computeMenuTrigger('', 0)).toBeNull();
    expect(computeMenuTrigger('hello', 5)).toBeNull();
  });
});

describe('path token escaping', () => {
  it('round-trips spaces, backslashes, quotes and at-signs', () => {
    expect(unescapePathToken('my\\ shot.png')).toBe('my shot.png');
    expect(escapePathForInsert('my shot.png')).toBe('my\\ shot.png');
    expect(unescapePathToken(escapePathForInsert('a b\\c"d@e'))).toBe('a b\\c"d@e');
  });

  it('a backslash before a non-escapable char stays literal (Windows paths)', () => {
    expect(unescapePathToken('C:\\shots\\a.png')).toBe('C:\\shots\\a.png');
    expect(escapePathForInsert('C:\\shots\\a.png')).toBe('C:\\\\shots\\\\a.png');
    expect(unescapePathToken(escapePathForInsert('C:\\shots\\a.png'))).toBe('C:\\shots\\a.png');
  });
});

// ---------------------------------------------------------------------------
// the @path listing
// ---------------------------------------------------------------------------

const lsDirs: string[] = [];
function lsRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-menu-'));
  lsDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of lsDirs) rmSync(d, { recursive: true, force: true });
});

describe('listPathMenu', () => {
  it('lists prefix matches first (dirs before files), then substring matches', () => {
    const root = lsRoot();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'shot.png'), 'x');
    writeFileSync(join(root, 'notes-src.txt'), 'x');
    writeFileSync(join(root, 'alpha.md'), 'x');
    const { items, total } = listPathMenu(root, 's');
    expect(total).toBe(3);
    expect(items.map((i) => i.label)).toEqual(['src/', 'shot.png', 'notes-src.txt']);
    expect(items[0]!.kind).toBe('dir');
    expect(items[1]!.kind).toBe('image');
    expect(items[2]!.kind).toBe('file');
    expect(items[0]!.insert).toBe('@src/');
  });

  it('an empty filter lists everything; dotfiles stay hidden until the base starts with .', () => {
    const root = lsRoot();
    writeFileSync(join(root, 'a.txt'), 'x');
    writeFileSync(join(root, '.secret'), 'x');
    expect(listPathMenu(root, '').items.map((i) => i.label)).toEqual(['a.txt']);
    // base '.' unhides dotfiles; '.secret' prefix-matches, 'a.txt' only
    // substring-matches (the dot before txt) — prefix ranks first
    expect(listPathMenu(root, '.').items.map((i) => i.label)).toEqual(['.secret', 'a.txt']);
  });

  it('a dir filter lists one level deeper, and inserts the joined path', () => {
    const root = lsRoot();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, join('src', 'deep')));
    writeFileSync(join(root, join('src', 'cat.jpg')), 'x');
    const { items } = listPathMenu(root, 'src/');
    expect(items.map((i) => i.label)).toEqual(['deep/', 'cat.jpg']);
    expect(items[1]!.insert).toBe('@src/cat.jpg');
    expect(items[1]!.kind).toBe('image');
    // and the base still filters within the deeper dir
    expect(listPathMenu(root, 'src/ca').items.map((i) => i.label)).toEqual(['cat.jpg']);
  });

  it('caps the listing and reports the overflow total', () => {
    const root = lsRoot();
    for (let i = 0; i < 20; i += 1)
      writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x');
    const { items, total } = listPathMenu(root, '');
    expect(items.length).toBe(12);
    expect(total).toBe(20);
  });

  it('escapes spaces in the insert text so the tokenizer reads one token', () => {
    const root = lsRoot();
    writeFileSync(join(root, 'my shot.png'), 'x');
    const { items } = listPathMenu(root, 'my');
    expect(items[0]!.insert).toBe('@my\\ shot.png');
  });

  it('a missing directory lists nothing (never throws)', () => {
    const root = lsRoot();
    expect(listPathMenu(root, 'nope/deeper')).toEqual({ items: [], total: 0 });
  });
});

// ---------------------------------------------------------------------------
// the menu state machine
// ---------------------------------------------------------------------------

describe('MenuModel', () => {
  const items = [
    { label: 'a', insert: '/a', kind: 'command' as const },
    { label: 'b', insert: '/b', kind: 'command' as const },
    { label: 'c', insert: '/c', kind: 'command' as const },
  ];

  it('open selects the first item; move wraps in both directions', () => {
    const m = new MenuModel();
    expect(m.isOpen).toBe(false);
    m.open('slash', items, 3, 0);
    expect(m.selection).toBe(0);
    m.move(1);
    expect(m.current?.insert).toBe('/b');
    m.move(1);
    m.move(1); // wraps
    expect(m.current?.insert).toBe('/a');
    m.move(-1); // wraps back
    expect(m.current?.insert).toBe('/c');
  });

  it('update keeps the selection on the same insert when still listed, else clamps', () => {
    const m = new MenuModel();
    m.open('slash', items, 3, 0);
    m.move(2); // '/c'
    m.update([items[2]!, items[0]!], 2, 0); // '/c' still present at index 0
    expect(m.current?.insert).toBe('/c');
    m.update([items[1]!], 1, 0); // '/c' gone
    expect(m.selection).toBe(0);
    expect(m.current?.insert).toBe('/b');
  });

  it('close resets everything', () => {
    const m = new MenuModel();
    m.open('slash', items, 3, 0);
    m.close();
    expect(m.isOpen).toBe(false);
    expect(m.rows).toEqual([]);
    expect(m.current).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// row rendering
// ---------------------------------------------------------------------------

describe('renderMenuRows', () => {
  it('renders the ❯ marker on the selected row, hints dim, and the key hint last', () => {
    const m = new MenuModel();
    const items = COMMANDS.slice(0, 3).map(slashCommandItem);
    m.open('slash', items, 3, 0);
    m.move(1);
    const rows = renderMenuRows(m, plain, 100);
    expect(rows).toEqual([
      '  /help — show this list',
      '❯ /model [id] — show or switch the model (verified before switching)',
      '  /theme [name] — show or switch the UI theme (galaxy, nebula, aurora, mono)',
      '  ↑/↓ choose · Tab/Enter run · Esc close',
    ]);
  });

  it('path rows carry the dir slash and the completion key hint', () => {
    const m = new MenuModel();
    m.open(
      'path',
      [
        { label: 'src/', insert: '@src/', kind: 'dir' },
        { label: 'shot.png', insert: '@shot.png', kind: 'image' },
      ],
      2,
      5,
    );
    const rows = renderMenuRows(m, plain, 100);
    expect(rows[0]).toBe('❯ src/');
    expect(rows[1]).toBe('  shot.png');
    expect(rows[2]).toBe('  ↑/↓ choose · Tab/Enter complete · Esc close');
  });

  it('the overflow row reports hidden matches', () => {
    const m = new MenuModel();
    const items = Array.from({ length: 12 }, (_, i) => ({
      label: `f${i}.txt`,
      insert: `@f${i}.txt`,
      kind: 'file' as const,
    }));
    m.open('path', items, 20, 0);
    const rows = renderMenuRows(m, plain, 100);
    expect(rows[12]).toBe('  +8 more — keep typing');
    expect(rows.length).toBe(14); // 12 items + overflow + key hint
  });

  it('the hint shrinks (then drops) to keep rows within the width budget', () => {
    const m = new MenuModel();
    m.open('slash', [slashCommandItem(COMMANDS[1]!)], 1, 0);
    const wide = renderMenuRows(m, plain, 100);
    expect(wide[0]).toContain('— show or switch');
    const narrow = renderMenuRows(m, plain, 20);
    expect(Array.from(narrow[0]!).length).toBeLessThanOrEqual(20);
    const tiny = renderMenuRows(m, plain, 12); // no room for any hint
    expect(tiny[0]).toBe('❯ /model [id]');
  });

  it('styles come from the theme: vivid rows carry SGR escapes, mono is plain', () => {
    const m = new MenuModel();
    m.open('slash', [slashCommandItem(COMMANDS[0]!)], 1, 0);
    const colored = renderMenuRows(m, vivid, 100);
    expect(colored[0]).toContain('\x1b[');
    expect(colored[0]).toContain('❯');
    const mono = renderMenuRows(m, plain, 100);
    expect(mono[0]).not.toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// the below-prompt renderer (exact byte sequences)
// ---------------------------------------------------------------------------

describe('MenuRenderer', () => {
  it('draws by reserving rows, painting, and restoring the input cursor', () => {
    let out = '';
    const renderer = new MenuRenderer(
      (s) => {
        out += s;
      },
      () => 5,
    );
    renderer.draw(['a', 'b']);
    expect(out).toBe(
      '\n\n' + // reserve 2 rows
        '\x1b[2A' + // back to the input row
        '\x1b[1B\r\x1b[2Ka' +
        '\x1b[1B\r\x1b[2Kb' +
        '\x1b[2A\r' + // return to the input row
        '\x1b[5C', // and the input column
    );
    expect(renderer.drawnRows).toBe(2);
  });

  it('grows, shrinks, and clears without absolute positioning', () => {
    let out = '';
    const renderer = new MenuRenderer(
      (s) => {
        out += s;
      },
      () => 0, // cursor at column 0 → no horizontal restore
    );
    renderer.draw(['a', 'b']);
    out = '';
    renderer.draw(['a', 'b', 'c']); // grow by one
    expect(out).toBe(
      '\x1b[2B' + // to the bottom of the old block
        '\n' + // reserve one more
        '\x1b[3A' +
        '\x1b[1B\r\x1b[2Ka' +
        '\x1b[1B\r\x1b[2Kb' +
        '\x1b[1B\r\x1b[2Kc' +
        '\x1b[3A\r',
    );
    out = '';
    renderer.draw(['a']); // shrink by two: repaint one, clear one, leave none stale
    expect(out).toBe('\x1b[1B\r\x1b[2Ka' + '\x1b[1B\r\x1b[2K' + '\x1b[1B\r\x1b[2K' + '\x1b[3A\r');
    out = '';
    renderer.clear();
    expect(out).toBe('\x1b[1B\r\x1b[2K' + '\x1b[1A\r');
    expect(renderer.drawnRows).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// the capability gate
// ---------------------------------------------------------------------------

describe('promptMenuCapable', () => {
  const yes = {
    json: false,
    stdinIsTTY: true,
    stdoutIsTTY: true,
    stdinRawCapable: true,
    env: {} as NodeJS.ProcessEnv,
  };
  it('needs a TTY on both ends, raw mode, no --json, and colors allowed', () => {
    expect(promptMenuCapable(yes)).toBe(true);
    expect(promptMenuCapable({ ...yes, json: true })).toBe(false);
    expect(promptMenuCapable({ ...yes, stdinIsTTY: false })).toBe(false);
    expect(promptMenuCapable({ ...yes, stdoutIsTTY: false })).toBe(false);
    expect(promptMenuCapable({ ...yes, stdinRawCapable: false })).toBe(false);
    expect(promptMenuCapable({ ...yes, env: { NO_COLOR: '' } })).toBe(false);
    expect(promptMenuCapable({ ...yes, env: { NO_COLOR: '1' } })).toBe(false);
    expect(promptMenuCapable({ ...yes, env: { TERM: 'dumb' } })).toBe(false);
    expect(promptMenuCapable({ ...yes, env: { TERM: 'xterm-256color' } })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// the router against a real readline
// ---------------------------------------------------------------------------

interface RouterHarness {
  stdin: PassThrough;
  rl: readline.Interface;
  router: PromptRouter;
  lines: string[];
  echo(): string;
  menuOut(): string;
  menuDraws(): number;
  shiftTabs(): number;
  sigints(): number;
  setPromptActive(v: boolean): void;
}

function makeRouter(opts: { cwd: string; promptActive?: boolean; cols?: number }): RouterHarness {
  const stdin = new PassThrough();
  const wire = new PassThrough();
  let echoOut = '';
  const echo = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      echoOut += chunk.toString();
      cb();
    },
  });
  const rl = readline.createInterface({ input: wire, output: echo, terminal: true });
  rl.setPrompt('❯ ');
  const lines: string[] = [];
  rl.on('line', (l) => lines.push(l));
  let menuText = '';
  let draws = 0;
  let active = opts.promptActive ?? true;
  let shiftTabCount = 0;
  let sigintCount = 0;
  rl.on('SIGINT', () => {
    sigintCount += 1;
  });
  const router = new PromptRouter({
    stdin,
    rl,
    wire,
    isPromptActive: () => active,
    onShiftTab: () => {
      shiftTabCount += 1;
    },
    slashCommands: () => COMMANDS,
    cwd: opts.cwd,
    write: (s) => {
      menuText += s;
      draws += 1;
    },
    theme: () => plain,
    cols: () => opts.cols ?? 100,
  });
  router.attach();
  return {
    stdin,
    rl,
    router,
    lines,
    echo: () => echoOut,
    menuOut: () => menuText,
    menuDraws: () => draws,
    shiftTabs: () => shiftTabCount,
    sigints: () => sigintCount,
    setPromptActive: (v) => {
      active = v;
    },
  };
}

describe('PromptRouter (real readline over a wire)', () => {
  it('typing / opens the menu; filtering narrows it; Enter executes the selection', async () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.rows.length).toBe(COMMANDS.length);
    expect(h.menuOut()).toContain('/help — show this list');
    expect(h.menuOut()).toContain('↑/↓ choose · Tab/Enter run · Esc close');
    h.stdin.write('cl');
    expect(h.router.menu.rows.map((i) => i.insert)).toEqual(['/clear']);
    h.stdin.write('\r');
    expect(h.lines).toEqual(['/clear']);
    expect(h.router.menu.isOpen).toBe(false);
    h.router.detach();
  });

  it('arrows move the highlight (wrapping); the selected command runs', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/');
    h.stdin.write('\x1b[B'); // down → /model
    expect(h.router.menu.current?.insert).toBe('/model');
    h.stdin.write('\x1b[A'); // up → wraps back to /help
    expect(h.router.menu.current?.insert).toBe('/help');
    // batched keypresses in one chunk (a fast typist) both land
    h.stdin.write('\x1b[B\x1b[B');
    expect(h.router.menu.current?.insert).toBe('/theme');
    h.stdin.write('\r');
    expect(h.lines).toEqual(['/theme']);
    h.router.detach();
  });

  it('a split escape sequence still navigates (the hold buffer reassembles it)', async () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/');
    h.stdin.write('\x1b');
    await sleep(10); // before the 50ms hold expires…
    h.stdin.write('[B');
    expect(h.router.menu.current?.insert).toBe('/model');
    h.router.detach();
  });

  it('v0.9: a multibyte character split across chunks reassembles (no U+FFFD garbage)', () => {
    const h = makeRouter({ cwd: process.cwd() });
    const star = Buffer.from('✦', 'utf8'); // 3 bytes: E2 9C A6
    h.stdin.write(star.subarray(0, 1)); // an incomplete tail is held, not garbled
    expect(h.rl.line).toBe('');
    h.stdin.write(star.subarray(1));
    expect(h.rl.line).toBe('✦');
    h.stdin.write('\r');
    expect(h.lines).toEqual(['✦']);
    h.router.detach();
  });

  it('Tab executes the highlighted command like Enter does', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/to');
    expect(h.router.menu.current?.insert).toBe('/tools');
    h.stdin.write('\t');
    expect(h.lines).toEqual(['/tools']);
    h.router.detach();
  });

  it('an exact match + Enter runs the typed command directly', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/cost');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.current?.insert).toBe('/cost');
    h.stdin.write('\r');
    expect(h.lines).toEqual(['/cost']);
    h.router.detach();
  });

  it('Esc closes the menu, keeps the typed text, and latches until the line submits', async () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/th');
    expect(h.router.menu.isOpen).toBe(true);
    h.stdin.write('\x1b');
    await sleep(80); // the lone-ESC hold
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.rl.line).toBe('/th');
    // the latch: more typing does not reopen the menu on this line
    const drawsAfterEsc = h.menuDraws();
    h.stdin.write('eme');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.menuDraws()).toBe(drawsAfterEsc);
    h.stdin.write('\r');
    expect(h.lines).toEqual(['/theme']);
    h.router.detach();
  });

  it('Ctrl+C mid-menu closes the menu (not the app); the next Ctrl+C signals SIGINT', async () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/he');
    expect(h.router.menu.isOpen).toBe(true);
    h.stdin.write('\x03');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.sigints()).toBe(0);
    expect(h.lines).toEqual([]);
    h.stdin.write('\x03'); // menu closed now — forwarded → SIGINT
    expect(h.sigints()).toBe(1);
    h.router.detach();
  });

  it('shift+tab cycles modes only while the menu is closed', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('\x1b[Z');
    expect(h.shiftTabs()).toBe(1);
    h.stdin.write('/');
    h.stdin.write('\x1b[Z'); // menu owns navigation now
    expect(h.shiftTabs()).toBe(1);
    expect(h.router.menu.isOpen).toBe(true);
    h.router.detach();
  });

  it('no matches close the menu; Enter submits the typed line verbatim', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/z');
    expect(h.router.menu.isOpen).toBe(false);
    h.stdin.write('z');
    h.stdin.write('\r');
    expect(h.lines).toEqual(['/zz']);
    h.router.detach();
  });

  it('typing a space after a command closes the menu (the args zone)', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/theme');
    expect(h.router.menu.isOpen).toBe(true);
    h.stdin.write(' ');
    expect(h.router.menu.isOpen).toBe(false);
    h.stdin.write('nebula\r');
    expect(h.lines).toEqual(['/theme nebula']);
    h.router.detach();
  });

  it('the menu never opens while the prompt is inactive (typed-ahead mid-turn)', () => {
    const h = makeRouter({ cwd: process.cwd(), promptActive: false });
    h.stdin.write('/cl\r');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.lines).toEqual(['/cl']); // forwarded verbatim, menu never drawn
    expect(h.menuDraws()).toBe(0);
    h.router.detach();
  });

  it('a wrapped line closes the menu instead of corrupting the draw', () => {
    // cols 3: even '/x' (2+2) does not fit — the menu never opens
    const narrow = makeRouter({ cwd: process.cwd(), cols: 3 });
    narrow.stdin.write('/model');
    expect(narrow.router.menu.isOpen).toBe(false);
    expect(narrow.menuDraws()).toBe(0);
    narrow.router.detach();
    // cols 8: the menu opens for a short filter, then the line outgrows it
    const h = makeRouter({ cwd: process.cwd(), cols: 8 });
    h.stdin.write('/mod'); // 2+4 = 6 < 8 → open
    expect(h.router.menu.isOpen).toBe(true);
    h.stdin.write('el'); // 2+6 = 8 → wrapped: the menu closes, text untouched
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.rl.line).toBe('/model');
    h.router.detach();
  });

  it('a paused readline (the permission menu owns stdin) drops everything', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.rl.pause();
    h.stdin.write('/cl');
    expect(h.rl.line).toBe('');
    expect(h.router.menu.isOpen).toBe(false);
    h.rl.resume();
    h.stdin.write('/c');
    expect(h.rl.line).toBe('/c');
    expect(h.router.menu.isOpen).toBe(true);
    h.router.detach();
  });

  it('arrows with the menu closed reach readline (history recall still works)', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('first\r');
    h.stdin.write('\x1b[A'); // recall
    expect(h.rl.line).toBe('first');
    h.stdin.write('\r');
    expect(h.lines).toEqual(['first', 'first']);
    h.router.detach();
  });

  it('@ completes a directory (menu deepens), then a file (menu closes)', () => {
    const root = lsRoot();
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, join('src', 'deep')));
    writeFileSync(join(root, join('src', 'cat.jpg')), 'x');
    writeFileSync(join(root, 'shot.png'), 'x');
    const h = makeRouter({ cwd: root });
    h.stdin.write('look @s');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.rows.map((i) => i.label)).toEqual(['src/', 'shot.png']);
    h.stdin.write('\t'); // complete the dir → deepen
    expect(h.rl.line).toBe('look @src/');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.rows.map((i) => i.label)).toEqual(['deep/', 'cat.jpg']);
    h.stdin.write('\x1b[B'); // select cat.jpg
    h.stdin.write('\r'); // complete the file — never submits
    expect(h.rl.line).toBe('look @src/cat.jpg');
    expect(h.router.menu.isOpen).toBe(false);
    expect(h.lines).toEqual([]);
    h.stdin.write('\r'); // now submit
    expect(h.lines).toEqual(['look @src/cat.jpg']);
    h.router.detach();
  });

  it('a fully-typed existing file closes the menu — Enter submits (no eaten Enter)', () => {
    const root = lsRoot();
    writeFileSync(join(root, 'shot.png'), 'x');
    const h = makeRouter({ cwd: root });
    h.stdin.write('see @shot.png');
    // while typing, the menu filtered down; at the exact path it closes
    expect(h.router.menu.isOpen).toBe(false);
    h.stdin.write('\r');
    expect(h.lines).toEqual(['see @shot.png']);
    h.router.detach();
  });

  it('an exact file match with other (substring) matches still submits on Enter', () => {
    const root = lsRoot();
    writeFileSync(join(root, 'shot.png'), 'x');
    writeFileSync(join(root, 'shot.png.bak'), 'x');
    const h = makeRouter({ cwd: root });
    h.stdin.write('@shot.png');
    expect(h.router.menu.isOpen).toBe(true); // shot.png.bak still matches
    h.stdin.write('\r'); // the selected item IS the typed token → submit
    expect(h.lines).toEqual(['@shot.png']);
    h.router.detach();
  });

  it('a fully-typed DIRECTORY keeps the menu open (it can deepen)', () => {
    const root = lsRoot();
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, join('src', 'a.ts')), 'x');
    const h = makeRouter({ cwd: root });
    h.stdin.write('@src');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.rows[0]!.label).toBe('src/');
    h.router.detach();
  });

  it('@ listing reports the overflow and closes on a space', () => {
    const root = lsRoot();
    for (let i = 0; i < 15; i += 1)
      writeFileSync(join(root, `p${String(i).padStart(2, '0')}.png`), 'x');
    const h = makeRouter({ cwd: root });
    h.stdin.write('@');
    expect(h.router.menu.isOpen).toBe(true);
    expect(h.router.menu.rows.length).toBe(12);
    expect(h.router.menu.totalCount).toBe(15);
    expect(h.menuOut()).toContain('+3 more — keep typing');
    h.stdin.write(' '); // a space ends the token → menu closes
    expect(h.router.menu.isOpen).toBe(false);
    h.router.detach();
  });

  it('echo still flows for ordinary typing while the menu is open', () => {
    const h = makeRouter({ cwd: process.cwd() });
    h.stdin.write('/cl');
    expect(h.echo()).toBe('/cl'); // readline echoed each char to the echo stream
    h.router.detach();
  });
});

// ---------------------------------------------------------------------------
// the one-shot picker (the /model list)
// ---------------------------------------------------------------------------

describe('pickFromList', () => {
  function pickerIo(stdin: PassThrough): {
    io: Parameters<typeof pickFromList>[3];
    out(): string;
    pauses(): number;
    resumes(): number;
  } {
    let out = '';
    let pauses = 0;
    let resumes = 0;
    return {
      io: {
        stdin,
        write: (s) => {
          out += s;
        },
        pauseInput: () => {
          pauses += 1;
        },
        resumeInput: () => {
          resumes += 1;
        },
        theme: plain,
      },
      out: () => out,
      pauses: () => pauses,
      resumes: () => resumes,
    };
  }

  const MODELS = [
    { label: 'glm-5.3-flash', hint: 'GLM 5.3 Flash' },
    { label: 'gpt-5.2-mini', hint: 'GPT 5.2 Mini' },
    { label: 'k3', hint: undefined },
  ];

  it('arrows move and Enter resolves the index; the editor is paused for the duration', async () => {
    const stdin = new PassThrough();
    const h = pickerIo(stdin);
    const picked = pickFromList('Select a model', MODELS, 0, h.io);
    expect(h.pauses()).toBe(1);
    expect(h.out()).toContain('Select a model');
    expect(h.out()).toContain('❯ glm-5.3-flash — GLM 5.3 Flash');
    stdin.write('\x1b[B');
    stdin.write('\r');
    await expect(picked).resolves.toBe(1);
    expect(h.resumes()).toBe(1);
  });

  it('the initial selection lands on the current model', async () => {
    const stdin = new PassThrough();
    const h = pickerIo(stdin);
    const picked = pickFromList('Select a model', MODELS, 2, h.io);
    expect(h.out()).toContain('❯ k3');
    stdin.write('\r');
    await expect(picked).resolves.toBe(2);
  });

  it('Esc and Ctrl+C resolve null (keep current); stdin end resolves null', async () => {
    const escStdin = new PassThrough();
    const escPicked = pickFromList('t', MODELS, 0, pickerIo(escStdin).io);
    escStdin.write('\x1b');
    await expect(escPicked).resolves.toBeNull();

    const ctrlCStdin = new PassThrough();
    const ctrlCPicked = pickFromList('t', MODELS, 0, pickerIo(ctrlCStdin).io);
    ctrlCStdin.write('\x03');
    await expect(ctrlCPicked).resolves.toBeNull();

    const endStdin = new PassThrough();
    const endPicked = pickFromList('t', MODELS, 0, pickerIo(endStdin).io);
    endStdin.end();
    await expect(endPicked).resolves.toBeNull();
  });
});
