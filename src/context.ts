/**
 * Per-invocation context threaded from index.ts into every command:
 * global flags (--debug/--json/--api-url) plus injectable I/O so tests can
 * drive commands in-process with captured stdout/stderr and piped stdin.
 */

export interface CliIo {
  stdin: NodeJS.ReadableStream;
  /** True when stdin is an interactive terminal. */
  isTTY: boolean;
  out: (s: string) => void;
  err: (s: string) => void;
  /** Raw stdout write with NO trailing newline — streamed chat deltas. */
  writeOut: (s: string) => void;
  /** Raw stderr write with NO trailing newline — the chat prompt, streamed reasoning. */
  writeErr: (s: string) => void;
}

export interface CliContext {
  debug: boolean;
  json: boolean;
  /** Explicit --api-url flag (highest precedence) or undefined. */
  apiUrl: string | undefined;
  io: CliIo;
}

export function defaultIo(): CliIo {
  return {
    stdin: process.stdin,
    isTTY: process.stdin.isTTY === true,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`),
    writeOut: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
  };
}
