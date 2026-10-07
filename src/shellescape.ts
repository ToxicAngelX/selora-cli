/**
 * The `!` one-shot shell escape (v0.9 — docs/commands/chat.md): `! npm test`
 * at the chat prompt runs the command in the project root WITHOUT leaving the
 * session. The output renders as a dim folded block (the last 40 lines plus a
 * "… N more lines" marker) followed by the exit code — non-zero is
 * highlighted. The command and its output are NEVER sent to the model.
 *
 * No permission gate, deliberately: the USER typed the line at their own
 * prompt, so it carries exactly the trust of their own terminal (unlike the
 * agent's run_command, which executes MODEL-chosen commands — that one keeps
 * its gate, shell:false, and timeouts). The user's line runs through the real
 * shell (pipes, redirects, globs work) with stdin inherited from /dev/null —
 * a `!` command can never eat the REPL's keystrokes. Ctrl+C while one runs
 * kills the command (SIGINT, then SIGKILL if it lingers) instead of exiting
 * the session. Captured output is capped (256 KB) so `! yes` cannot exhaust
 * memory; the REPL stays responsive throughout.
 */

import { spawn } from 'node:child_process';
import type { Theme } from './ui/theme.js';

// ---------------------------------------------------------------------------
// the line parse (pure)
// ---------------------------------------------------------------------------

export type BangLine =
  | { kind: 'shell'; command: string }
  /** `\!…` — a literal leading bang; the text is sent as a normal message. */
  | { kind: 'escaped'; text: string }
  | { kind: 'plain' };

/**
 * Classify a trimmed prompt line. The `!` is a shell escape ONLY at the start
 * of the line — `foo ! bar` stays a plain message. `\!` escapes a literal
 * leading bang (the backslash is consumed).
 */
export function parseBangLine(trimmed: string): BangLine {
  if (trimmed.startsWith('\\!')) return { kind: 'escaped', text: trimmed.slice(1) };
  if (trimmed.startsWith('!')) return { kind: 'shell', command: trimmed.slice(1).trim() };
  return { kind: 'plain' };
}

// ---------------------------------------------------------------------------
// the runner (spawn injectable for tests; never throws)
// ---------------------------------------------------------------------------

/** Display cap: the last N output lines render; the rest fold into a marker. */
export const SHELL_OUTPUT_LINE_CAP = 40;
/** Capture cap: beyond this the middle of the output is dropped honestly. */
export const SHELL_OUTPUT_CHAR_CAP = 256 * 1024;
/** Grace between SIGINT and SIGKILL when the user interrupts a `!` command. */
export const SHELL_KILL_GRACE_MS = 750;

export interface ShellRunResult {
  /** The exit code; null when the process was signaled or never started. */
  code: number | null;
  /** The signal that ended it (close event), when any. */
  signal: string | null;
  /** Combined stdout+stderr in arrival order, capped at the char cap. */
  output: string;
  /** True when the output hit the char cap (the tail was dropped). */
  truncated: boolean;
  /** Set when the command could not be STARTED (no exit code exists). */
  spawnError?: string | undefined;
}

/** Minimal structural child process — what the runner needs of spawn(). */
export interface SpawnedProcess {
  /** The spawned pid (a real process group id when detached). */
  pid?: number | undefined;
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): void;
}

export type SpawnImpl = (command: string, cwd: string) => SpawnedProcess;

const defaultSpawn: SpawnImpl = (command, cwd) =>
  // shell:true → the user's real shell semantics (pipes/redirects/globs);
  // stdin is NOT the REPL's — a `!` command never eats prompt keystrokes.
  // detached: true → its own PROCESS GROUP, so Ctrl+C can signal the whole
  // tree (sh ignores SIGINT while a foreground child runs — dash passes the
  // signal to nobody and keeps waiting; only a group signal reaches the
  // grandchildren). POSIX only; Windows has no process groups (TerminateJobObject
  // territory) and keeps the plain spawn.
  spawn(command, {
    cwd,
    shell: true,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(process.platform === 'win32' ? {} : { detached: true }),
  });

export interface ShellRunHandle {
  done: Promise<ShellRunResult>;
  /** SIGINT now, SIGKILL after a short grace if the process lingers. */
  kill: () => void;
}

export function startShellCommand(
  command: string,
  cwd: string,
  opts: { spawnImpl?: SpawnImpl } = {},
): ShellRunHandle {
  const spawnImpl = opts.spawnImpl ?? defaultSpawn;
  let child: SpawnedProcess;
  try {
    child = spawnImpl(command, cwd);
  } catch (err) {
    const spawnError = err instanceof Error ? err.message : String(err);
    return {
      done: Promise.resolve({
        code: null,
        signal: null,
        output: '',
        truncated: false,
        spawnError,
      }),
      kill: () => {},
    };
  }

  let output = '';
  let truncated = false;
  let settled = false;
  let escalate: NodeJS.Timeout | undefined;

  const done = new Promise<ShellRunResult>((resolve) => {
    const finish = (result: ShellRunResult): void => {
      if (settled) return;
      settled = true;
      if (escalate !== undefined) clearTimeout(escalate);
      resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      if (output.length < SHELL_OUTPUT_CHAR_CAP) {
        output += text.slice(0, SHELL_OUTPUT_CHAR_CAP - output.length);
        if (output.length >= SHELL_OUTPUT_CHAR_CAP) truncated = true;
      } else {
        truncated = true;
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err) => {
      finish({ code: null, signal: null, output, truncated, spawnError: err.message });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, output, truncated });
    });
  });

  const kill = (): void => {
    // Signal the whole process GROUP: with shell:true the direct child is sh,
    // which IGNORES SIGINT while a foreground child runs (verified: SIGINT to
    // sh leaves the command running; sh then dies when the child exits on its
    // own). -pid (negative) reaches sh AND its descendants on POSIX. Windows
    // keeps the direct signal (TerminateProcess semantics kill the tree).
    const groupPid =
      process.platform !== 'win32' && typeof child.pid === 'number' ? -child.pid : child.pid;
    const sig = (sigName: 'SIGINT' | 'SIGKILL'): void => {
      try {
        if (groupPid !== undefined && groupPid !== null) {
          process.kill(groupPid as number, sigName);
        } else {
          child.kill(sigName);
        }
      } catch {
        try {
          child.kill(sigName);
        } catch {
          // best effort — the process may already be gone
        }
      }
    };
    sig('SIGINT');
    escalate = setTimeout(() => sig('SIGKILL'), SHELL_KILL_GRACE_MS);
    escalate.unref?.();
  };

  return { done, kill };
}

// ---------------------------------------------------------------------------
// the folded render (pure)
// ---------------------------------------------------------------------------

/** Keep the LAST maxLines lines; report how many folded away above them. */
export function foldShellOutput(
  output: string,
  maxLines: number = SHELL_OUTPUT_LINE_CAP,
): { lines: string[]; hidden: number } {
  const normalized = output.endsWith('\n') ? output.slice(0, -1) : output;
  if (normalized === '') return { lines: [], hidden: 0 };
  const all = normalized.split('\n');
  if (all.length <= maxLines) return { lines: all, hidden: 0 };
  return { lines: all.slice(all.length - maxLines), hidden: all.length - maxLines };
}

/**
 * The dim folded block + the exit line. Non-zero exits and kill/signal ends
 * render in the error color; a spawn failure is its own single line (there is
 * no exit code to report). Degrades to plain text at color level 0.
 */
export function renderShellBlock(result: ShellRunResult, theme: Theme): string[] {
  if (result.spawnError !== undefined) {
    return [`  ${theme.error('✗')} ${theme.error(`could not start: ${result.spawnError}`)}`];
  }
  const lines: string[] = [];
  const { lines: shown, hidden } = foldShellOutput(result.output);
  if (result.truncated) {
    lines.push(`      ${theme.dim(`… output capped at ${SHELL_OUTPUT_CHAR_CAP / 1024} KB`)}`);
  }
  if (hidden > 0) lines.push(`      ${theme.dim(`… ${hidden} more lines`)}`);
  if (shown.length === 0) {
    lines.push(`  ${theme.dim('⎿ (no output)')}`);
  } else {
    for (const line of shown) lines.push(`      ${theme.dim(line)}`);
  }
  if (result.code === 0) {
    lines.push(`  ${theme.dim('· exit 0')}`);
  } else if (result.code !== null) {
    lines.push(`  ${theme.error(`✗ exit ${result.code}`)}`);
  } else {
    lines.push(
      `  ${theme.error(`✗ killed${result.signal !== null && result.signal !== '' ? ` (${result.signal})` : ''}`)}`,
    );
  }
  return lines;
}
