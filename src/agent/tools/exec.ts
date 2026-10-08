/**
 * run_command — the exec tool. spawn() with shell:false ALWAYS: on POSIX the
 * command is tokenized by a minimal POSIX-style quote-aware splitter (no
 * shell ever runs, so metacharacters are literal arguments); on Windows the
 * command runs only when the project's selora.json sets
 * agent.allowWindowsCmd: true (opt-in, default off) — and even then via
 * spawn("cmd.exe", ["/d","/s","/c", command]) with shell:false and an explicit
 * args array, never a shell string.
 *
 * 60s timeout default, up to 300s via timeout_ms. stdout and stderr are each
 * captured capped at 8 KB. A non-zero exit code is an honest {ok:false} whose
 * content carries the exit code and output — the model sees the failure and
 * can react, like a real terminal.
 */

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { loadProjectConfig } from '../../config/project.js';
import type { Tool, ToolResult } from '../tool.js';

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 300_000;
const OUTPUT_CAP = 8 * 1024;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

/** Split a POSIX-style command string into argv (quote-aware, no shell). */
export function tokenizeCommand(
  command: string,
): { ok: true; argv: string[] } | { ok: false; error: string } {
  const argv: string[] = [];
  let cur = '';
  let hasCur = false;
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === ' ' || c === '\t') {
      if (hasCur) {
        argv.push(cur);
        cur = '';
        hasCur = false;
      }
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i += 1;
      let closed = false;
      while (i < command.length) {
        const d = command[i]!;
        if (quote === '"' && d === '\\' && i + 1 < command.length) {
          const next = command[i + 1]!;
          if (next === '"' || next === '\\') {
            cur += next;
            hasCur = true;
            i += 2;
            continue;
          }
        }
        if (d === quote) {
          closed = true;
          i += 1;
          break;
        }
        cur += d;
        hasCur = true;
        i += 1;
      }
      if (!closed)
        return { ok: false, error: `unbalanced ${quote === "'" ? 'single' : 'double'} quote` };
      continue;
    }
    if (c === '\\' && i + 1 < command.length) {
      cur += command[i + 1]!;
      hasCur = true;
      i += 2;
      continue;
    }
    cur += c;
    hasCur = true;
    i += 1;
  }
  if (hasCur) argv.push(cur);
  return { ok: true, argv };
}

export const runCommandTool: Tool = {
  name: 'run_command',
  description:
    'Run a shell command in the project directory (no shell is involved: the ' +
    'command is split into arguments and executed directly). 60s timeout ' +
    'default, up to 300s via timeout_ms. stdout and stderr are captured ' +
    `(capped at 8 KB each). On Windows this tool is disabled unless the ` +
    'project selora.json sets agent.allowWindowsCmd to true.',
  kind: 'exec',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The command line to run' },
      timeout_ms: {
        type: 'integer',
        description: `Timeout in milliseconds (1000-${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS})`,
      },
    },
    required: ['command'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const c = r !== null && typeof r['command'] === 'string' ? r['command'] : '<invalid command>';
    return `run_command(${c.length > 80 ? `${c.slice(0, 80)}…` : c})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('run_command: input must be an object');
    if (!Object.hasOwn(r, 'command'))
      return badShape('run_command: missing required field "command"');
    if (typeof r['command'] !== 'string' || r['command'].trim() === '') {
      return badShape('run_command: command must be a non-empty string');
    }
    const command = r['command'] as string;
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (Object.hasOwn(r, 'timeout_ms')) {
      const v = r['timeout_ms'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1000 || v > MAX_TIMEOUT_MS) {
        return badShape(
          `run_command: timeout_ms must be an integer between 1000 and ${MAX_TIMEOUT_MS}`,
        );
      }
      timeoutMs = v;
    }

    if (ctx.signal?.aborted === true) return badShape('run_command: cancelled');
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would run: ${command}`,
        preview: `command: ${command}\ntimeout: ${Math.round(timeoutMs / 1000)}s (cwd: the project root)`,
      };
    }

    if (process.platform === 'win32') {
      const allowed = loadProjectConfig(ctx.cwd).agent?.allowWindowsCmd === true;
      if (!allowed) {
        return badShape(
          'run_command: command execution is disabled on Windows by default — set "agent": {"allowWindowsCmd": true} in the project selora.json to opt in',
        );
      }
      return await execCapture({
        file: 'cmd.exe',
        args: ['/d', '/s', '/c', command],
        cwd: ctx.cwd,
        timeoutMs,
        display: command,
        signal: ctx.signal,
      });
    }

    const tokens = tokenizeCommand(command);
    if (!tokens.ok) return badShape(`run_command: ${tokens.error}`);
    const argv = tokens.argv;
    if (argv.length === 0) return badShape('run_command: empty command');
    return await execCapture({
      file: argv[0]!,
      args: argv.slice(1),
      cwd: ctx.cwd,
      timeoutMs,
      display: command,
      signal: ctx.signal,
    });
  },
};

interface ExecCaptureArgs {
  file: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  display: string;
  signal?: AbortSignal | undefined;
}

/** spawn + capture with timeout and 8 KB-per-stream caps. Never throws. */
async function execCapture(a: ExecCaptureArgs): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    let child;
    try {
      child = spawn(a.file, a.args, {
        cwd: a.cwd,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      resolve(badShape(`run_command: cannot start ${a.display}: ${errText(err)}`));
      return;
    }
    let out = '';
    let errOut = '';
    let outTrunc = false;
    let errTrunc = false;
    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const append = (which: 'out' | 'err', text: string): void => {
      if (which === 'out') {
        if (out.length < OUTPUT_CAP) {
          out += text.slice(0, OUTPUT_CAP - out.length);
          if (out.length >= OUTPUT_CAP) outTrunc = true;
        } else outTrunc = true;
      } else if (errOut.length < OUTPUT_CAP) {
        errOut += text.slice(0, OUTPUT_CAP - errOut.length);
        if (errOut.length >= OUTPUT_CAP) errTrunc = true;
      } else errTrunc = true;
    };
    child.stdout?.on('data', (chunk: Buffer) => append('out', outDecoder.write(chunk)));
    child.stderr?.on('data', (chunk: Buffer) => append('err', errDecoder.write(chunk)));

    const terminate = (): void => {
      if (process.platform === 'win32') {
        try {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
            windowsHide: true,
            shell: false,
            stdio: 'ignore',
          });
          killer.on('error', () => {
            try {
              child.kill();
            } catch {
              /* exited */
            }
          });
          killer.on('exit', (code) => {
            if (code !== 0) {
              try {
                child.kill();
              } catch {
                /* exited */
              }
            }
          });
        } catch {
          try {
            child.kill();
          } catch {
            /* exited */
          }
        }
      } else if (child.pid !== undefined) {
        // Immediate group SIGKILL also covers grandchildren whose stdio is
        // detached and children which ignore SIGTERM; no grace timer can leak.
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* exited */
          }
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, a.timeoutMs);
    const onAbort = (): void => {
      cancelled = true;
      terminate();
    };
    if (a.signal !== undefined) {
      if (a.signal.aborted) onAbort();
      else a.signal.addEventListener('abort', onAbort, { once: true });
    }

    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      a.signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };

    child.on('error', (err: Error) => {
      if (cancelled) return;
      finish(badShape(`run_command: cannot run ${a.display}: ${err.message}`));
    });
    child.on('close', (code: number | null) => {
      append('out', outDecoder.end());
      append('err', errDecoder.end());
      if (cancelled) {
        finish(badShape(`run_command: cancelled: ${a.display}`));
        return;
      }
      if (timedOut) {
        finish(
          badShape(`run_command: timed out after ${Math.round(a.timeoutMs / 1000)}s: ${a.display}`),
        );
        return;
      }
      const parts: string[] = [];
      if (out !== '') parts.push(out + (outTrunc ? '\n(… stdout truncated at 8 KB)' : ''));
      if (errOut !== '') parts.push(errOut + (errTrunc ? '\n(… stderr truncated at 8 KB)' : ''));
      const output = parts.join('\n');
      if (code === 0)
        return finish({
          ok: true,
          summary: `ran: ${a.display}${output !== '' ? ` (${output.split('\n').length} lines of output)` : ' (no output)'}`,
          content: output !== '' ? output : '(no output)',
        });
      const reason = code !== null ? `exit code ${code}` : 'terminated without an exit code';
      finish({
        ok: false,
        summary: `command failed (${reason}): ${a.display}`,
        content: `Command failed with ${reason}.\n${output !== '' ? output : '(no output)'}`,
      });
    });
  });
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
