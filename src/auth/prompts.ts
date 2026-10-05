/**
 * Interactive prompts: text and hidden password input over one shared
 * readline interface. Password input is muted (nothing echoed — including
 * backspace erases). When stdin is not a TTY, lines are read plainly from
 * the stream.
 *
 * Lines are BUFFERED: with piped stdin, all input can arrive before the next
 * question is asked, so a plain rl.question() would drop the extra lines and
 * throw "readline was closed". We queue lines and hand them to waiters in
 * order. Ctrl+C / Ctrl+D close the interface → PromptClosedError, so callers
 * exit cleanly with no stack trace.
 */

import { Writable } from 'node:stream';
import * as readline from 'node:readline';

export class PromptClosedError extends Error {
  constructor() {
    super('prompt closed');
    this.name = 'PromptClosedError';
  }
}

export interface Prompter {
  text(label: string): Promise<string>;
  password(label: string): Promise<string>;
  /** y/N confirm. Unanswered/other → false. */
  confirm(label: string): Promise<boolean>;
  close(): void;
}

export interface PrompterInput {
  stdin: NodeJS.ReadableStream;
  /** Whether stdin is a TTY (echo suppression only matters interactively). */
  isTTY: boolean;
  /** Where prompt labels go (stderr by default). */
  err: (s: string) => void;
}

/** Muted-echo Writable: forwards to dest until muted, then swallows. */
class MutedWritable extends Writable {
  private muted = false;

  constructor(private readonly dest: (s: string) => void) {
    super();
  }

  mute(): void {
    this.muted = true;
  }

  unmute(): void {
    this.muted = false;
  }

  override _write(
    chunk: string | Buffer,
    _enc: BufferEncoding,
    cb: (err?: Error | null) => void,
  ): void {
    if (!this.muted) this.dest(chunk.toString());
    cb();
  }
}

interface Waiter {
  resolve: (line: string) => void;
  reject: (err: Error) => void;
}

export function createPrompter(input: PrompterInput): Prompter {
  const mutedOut = new MutedWritable(input.err);
  const rl = readline.createInterface({ input: input.stdin, output: mutedOut });

  const queued: string[] = [];
  const waiters: Waiter[] = [];
  let closed = false;

  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) w.resolve(line);
    else queued.push(line);
  });
  const failAll = (): void => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()?.reject(new PromptClosedError());
    }
  };
  rl.on('close', failAll);
  rl.on('SIGINT', failAll);

  function nextLine(): Promise<string> {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.reject(new PromptClosedError());
    return new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  async function ask(label: string, hidden: boolean): Promise<string> {
    mutedOut.unmute();
    if (label !== '') mutedOut.write(`${label} `);
    if (hidden && input.isTTY) mutedOut.mute();
    try {
      const answer = await nextLine();
      return answer.trim();
    } finally {
      mutedOut.unmute();
    }
  }

  return {
    text: (label) => ask(`${label} `, false),
    password: (label) => ask(`${label} `, true),
    confirm: async (label) => {
      const answer = await ask(`${label} (y/N) `, false);
      const lower = answer.toLowerCase();
      return lower === 'y' || lower === 'yes';
    },
    close: () => {
      rl.close();
    },
  };
}
