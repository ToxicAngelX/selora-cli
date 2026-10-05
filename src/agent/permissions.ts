/**
 * The permission gate — NOTHING in the agent executes without passing through
 * here (the Tool.run contract: "never called without the permission gate").
 *
 * Interactive prompt (stderr, monochrome, structured with box characters —
 * structure, not decoration):
 *
 *   ┌─ write_file(out.txt)
 *   │   would write 24 bytes — full content:
 *   │   hello world
 *   └─ Allow? [y]es / [n]o / [a]lways this session
 *
 * `a` (allow-always-this-session) is answered from SESSION-SCOPED MEMORY ONLY:
 * an in-memory map held by the running agent loop. Auto-allows are never
 * written to disk, never persisted across processes, and never apply to a
 * different input for write/exec tools (read tools: the whole tool name).
 *
 * run_command additionally offers [e]dit command: the user types a
 * replacement command line, which is re-prompted before it runs.
 *
 * Denial is never an error — it is fed back to the model as the tool result
 * "Permission denied by user" and the conversation continues.
 */

import * as readline from 'node:readline';
import type { ToolKind } from './tool.js';

export type PermissionDecision = 'allow' | 'allow-session' | 'deny' | 'edit';

export interface PermissionRequest {
  /** The tool's permissionLabel, e.g. read_file(src/index.ts). */
  label: string;
  kind: ToolKind;
  /** Dry-run preview (write/exec: the exact change that would happen). */
  preview?: string | undefined;
  /** Only exec tools offer [e]dit. */
  offerEdit?: boolean | undefined;
}

export interface PermissionAsker {
  ask(req: PermissionRequest): Promise<PermissionDecision>;
  /**
   * The [e]dit flow: prompt for a replacement command line. Returns null when
   * the user submits nothing (treated as deny).
   */
  replacement(current: string): Promise<string | null>;
}

/** Render the prompt box (without the trailing question line). */
function promptHead(req: PermissionRequest): string[] {
  const lines = [`┌─ ${req.label}`];
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

export interface InteractiveAskerIo {
  stdin: NodeJS.ReadableStream;
  isTTY: boolean;
  /** Prompt rendering goes to stderr — stdout stays clean reply text. */
  err: (s: string) => void;
}

/**
 * The human prompt. Works with a TTY and with piped stdin (answers are read
 * as lines, in order — the buffering pattern from auth/prompts.ts). When
 * stdin closes without an answer, the prompt DENIES (safe default) and says
 * so on stderr.
 */
export function createInteractiveAsker(io: InteractiveAskerIo): PermissionAsker {
  const rl = readline.createInterface({ input: io.stdin, terminal: io.isTTY });

  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: () => void }> = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) w.resolve(line);
    else queued.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) waiters.shift()!.reject();
  });

  function nextLine(): Promise<string> {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.reject(new Error('prompt closed'));
    return new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  return {
    ask: async (req) => {
      for (const line of promptHead(req)) io.err(line);
      io.err(questionLine(req.offerEdit === true));
      try {
        return parseAnswer(await nextLine());
      } catch {
        io.err('· permission prompt closed without an answer — treating as no');
        return 'deny';
      }
    },
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
  };
}

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
 * silently approves a different one.
 */
export class SessionAllows {
  private readonly allowed = new Set<string>();

  static key(kind: ToolKind, toolName: string, label: string): string {
    return kind === 'read' ? `read:${toolName}` : `${toolName}:${label}`;
  }

  check(kind: ToolKind, toolName: string, label: string): boolean {
    return this.allowed.has(SessionAllows.key(kind, toolName, label));
  }

  remember(kind: ToolKind, toolName: string, label: string): void {
    this.allowed.add(SessionAllows.key(kind, toolName, label));
  }
}
