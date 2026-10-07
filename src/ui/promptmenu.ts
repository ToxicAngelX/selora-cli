/**
 * The prompt menu engine (v0.7) — the Claude-Code-style command palette for
 * the chat REPL, plus the `@<path>` file completion that shares it.
 *
 * Two halves, deliberately separate:
 *
 *  1. A PURE core — slash-command filtering (exact → prefix → substring,
 *     case-insensitive), the trigger computation (where in the typed line a
 *     `/`-command or `@`-path is being edited), filesystem listing with
 *     dir-deepening, the menu state machine, and the row renderer. No I/O:
 *     every function is unit-testable without a terminal.
 *
 *  2. The plumbing — `PromptRouter` owns the REAL stdin byte stream while the
 *     REPL is at the prompt and forwards into a PassThrough that readline
 *     treats as its input (terminal mode stays on: the keypress decoder,
 *     history, echo, SIGINT/SIGTSTP handling are all still readline's own).
 *     While the menu is open the router consumes the navigation keys
 *     (↑/↓/Tab/Enter/Esc/Ctrl+C); while it is closed every byte passes
 *     through untouched, so blind-typing `/help` works exactly as before.
 *     `MenuRenderer` draws the menu rows BELOW the prompt with relative
 *     cursor moves only (no DECSC/DECRC — those go stale when the terminal
 *     scrolls at the bottom edge).
 *
 * The whole engine is a TTY-only enhancement: non-TTY, --json, NO_COLOR,
 * TERM=dumb, and non-raw-capable stdin never construct the router — the REPL
 * wires readline straight to stdin exactly as v0.6 did.
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Interface } from 'node:readline';
import type { Theme } from './theme.js';
import { isImagePath } from '../images.js';

// ---------------------------------------------------------------------------
// slash commands (the registry — /help, the menu, and dispatch share it)
// ---------------------------------------------------------------------------

export interface SlashCommand {
  /** Command name without the leading slash ('model'). */
  name: string;
  /** One-line description (the /help text and the menu hint). */
  description: string;
  /** Optional argument hint shown after the name ('[id]'). */
  argsHint?: string | undefined;
  /**
   * Run the command. `args` is everything after the command name, trimmed
   * ('' when absent). Return 'exit' to end the REPL (/exit).
   */
  run(args: string): void | 'exit' | Promise<void | 'exit'>;
}

/** The /help line for a command — also the menu row's label + hint source. */
export function slashHelpLine(cmd: SlashCommand): string {
  const hint = cmd.argsHint !== undefined ? ` ${cmd.argsHint}` : '';
  return `/${cmd.name}${hint} — ${cmd.description}`;
}

/**
 * Rank commands against a filter (the text after `/`). Case-insensitive;
 * exact name matches first, then prefix matches, then substring matches —
 * stable within each group by registry order. An empty filter returns the
 * registry order unchanged.
 */
export function filterSlashCommands(
  commands: readonly SlashCommand[],
  filter: string,
): SlashCommand[] {
  if (filter === '') return [...commands];
  const f = filter.toLowerCase();
  const exact: SlashCommand[] = [];
  const prefix: SlashCommand[] = [];
  const substring: SlashCommand[] = [];
  for (const cmd of commands) {
    const name = cmd.name.toLowerCase();
    if (name === f) exact.push(cmd);
    else if (name.startsWith(f)) prefix.push(cmd);
    else if (name.includes(f)) substring.push(cmd);
  }
  return [...exact, ...prefix, ...substring];
}

// ---------------------------------------------------------------------------
// menu items
// ---------------------------------------------------------------------------

export type MenuItemKind = 'command' | 'dir' | 'file' | 'image';

export interface MenuItem {
  /** Display label ('/model [id]', 'src/', 'shot.png'). */
  label: string;
  /**
   * The replacement text for the trigger token when this item is selected —
   * for slash commands the whole line ('/model'), for paths the whole token
   * INCLUDING the '@' marker ('@src/sub/'), already escape-safe.
   */
  insert: string;
  /** Dim suffix after the label (the command description). */
  hint?: string | undefined;
  kind: MenuItemKind;
}

export function slashCommandItem(cmd: SlashCommand): MenuItem {
  const hint = cmd.argsHint !== undefined ? ` ${cmd.argsHint}` : '';
  return {
    label: `/${cmd.name}${hint}`,
    insert: `/${cmd.name}`,
    hint: cmd.description,
    kind: 'command',
  };
}

// ---------------------------------------------------------------------------
// the trigger: where in the line is a menu-driving token being typed?
// ---------------------------------------------------------------------------

export type MenuTrigger =
  | { kind: 'slash'; filter: string; tokenStart: number }
  | { kind: 'path'; filter: string; tokenStart: number };

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);
/** Mirrors images.ts: a backslash escapes exactly these, else stays literal. */
const ESCAPABLE = new Set([' ', '\t', '\n', '\r', '\\', '"', '@']);

/** Is the whitespace at line[i] escaped (preceded by an odd run of '\')? */
function isEscaped(line: string, i: number): boolean {
  let backslashes = 0;
  let j = i - 1;
  while (j >= 0 && line[j] === '\\') {
    backslashes += 1;
    j -= 1;
  }
  return backslashes % 2 === 1;
}

/** Resolve backslash escapes in a typed path token (for filesystem matching). */
export function unescapePathToken(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (ch === '\\' && i + 1 < s.length && ESCAPABLE.has(s[i + 1]!)) {
      out += s[i + 1];
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/** Re-escape a real path segment so the v0.6 tokenizer reads it back as one token. */
export function escapePathForInsert(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ESCAPABLE.has(ch)) out += '\\';
    out += ch;
  }
  return out;
}

/**
 * Compute the menu trigger at the cursor. The menu only lives at the end of
 * the line (mid-line editing closes it): a leading `/` with no whitespace in
 * the line is a slash-command filter; a trailing token that starts with an
 * unescaped `@` is a path filter. `\@` is a literal at-sign, never a trigger.
 */
export function computeMenuTrigger(line: string, cursor: number): MenuTrigger | null {
  if (cursor !== line.length) return null; // menu edits happen at EOL only
  if (line.startsWith('/') && !/[ \t\n\r]/.test(line)) {
    return { kind: 'slash', filter: line.slice(1), tokenStart: 0 };
  }
  // walk back to the start of the last token (unescaped whitespace boundary)
  let start = line.length;
  while (start > 0 && !(WHITESPACE.has(line[start - 1]!) && !isEscaped(line, start - 1))) {
    start -= 1;
  }
  const token = line.slice(start);
  if (token.startsWith('@')) {
    return { kind: 'path', filter: unescapePathToken(token.slice(1)), tokenStart: start };
  }
  return null;
}

// ---------------------------------------------------------------------------
// path listing (the `@` menu)
// ---------------------------------------------------------------------------

/** Rows shown at once; the overflow row reports the rest. */
export const MENU_MAX_PATH_ROWS = 12;

export interface PathListing {
  items: MenuItem[];
  /** Matches before the cap — when total > items.length, show "+N more". */
  total: number;
}

/**
 * List filesystem entries matching a typed `@` filter. The filter splits at
 * the last '/': the dir part is listed (relative to cwd), the base part
 * matches entries — prefix first, then substring, case-insensitive; dirs
 * before files within each group. Dotfiles stay hidden until the base starts
 * with '.'. Dirs insert with a trailing '/' so Tab/Enter deepens the listing.
 * Any read failure (missing dir, permissions) lists nothing — never throws.
 */
export function listPathMenu(
  cwd: string,
  filter: string,
  cap: number = MENU_MAX_PATH_ROWS,
): PathListing {
  const slash = filter.lastIndexOf('/');
  const dirPart = slash === -1 ? '' : filter.slice(0, slash);
  const base = slash === -1 ? filter : filter.slice(slash + 1);
  const absDir = resolve(cwd, dirPart === '' ? '.' : dirPart);
  let dirents;
  try {
    dirents = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return { items: [], total: 0 };
  }
  interface Candidate {
    name: string;
    isDir: boolean;
    isImage: boolean;
  }
  const showHidden = base.startsWith('.');
  const b = base.toLowerCase();
  const prefix: Candidate[] = [];
  const substring: Candidate[] = [];
  for (const d of dirents) {
    if (!showHidden && d.name.startsWith('.')) continue;
    const lower = d.name.toLowerCase();
    const cand: Candidate = {
      name: d.name,
      isDir: d.isDirectory(),
      isImage: !d.isDirectory() && isImagePath(d.name),
    };
    if (b === '' || lower.startsWith(b)) prefix.push(cand);
    else if (lower.includes(b)) substring.push(cand);
  }
  const byKind = (x: Candidate, y: Candidate): number => {
    if (x.isDir !== y.isDir) return x.isDir ? -1 : 1;
    return x.name < y.name ? -1 : x.name > y.name ? 1 : 0;
  };
  prefix.sort(byKind);
  substring.sort(byKind);
  const all = [...prefix, ...substring];
  const dirPrefix = dirPart === '' ? '' : `${dirPart}/`;
  const items: MenuItem[] = all.slice(0, cap).map((c) => {
    const full = `${dirPrefix}${c.name}${c.isDir ? '/' : ''}`;
    return {
      label: `${c.name}${c.isDir ? '/' : ''}`,
      insert: `@${escapePathForInsert(full)}`,
      kind: c.isDir ? 'dir' : c.isImage ? 'image' : 'file',
    };
  });
  return { items, total: all.length };
}

// ---------------------------------------------------------------------------
// the menu state machine
// ---------------------------------------------------------------------------

export class MenuModel {
  private openFlag = false;
  private kind: MenuTrigger['kind'] = 'slash';
  private items: MenuItem[] = [];
  private total = 0;
  private selected = 0;
  /** Where in the line the trigger token starts (path completion replaces from here). */
  private tokenStart = 0;

  get isOpen(): boolean {
    return this.openFlag;
  }

  get menuKind(): MenuTrigger['kind'] {
    return this.kind;
  }

  get token(): number {
    return this.tokenStart;
  }

  get rows(): readonly MenuItem[] {
    return this.items;
  }

  get totalCount(): number {
    return this.total;
  }

  get selection(): number {
    return this.selected;
  }

  get current(): MenuItem | undefined {
    return this.openFlag ? this.items[this.selected] : undefined;
  }

  open(kind: MenuTrigger['kind'], items: MenuItem[], total: number, tokenStart: number): void {
    this.openFlag = true;
    this.kind = kind;
    this.items = items;
    this.total = total;
    this.tokenStart = tokenStart;
    this.selected = 0;
  }

  /**
   * Replace the items (a keystroke re-filtered). The selection follows the
   * same insert text when it is still listed; otherwise it clamps into range.
   */
  update(items: MenuItem[], total: number, tokenStart: number): void {
    const keep = this.items[this.selected]?.insert;
    this.items = items;
    this.total = total;
    this.tokenStart = tokenStart;
    if (items.length === 0) {
      this.selected = 0;
      return;
    }
    const idx = keep === undefined ? -1 : items.findIndex((it) => it.insert === keep);
    this.selected = idx === -1 ? Math.min(this.selected, items.length - 1) : idx;
  }

  /** Move the selection by delta, wrapping. */
  move(delta: number): void {
    if (this.items.length === 0) return;
    const n = this.items.length;
    this.selected = (((this.selected + delta) % n) + n) % n;
  }

  close(): void {
    this.openFlag = false;
    this.items = [];
    this.total = 0;
    this.selected = 0;
  }
}

// ---------------------------------------------------------------------------
// row rendering (pure — styled strings, width-clamped)
// ---------------------------------------------------------------------------

/** Visible length, code-point based (good enough for row clamping). */
function visibleWidth(s: string): number {
  return Array.from(s).length;
}

/**
 * Build the menu's display rows. Selected row: a cyan ❯ + bright label;
 * path rows style dirs cyan-ish and images bright; the overflow row and the
 * key hint are dim. Every row is clamped to maxWidth VISIBLE columns (the
 * hint is dropped first — ANSI styles are applied after measuring, so escape
 * bytes can never wrap a row).
 */
export function renderMenuRows(model: MenuModel, theme: Theme, maxWidth: number): string[] {
  if (!model.isOpen) return [];
  const rows: string[] = [];
  const items = model.rows;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i]!;
    const isSel = i === model.selection;
    // measure plain, then style — the hint shrinks/drops to fit
    const marker = isSel ? '❯ ' : '  ';
    let hint = item.hint !== undefined && item.hint !== '' ? ` — ${item.hint}` : '';
    const budget = maxWidth - visibleWidth(marker) - visibleWidth(item.label);
    if (hint !== '' && visibleWidth(hint) > budget) {
      hint = budget > 1 ? `${hint.slice(0, Math.max(0, budget - 1))}…` : '';
    }
    const labelStyled =
      item.kind === 'dir'
        ? theme.cyan(item.label)
        : item.kind === 'image'
          ? theme.star(item.label)
          : isSel
            ? theme.star(item.label)
            : item.label;
    const row = isSel
      ? `${theme.cyan('❯')} ${labelStyled}${theme.dim(hint)}`
      : `  ${labelStyled}${theme.dim(hint)}`;
    rows.push(row);
  }
  const more = model.totalCount - items.length;
  if (more > 0) rows.push(theme.dim(`  +${more} more — keep typing`));
  const keys =
    model.menuKind === 'slash'
      ? '↑/↓ choose · Tab/Enter run · Esc close'
      : '↑/↓ choose · Tab/Enter complete · Esc close';
  rows.push(theme.dim(`  ${keys}`));
  return rows;
}

// ---------------------------------------------------------------------------
// the renderer — below-the-prompt drawing with RELATIVE cursor moves only
// ---------------------------------------------------------------------------

/**
 * Draws menu rows directly under the input line. The invariant: between
 * calls the cursor rests on the input row, and exactly `drawn` rows exist
 * below it. Growing reserves room by writing newlines FIRST (which scrolls
 * the transcript region — input row and menu rows move together, so relative
 * positions survive a bottom-edge scroll; absolute save/restore would not).
 * Every row is cleared before writing so shrinking content never ghosts.
 */
export class MenuRenderer {
  private drawn = 0;

  constructor(
    private readonly write: (s: string) => void,
    /** 0-based column the input cursor rests at (readline's getCursorPos().cols). */
    private readonly cursorCol: () => number,
  ) {}

  get drawnRows(): number {
    return this.drawn;
  }

  /** Repaint so exactly rows.length menu rows exist below the input row. */
  draw(rows: readonly string[]): void {
    const old = this.drawn;
    const next = rows.length;
    if (old === 0 && next === 0) return;
    let out = '';
    // 1. reserve room when growing: drop to the bottom of the old block and
    //    newline the difference into existence (scrolls the region if needed)
    if (next > old) {
      if (old > 0) out += `\x1b[${old}B`;
      out += '\n'.repeat(next - old);
      out += `\x1b[${next}A`; // back to the input row (column restored below)
    }
    // 2. paint each new row, then clear any surplus old rows below it
    const span = Math.max(next, old);
    for (let i = 0; i < span; i += 1) {
      out += `\x1b[1B\r\x1b[2K`;
      if (i < next) out += rows[i];
    }
    // 3. return to the input position (relative moves keep the column — reset it)
    out += `\x1b[${span}A\r`;
    const col = this.cursorCol();
    if (col > 0) out += `\x1b[${col}C`;
    this.write(out);
    this.drawn = next;
  }

  clear(): void {
    this.draw([]);
  }
}

// ---------------------------------------------------------------------------
// the prompt router — owns stdin, feeds readline through a wire stream
// ---------------------------------------------------------------------------

interface RawStream extends NodeJS.ReadableStream {
  setRawMode?(mode: boolean): void;
}

export function rawCapable(stdin: NodeJS.ReadableStream): boolean {
  return typeof (stdin as RawStream).setRawMode === 'function';
}

/**
 * The one place the TTY-only gate is decided: the menu needs an interactive
 * stdin we can hold in raw mode, a real terminal on stdout (readline's echo
 * target), colors allowed (NO_COLOR / TERM=dumb stay plain — typing the full
 * command works exactly as before), and a human session (not --json).
 */
export function promptMenuCapable(opts: {
  json: boolean;
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
  stdinRawCapable: boolean;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (opts.json) return false;
  if (!opts.stdinIsTTY || !opts.stdoutIsTTY) return false;
  if (!opts.stdinRawCapable) return false;
  if (opts.env['NO_COLOR'] !== undefined) return false;
  if ((opts.env['TERM'] ?? '') === 'dumb') return false;
  return true;
}

export interface PromptRouterDeps {
  /** The REAL stdin (raw mode, TTY). */
  stdin: NodeJS.ReadableStream;
  /** readline over the wire stream (never over stdin directly). */
  rl: Interface;
  /** readline's input — forwarded bytes are written here. */
  wire: { write: (s: string) => void };
  /** True only while the REPL awaits a line at the prompt. */
  isPromptActive: () => boolean;
  /** shift+tab with the menu closed (undefined in --safe mode → forwarded). */
  onShiftTab?: (() => void) | undefined;
  /** The slash-command registry (live — /help, the menu, dispatch share it). */
  slashCommands: () => readonly SlashCommand[];
  /** Project root for the `@` listing. */
  cwd: string;
  /** Raw stderr write — the menu renders on the UI channel. */
  write: (s: string) => void;
  /** The live theme (it can change via /theme mid-session). */
  theme: () => Theme;
  /** Terminal columns (for row clamping + the single-row guard). */
  cols: () => number;
}

/** Raw bytes the router recognizes before readline ever sees them. */
const NAV_UP = ['\x1b[A', '\x1bOA'];
const NAV_DOWN = ['\x1b[B', '\x1bOB'];
const SHIFT_TAB = '\x1b[Z';
const CTRL_C = '\x03';
/** Escape sequences the router acts on (longest-first matching at the head). */
const KNOWN_SEQUENCES = [...NAV_UP, ...NAV_DOWN, SHIFT_TAB];
/** Bytes that begin a router-relevant keypress (ends an ordinary text run). */
const SPECIAL_STARTS = new Set(['\x1b', CTRL_C, '\r', '\n', '\t']);
/** How long a lone ESC (or a split escape prefix) waits for more bytes. */
const ESCAPE_HOLD_MS = 50;

/**
 * readline.Interface's runtime-mutable state, typed readonly (or hidden) in
 * @types/node: `line`/`cursor` are how a completion replaces the buffer
 * (followed by rl.prompt(true) to repaint) and `paused` tracks pause().
 */
function rlMutable(rl: Interface): { line: string; cursor: number } {
  return rl as unknown as { line: string; cursor: number };
}

function rlPaused(rl: Interface): boolean {
  return (rl as unknown as { paused?: boolean }).paused === true;
}

/**
 * The keystroke switchboard. One stdin 'data' listener (the only one besides
 * whatever raw-mode consumer readline/the permission asker temporarily is):
 * each chunk is either a menu key (consumed), a mode key (handled), or
 * ordinary input (written into the wire — readline edits and echoes as
 * usual) followed by a menu recompute from the resulting rl.line.
 */
export class PromptRouter {
  private readonly model = new MenuModel();
  private readonly renderer: MenuRenderer;
  private pending = '';
  private holdTimer: NodeJS.Timeout | undefined;
  /** Esc/Ctrl+C closed the menu: stay closed until this line is submitted. */
  private latched = false;
  private detached = false;

  constructor(private readonly deps: PromptRouterDeps) {
    this.renderer = new MenuRenderer(deps.write, () => deps.rl.getCursorPos().cols);
  }

  attach(): void {
    this.deps.stdin.on('data', this.onData);
    this.deps.rl.on('line', this.onLine);
    this.deps.rl.on('close', this.onClose);
  }

  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.clearHold();
    this.deps.stdin.removeListener('data', this.onData);
    this.deps.rl.removeListener('line', this.onLine);
    this.deps.rl.removeListener('close', this.onClose);
    this.closeMenu();
    // A flowing stdin would hold the event loop open after the REPL ends —
    // v0.6's readline paused it on close; with the wire, that's our job now.
    try {
      this.deps.stdin.pause();
    } catch {
      // best effort
    }
  }

  /** Test seam: the menu model's current state. */
  get menu(): MenuModel {
    return this.model;
  }

  private readonly onLine = (): void => {
    // A line was submitted: the next prompt starts unlatched, menu closed.
    this.latched = false;
    this.closeMenu();
  };

  private readonly onClose = (): void => {
    this.latched = false;
    this.closeMenu();
  };

  private readonly onData = (chunk: Buffer | string): void => {
    // While readline is paused a foreign raw-mode consumer (the permission
    // menu, the /model picker) owns stdin — the router stays out of the way.
    if (rlPaused(this.deps.rl)) {
      this.pending = '';
      this.clearHold();
      return;
    }
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    this.drain();
  };

  /**
   * Work through the pending buffer. Chunks can batch several keypresses
   * ('\x1b[B\r' from a fast typist) or split one escape sequence across
   * chunks — so matching is head-based: consume a known sequence, hold an
   * incomplete one, forward ordinary runs up to the next special byte.
   */
  private drain(): void {
    for (;;) {
      const p = this.pending;
      if (p === '') return;
      const ch = p[0]!;
      if (ch === '\x1b') {
        const seq = KNOWN_SEQUENCES.find((s) => p.startsWith(s));
        if (seq !== undefined) {
          this.pending = p.slice(seq.length);
          this.onEscapeSeq(seq);
          continue;
        }
        if (p === '\x1b' || KNOWN_SEQUENCES.some((s) => s.startsWith(p))) {
          this.armHold(); // could still grow into a known sequence
          return;
        }
        if (this.model.isOpen) {
          // Esc with a batched tail while the menu is open: close, reprocess.
          this.pending = p.slice(1);
          this.latched = true;
          this.closeMenu();
          continue;
        }
        // Unknown escape — readline's own decoder handles it (as v0.6).
        this.pending = '';
        this.forward(p);
        return;
      }
      if (ch === CTRL_C) {
        this.pending = p.slice(1);
        this.onCtrlC();
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        this.pending = p.slice(1);
        this.onEnter(ch);
        continue;
      }
      if (ch === '\t') {
        this.pending = p.slice(1);
        this.onTab();
        continue;
      }
      // An ordinary run: forward up to the next special byte, then re-filter.
      let end = 1;
      while (end < p.length && !SPECIAL_STARTS.has(p[end]!)) end += 1;
      this.pending = p.slice(end);
      this.forward(p.slice(0, end));
      this.afterForward();
    }
  }

  private armHold(): void {
    this.clearHold();
    this.holdTimer = setTimeout(() => {
      this.holdTimer = undefined;
      const held = this.pending;
      this.pending = '';
      if (held === '') return;
      if (held === '\x1b' && this.model.isOpen) {
        // Esc: close the menu, keep the typed text, latch for this line.
        this.latched = true;
        this.closeMenu();
        return;
      }
      this.forward(held);
      this.afterForward();
    }, ESCAPE_HOLD_MS);
    this.holdTimer.unref?.();
  }

  private clearHold(): void {
    if (this.holdTimer !== undefined) {
      clearTimeout(this.holdTimer);
      this.holdTimer = undefined;
    }
  }

  private forward(s: string): void {
    this.deps.wire.write(s);
  }

  // -- key handlers ---------------------------------------------------------

  private onEscapeSeq(seq: string): void {
    if (NAV_UP.includes(seq)) {
      this.onNav(-1);
      return;
    }
    if (NAV_DOWN.includes(seq)) {
      this.onNav(1);
      return;
    }
    // shift+tab: the menu owns navigation while it is open; otherwise cycle
    // the permission mode (or forward harmlessly when cycling is off).
    if (this.model.isOpen) return;
    if (this.deps.onShiftTab !== undefined) {
      this.deps.onShiftTab();
      return;
    }
    this.forward(SHIFT_TAB); // --safe: readline ignores it (v0.6 behavior)
  }

  private onNav(delta: number): void {
    if (!this.model.isOpen) {
      // history etc. — readline's own meaning for the arrow keys
      this.forward(delta < 0 ? NAV_UP[0]! : NAV_DOWN[0]!);
      this.afterForward();
      return;
    }
    this.model.move(delta);
    this.redraw();
  }

  private onCtrlC(): void {
    if (this.model.isOpen) {
      // Ctrl+C mid-menu closes the menu, never the app.
      this.latched = true;
      this.closeMenu();
      return;
    }
    this.forward(CTRL_C); // readline emits SIGINT → the REPL's own handler
  }

  private onEnter(enter: string): void {
    if (!this.model.isOpen) {
      this.forward(enter);
      return; // the REPL handles the line (empty Enter reprompts bare)
    }
    if (this.model.menuKind === 'slash') {
      const item = this.model.current;
      this.closeMenu();
      if (item !== undefined && this.deps.rl.line !== item.insert) {
        this.replaceLine(item.insert);
      }
      this.forward(enter); // submits the (possibly replaced) command line
      return;
    }
    // path mode: Enter completes, never submits — except when the selected
    // file IS the typed token already (nothing to complete → submit).
    const item = this.model.current;
    const rl = this.deps.rl;
    if (
      item !== undefined &&
      item.kind !== 'dir' &&
      item.insert === rl.line.slice(this.model.token)
    ) {
      this.closeMenu();
      this.forward(enter);
      return;
    }
    this.completePathSelection();
  }

  private onTab(): void {
    if (!this.model.isOpen) {
      this.forward('\t'); // no completer registered — v0.6 behavior
      return;
    }
    if (this.model.menuKind === 'slash') {
      const item = this.model.current;
      this.closeMenu();
      if (item !== undefined && this.deps.rl.line !== item.insert) {
        this.replaceLine(item.insert);
      }
      this.forward('\r'); // Tab executes the highlighted command, like Enter
      return;
    }
    this.completePathSelection();
  }

  // -- menu lifecycle ---------------------------------------------------------

  /** Recompute the trigger from the line readline now holds. */
  private afterForward(): void {
    const rl = this.deps.rl;
    if (!this.deps.isPromptActive() || this.latched) {
      if (this.model.isOpen) this.closeMenu();
      return;
    }
    const trigger = computeMenuTrigger(rl.line, rl.cursor);
    if (trigger === null) {
      if (this.model.isOpen) this.closeMenu();
      return;
    }
    if (trigger.kind === 'slash') {
      const matches = filterSlashCommands(this.deps.slashCommands(), trigger.filter);
      if (matches.length === 0) {
        if (this.model.isOpen) this.closeMenu();
        return;
      }
      const items = matches.map(slashCommandItem);
      this.setMenu('slash', items, items.length, trigger.tokenStart);
      return;
    }
    const listing = listPathMenu(this.deps.cwd, trigger.filter);
    if (listing.items.length === 0) {
      if (this.model.isOpen) this.closeMenu();
      return;
    }
    // An exactly-typed FILE is already complete — the menu has nothing to
    // add and would only eat the next Enter (dirs stay open: they deepen).
    const only = listing.items.length === 1 ? listing.items[0]! : undefined;
    if (
      only !== undefined &&
      only.kind !== 'dir' &&
      only.insert === `@${escapePathForInsert(trigger.filter)}`
    ) {
      if (this.model.isOpen) this.closeMenu();
      return;
    }
    this.setMenu('path', listing.items, listing.total, trigger.tokenStart);
  }

  private setMenu(
    kind: MenuTrigger['kind'],
    items: MenuItem[],
    total: number,
    tokenStart: number,
  ): void {
    if (this.model.isOpen && this.model.menuKind === kind) {
      this.model.update(items, total, tokenStart);
    } else {
      this.model.open(kind, items, total, tokenStart);
    }
    this.redraw();
  }

  /** The menu only renders while the prompt+line fit on a single row. */
  private fitsOneRow(): boolean {
    const rl = this.deps.rl;
    return 2 + Array.from(rl.line).length < this.deps.cols();
  }

  private redraw(): void {
    if (!this.model.isOpen) return;
    if (!this.fitsOneRow()) {
      // The line wrapped under the menu — close it; the typed text is untouched.
      this.closeMenu();
      return;
    }
    const rows = renderMenuRows(this.model, this.deps.theme(), this.deps.cols() - 1);
    this.renderer.draw(rows);
  }

  private closeMenu(): void {
    if (this.renderer.drawnRows > 0) this.renderer.clear();
    this.model.close();
  }

  /** Replace the whole input line and repaint it (readline's own refresh). */
  private replaceLine(text: string): void {
    const rl = rlMutable(this.deps.rl);
    rl.line = text;
    rl.cursor = text.length;
    this.deps.rl.prompt(true); // preserveCursor — repaints prompt + line
  }

  /** Path selection: swap the trigger token for the completed path. */
  private completePathSelection(): void {
    const item = this.model.current;
    if (item === undefined) return;
    const rl = this.deps.rl;
    const start = this.model.token;
    const next = `${rl.line.slice(0, start)}${item.insert}`;
    const isDir = item.kind === 'dir';
    this.closeMenu(); // clears the rows BEFORE readline's refresh repaints
    this.replaceLine(next);
    if (isDir) {
      // A dir completion deepens: recompute the listing for the new prefix.
      this.afterForward();
    }
  }
}

// ---------------------------------------------------------------------------
// a one-shot picker (the /model list) — post-submit, raw-mode, arrow keys
// ---------------------------------------------------------------------------

export interface PickItem {
  label: string;
  hint?: string | undefined;
}

export interface PickerIo {
  stdin: NodeJS.ReadableStream;
  /** Raw stderr write (no trailing newline) — the picker draws on the UI channel. */
  write: (s: string) => void;
  /** Pause/resume the caller's line editor while the picker owns stdin. */
  pauseInput: () => void;
  resumeInput: () => void;
  theme: Theme;
  /**
   * v0.8: optional dim footer below the rows (may be multi-line — a leading
   * empty line draws a blank separator row). Counted in the redraw math, so
   * it can never ghost.
   */
  footer?: string | undefined;
}

/**
 * Render `items` as an arrow-key list and resolve the picked index — or null
 * on Esc/Ctrl+C (the caller's "keep current" path). Rendering follows the
 * permission menu: rows print as normal scrolling output; redraws move up
 * and repaint in place. Raw mode is taken only for the duration.
 */
export function pickFromList(
  title: string,
  items: readonly PickItem[],
  initial: number,
  io: PickerIo,
): Promise<number | null> {
  const theme = io.theme;
  const stdin = io.stdin as RawStream;
  const count = items.length;
  const footerLines = io.footer !== undefined && io.footer !== '' ? io.footer.split('\n') : [];
  const rowCount = count + footerLines.length;
  let selected = Math.min(Math.max(0, initial), count - 1);

  io.pauseInput();
  try {
    stdin.setRawMode?.(true);
  } catch {
    // best effort — key handling still works without raw mode
  }

  io.write(`${theme.dim(title)}\n`);

  return new Promise<number | null>((resolve) => {
    let drawn = false;

    const draw = (): void => {
      const lines = items.map((item, i) => {
        const hint = item.hint !== undefined && item.hint !== '' ? ` — ${item.hint}` : '';
        return i === selected
          ? `${theme.cyan('❯')} ${theme.star(item.label)}${theme.dim(hint)}`
          : `  ${item.label}${theme.dim(hint)}`;
      });
      if (drawn) {
        io.write(`\x1b[${rowCount}A`);
        for (const line of lines) io.write(`\x1b[2K\r${line}\n`);
        for (const line of footerLines) io.write(`\x1b[2K\r${theme.dim(line)}\n`);
      } else {
        for (const line of lines) io.write(`${line}\n`);
        for (const line of footerLines) io.write(`${theme.dim(line)}\n`);
        drawn = true;
      }
    };

    const cleanup = (): void => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      io.resumeInput();
    };

    const finish = (value: number | null): void => {
      cleanup();
      resolve(value);
    };

    const onEnd = (): void => finish(null);

    const onData = (chunk: Buffer | string): void => {
      const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (NAV_UP.includes(s)) {
        selected = (((selected - 1) % count) + count) % count;
        draw();
        return;
      }
      if (NAV_DOWN.includes(s)) {
        selected = (selected + 1) % count;
        draw();
        return;
      }
      if (s === '\r' || s === '\n') {
        finish(selected);
        return;
      }
      if (s === '\x1b' || s === CTRL_C) {
        finish(null);
        return;
      }
      // anything else is ignored — this is a picker, not a line editor
    };

    draw();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}
