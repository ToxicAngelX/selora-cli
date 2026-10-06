/**
 * The permission gate — NOTHING in the agent executes without passing through
 * here (the Tool.run contract: "never called without the permission gate").
 *
 * v0.3 renders an ARROW-KEY MENU on a TTY (❯ Yes / Yes, always this session /
 * No, plus [e]dit command for exec tools and a "No, with a reason" flow that
 * feeds the reason back to the model). The exact change is shown first — the
 * dry-run preview, a colored diff when the tool provides one, and the absolute
 * path for outside-the-project-root access. Raw mode is taken only for the
 * duration of the menu; the readline line editor is paused and restored.
 *
 * Non-TTY / piped stdin keeps the v0.2 behavior EXACTLY: the monochrome box
 *   ┌─ write_file(out.txt)
 *   │   would write 24 bytes — full content:
 *   │   hello world
 *   └─ Allow? [y]es / [n]o / [a]lways this session
 * with answers read as lines (y/a/n/e; anything unrecognized denies). When
 * stdin closes without an answer the prompt DENIES (safe default).
 *
 * `a` (allow-always-this-session) is answered from SESSION-SCOPED MEMORY ONLY
 * (an in-memory map + directory grants held by the running agent loop).
 * Auto-allows are never written to disk, never persist across processes, and
 * for write/exec tools cover exactly the same label — except tools flagged
 * neverAutoAllow (remove): every call asks, always. Outside-root 'a' answers
 * grant exactly one DIRECTORY (the target's parent, or itself when a dir).
 *
 * Denial is never an error — it is fed back to the model ("Permission denied
 * by user." + the optional reason) and the conversation continues.
 */

import * as readline from 'node:readline';
import type { ToolKind } from './tool.js';

export type PermissionDecision = 'allow' | 'allow-session' | 'deny' | 'edit';

/** A decision plus the optional reason a "No" carried (goes back to the model). */
export interface PermissionAnswer {
  decision: PermissionDecision;
  reason?: string;
}

export interface PermissionRequest {
  /** The tool's permissionLabel, e.g. read_file(src/index.ts). */
  label: string;
  kind: ToolKind;
  /** Dry-run preview (write/exec: the exact change that would happen). */
  preview?: string | undefined;
  /** Only exec tools offer [e]dit. */
  offerEdit?: boolean | undefined;
  /** v0.3: absolute path outside the project root — shown in the box. */
  outsidePath?: string | undefined;
  /** v0.3: hide the "always this session" option (neverAutoAllow tools). */
  neverAlways?: boolean | undefined;
  /**
   * v0.3: PRE-RENDERED colored diff lines (the caller styled them with the
   * theme + ui/diff) — printed verbatim under the preview.
   */
  diff?: readonly string[] | undefined;
}

export interface PermissionAsker {
  ask(req: PermissionRequest): Promise<PermissionDecision>;
  /**
   * v0.3: the richer ask — same decisions, but a "No" may carry a typed
   * reason. Interactive askers implement it; the loop falls back to ask()
   * when absent.
   */
  askDetailed?: ((req: PermissionRequest) => Promise<PermissionAnswer>) | undefined;
  /**
   * The [e]dit flow: prompt for a replacement command line. Returns null when
   * the user submits nothing (treated as deny).
   */
  replacement(current: string): Promise<string | null>;
  /**
   * Release held resources (the asker's OWN readline over stdin, when it has
   * one). v0.6: `run` must call this when finished — an open readline over a
   * TTY keeps the event loop alive and the process would never exit. No-op
   * for askers that share the caller's line source (chat) or hold nothing.
   */
  close?: (() => void) | undefined;
}

// ---------------------------------------------------------------------------
// menu primitives (pure, exported for tests)
// ---------------------------------------------------------------------------

export type MenuKey = 'up' | 'down' | 'enter' | 'y' | 'a' | 'n' | 'e' | 'escape' | 'other';

/** Parse one raw-mode stdin chunk into a menu key. Arrow escapes included. */
export function parseMenuKey(data: string): MenuKey {
  if (data === '\x1b[A' || data === '\x1bOA' || data === 'k') return 'up';
  if (data === '\x1b[B' || data === '\x1bOB' || data === 'j') return 'down';
  if (data === '\r' || data === '\n') return 'enter';
  if (data === 'y' || data === 'Y') return 'y';
  if (data === 'a' || data === 'A') return 'a';
  if (data === 'n' || data === 'N') return 'n';
  if (data === 'e' || data === 'E') return 'e';
  if (data === '\x1b' || data === '\x03' || data === 'q' || data === 'Q') return 'escape';
  return 'other';
}

/** The menu option labels, in order. 'always' is dropped for neverAutoAllow tools. */
export function menuOptions(offerEdit: boolean, neverAlways: boolean): string[] {
  const opts = ['Yes'];
  if (!neverAlways) opts.push('Yes, always this session');
  opts.push('No');
  if (offerEdit) opts.push('Edit command');
  return opts;
}

/** Colors for the menu — injectable; every function is the identity by default. */
export interface MenuStyle {
  marker: (s: string) => string;
  selected: (s: string) => string;
  option: (s: string) => string;
  hint: (s: string) => string;
}

export function plainMenuStyle(): MenuStyle {
  return {
    marker: (s) => s,
    selected: (s) => s,
    option: (s) => s,
    hint: (s) => s,
  };
}

/** Render the option block (one line per option, ❯ on the selected one). */
export function renderMenu(
  options: readonly string[],
  selected: number,
  style: MenuStyle,
): string[] {
  return options.map((o, i) =>
    i === selected ? `${style.marker('❯')} ${style.selected(o)}` : `  ${style.option(o)}`,
  );
}

// ---------------------------------------------------------------------------
// box rendering (line-based path — v0.2-exact)
// ---------------------------------------------------------------------------

/** Render the prompt box (without the trailing question line). */
export function promptHead(req: PermissionRequest): string[] {
  const lines = [`┌─ ${req.label}`];
  if (req.outsidePath !== undefined && req.outsidePath !== '') {
    lines.push(`│   outside the project root:`);
    lines.push(`│   ${req.outsidePath}`);
  }
  if (req.preview !== undefined && req.preview !== '') {
    for (const line of req.preview.split('\n')) lines.push(`│   ${line}`);
  }
  return lines;
}

function questionLine(offerEdit: boolean): string {
  const options = offerEdit
    ? '[y]es / [n]o / [a]lways this session / [e]dit command'
    : '[y]es / [n]o / [a]lways this session';
  return `└─ Allow? ${options}`;
}

function parseAnswer(raw: string): PermissionDecision {
  const a = raw.trim().toLowerCase();
  if (a === 'y' || a === 'yes') return 'allow';
  if (a === 'a' || a === 'always') return 'allow-session';
  if (a === 'e' || a === 'edit') return 'edit';
  return 'deny'; // empty, 'n', 'no', or anything unrecognized → no
}

// ---------------------------------------------------------------------------
// the interactive asker
// ---------------------------------------------------------------------------

export interface InteractiveAskerIo {
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  /** Prompt rendering goes to stderr — stdout stays clean reply text. */
  err: (s: string) => void;
  /**
   * v0.3: the caller's SHARED line source (the chat REPL owns the readline;
   * the asker must never attach a second 'line' listener to it). Absent →
   * the asker creates and owns its own readline over stdin (v0.2 behavior).
   */
  nextLine?: (() => Promise<string>) | undefined;
  /** Pause/resume the caller's line editor around the raw-mode menu. */
  pauseInput?: (() => void) | undefined;
  resumeInput?: (() => void) | undefined;
  /** v0.3 menu styling (identity by default — plain but functional). */
  style?: MenuStyle | undefined;
  /** Raw stderr write with NO trailing newline (cursor moves for the menu). */
  rawWrite?: (s: string) => void | undefined;
}

interface RawCapable {
  setRawMode?(mode: boolean): void;
}

function rawCapable(stdin: NodeJS.ReadableStream): boolean {
  const candidate = stdin as unknown as RawCapable;
  return typeof candidate.setRawMode === 'function';
}

/**
 * The human prompt. TTY → the arrow-key menu (a "No" may be followed by an
 * optional reason line that goes back to the model); piped stdin → the v0.2
 * line-based box, answers read as lines in order. When stdin closes without
 * an answer, the prompt DENIES (safe default) and says so on stderr.
 */
export function createInteractiveAsker(io: InteractiveAskerIo): PermissionAsker {
  const style = io.style ?? plainMenuStyle();
  const raw = io.rawWrite ?? ((s: string) => io.err(s.endsWith('\n') ? s.slice(0, -1) : s));

  // The owned readline (only when the caller did not share a line source).
  let ownRl: readline.Interface | undefined;
  if (io.nextLine === undefined) {
    ownRl = readline.createInterface({ input: io.stdin, terminal: io.isTTY });
  }

  const ownedNextLine = (): Promise<string> => {
    const buffered = ownedQueued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (ownedClosed) return Promise.reject(new Error('prompt closed'));
    return new Promise<string>((resolve, reject) => {
      ownedWaiters.push({ resolve, reject });
    });
  };
  const ownedQueued: string[] = [];
  const ownedWaiters: Array<{ resolve: (line: string) => void; reject: () => void }> = [];
  let ownedClosed = false;

  if (ownRl !== undefined) {
    ownRl.on('line', (line: string) => {
      const w = ownedWaiters.shift();
      if (w !== undefined) w.resolve(line);
      else ownedQueued.push(line);
    });
    ownRl.on('close', () => {
      ownedClosed = true;
      while (ownedWaiters.length > 0) ownedWaiters.shift()!.reject();
    });
  }

  const nextLine: () => Promise<string> = io.nextLine ?? ownedNextLine;
  const pauseInput = io.pauseInput ?? (() => ownRl?.pause());
  const resumeInput = io.resumeInput ?? (() => ownRl?.resume());

  const useMenu = io.isTTY && rawCapable(io.stdin);

  /** The v0.2 line-based prompt — byte-identical, pinned by tests. */
  async function lineAsk(req: PermissionRequest): Promise<PermissionDecision> {
    for (const line of promptHead(req)) io.err(line);
    if (req.diff !== undefined) for (const line of req.diff) io.err(line);
    io.err(questionLine(req.offerEdit === true));
    try {
      return parseAnswer(await nextLine());
    } catch {
      io.err('· permission prompt closed without an answer — treating as no');
      return 'deny';
    }
  }

  /** The arrow-key menu (TTY + raw-mode-capable stdin only). */
  function menuAsk(req: PermissionRequest): Promise<PermissionAnswer> {
    const stdin = io.stdin as unknown as RawCapable & NodeJS.ReadableStream;
    const offerEdit = req.offerEdit === true;
    const options = menuOptions(offerEdit, req.neverAlways === true);
    // Initial index: Yes (0) — the common case is one keystroke (Enter/y).
    let selected = 0;
    const optionCount = options.length;

    // The line editor is paused while we own stdin in raw mode.
    pauseInput();
    try {
      stdin.setRawMode?.(true);
      stdin.resume();
    } catch {
      // best effort — key handling still works without raw mode
    }

    for (const line of promptHead(req)) io.err(line);
    if (req.diff !== undefined) for (const line of req.diff) io.err(line);

    return new Promise<PermissionAnswer>((resolve) => {
      let drawn = false;

      const draw = (): void => {
        const lines = renderMenu(options, selected, style);
        if (drawn) {
          // Redraw in place: cursor sits after the hint line, optionCount
          // lines below the first option — move up, then clear+write each.
          raw(`${ESC}[${optionCount}A`);
          for (const line of lines) raw(`${ESC}[2K\r${line}\n`);
        } else {
          for (const line of lines) raw(`${line}\n`);
          raw(`${style.hint('  ↑/↓ or j/k to choose · Enter to confirm · Esc = No')}\n`);
          drawn = true;
        }
      };

      const cleanup = (): void => {
        stdin.removeListener('data', onData);
        stdin.removeListener('end', onEnd);
        try {
          stdin.setRawMode?.(false);
        } catch {
          // best effort
        }
        resumeInput();
      };

      const finish = (answer: PermissionAnswer): void => {
        cleanup();
        resolve(answer);
      };

      const onEnd = (): void => {
        finish({ decision: 'deny' });
      };

      const onData = (chunk: Buffer | string): void => {
        const key = parseMenuKey(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
        switch (key) {
          case 'up':
            selected = (selected - 1 + optionCount) % optionCount;
            draw();
            return;
          case 'down':
            selected = (selected + 1) % optionCount;
            draw();
            return;
          case 'y':
            finish({ decision: 'allow' });
            return;
          case 'a':
            // neverAutoAllow tools do not offer 'always' — 'a' means yes.
            finish({ decision: req.neverAlways === true ? 'allow' : 'allow-session' });
            return;
          case 'n':
            finish({ decision: 'deny' });
            return;
          case 'e':
            if (offerEdit) finish({ decision: 'edit' });
            return;
          case 'escape':
            finish({ decision: 'deny' });
            return;
          case 'enter': {
            const label = options[selected]!;
            if (label === 'Yes') finish({ decision: 'allow' });
            else if (label === 'No') finish({ decision: 'deny' });
            else if (label === 'Edit command') finish({ decision: 'edit' });
            else finish({ decision: 'allow-session' });
            return;
          }
          default:
            return; // anything else is ignored
        }
      };

      draw();
      stdin.on('data', onData);
      stdin.on('end', onEnd);
    });
  }

  /**
   * Menu + the optional reason after a plain deny: the reason prompt needs
   * cooked line input, so it runs after the menu restored the line editor.
   */
  async function menuAskWithReason(req: PermissionRequest): Promise<PermissionAnswer> {
    const answer = await menuAsk(req);
    if (answer.decision !== 'deny') return answer;
    io.err('└─ Reason (optional — sent to the model; empty line = none):');
    try {
      const line = await nextLine();
      const trimmed = line.trim();
      return trimmed === '' ? answer : { decision: 'deny', reason: trimmed };
    } catch {
      return answer;
    }
  }

  return {
    ask: async (req) => {
      if (!useMenu) return lineAsk(req);
      return (await menuAskWithReason(req)).decision;
    },
    askDetailed: useMenu ? async (req) => menuAskWithReason(req) : undefined,
    replacement: async (current) => {
      io.err(`│   current: ${current}`);
      io.err('└─ Replacement command (empty line cancels):');
      try {
        const line = await nextLine();
        const trimmed = line.trim();
        return trimmed === '' ? null : trimmed;
      } catch {
        return null;
      }
    },
    // Only an OWNED readline needs closing (a shared line source — the chat
    // REPL — is closed by its owner).
    close: ownRl !== undefined ? () => ownRl.close() : undefined,
  };
}

const ESC = '\x1b';

/** --yes: auto-approve every request. --safe still filters the toolset. */
export function createAutoAsker(): PermissionAsker {
  return {
    ask: async () => 'allow',
    replacement: async () => null, // never reached — nothing is prompted
  };
}

/**
 * --json / other non-interactive modes without --yes: every tool is denied.
 * The loop feeds the denial back with instructions (use --yes), so the asker
 * itself needs no reason text.
 */
export function createDenyingAsker(): PermissionAsker {
  return {
    ask: async () => 'deny',
    replacement: async () => null,
  };
}

/**
 * Session-scoped auto-allow memory: `a` answers live here, in the running
 * loop's memory only. Read tools key by tool name (any read is allowed);
 * write/exec key by tool name + label, so "always" for one write never
 * silently approves a different one. v0.3 also remembers OUTSIDE-ROOT
 * directory grants — `a` on an outside path grants exactly that directory.
 */
export class SessionAllows {
  private readonly allowed = new Set<string>();
  private readonly dirs = new Set<string>();

  static key(kind: ToolKind, toolName: string, label: string): string {
    return kind === 'read' ? `read:${toolName}` : `${toolName}:${label}`;
  }

  check(kind: ToolKind, toolName: string, label: string): boolean {
    return this.allowed.has(SessionAllows.key(kind, toolName, label));
  }

  remember(kind: ToolKind, toolName: string, label: string): void {
    this.allowed.add(SessionAllows.key(kind, toolName, label));
  }

  /** The session-granted outside directories (a copy — tools snapshot it). */
  outsideDirs(): string[] {
    return [...this.dirs];
  }

  rememberDir(absDir: string): void {
    this.dirs.add(absDir);
  }

  /** v0.3: what is currently auto-allowed — for the /permissions display. */
  dump(): { rules: string[]; outsideDirs: string[] } {
    return { rules: [...this.allowed], outsideDirs: [...this.dirs] };
  }
}
