/**
 * Hermetic-test helpers: temp XDG/HOME env per test (restored after), temp
 * env save/restore, captured stdout/stderr, and a piped-stdin factory for
 * driving prompts in-process.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach } from 'vitest';
import type { CliIo } from '../../src/context.js';

const KEYS = [
  'XDG_CONFIG_HOME',
  'APPDATA',
  'HOME',
  'SELORA_API_URL',
  'SELORA_API_KEY',
  'NO_COLOR',
  'TERM',
  'SHELL',
];

export interface TempEnv {
  dir: string;
  xdg: string;
}

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  process.exitCode = undefined;
});

/** Create a fresh temp dir and point XDG_CONFIG_HOME (and HOME) at it. */
export function freshEnv(): TempEnv {
  const dir = mkdtempSync(join(tmpdir(), 'selora-test-'));
  const xdg = join(dir, 'xdg');
  process.env['XDG_CONFIG_HOME'] = xdg;
  process.env['HOME'] = dir;
  delete process.env['SELORA_API_KEY'];
  return { dir, xdg };
}

/** Point SELORA_API_URL at the mock server. */
export function useApiUrl(url: string): void {
  process.env['SELORA_API_URL'] = url;
}

export interface Captured {
  out: string[];
  err: string[];
  /** Everything written via raw writeOut, concatenated with no added newlines. */
  outText(): string;
  /** Everything written via raw writeErr, concatenated with no added newlines. */
  errText(): string;
  all(): string;
}

export function capturedIo(): { io: CliIo; cap: Captured } {
  const out: string[] = [];
  const err: string[] = [];
  let outRaw = '';
  let errRaw = '';
  const cap: Captured = {
    out,
    err,
    outText: () => outRaw,
    errText: () => errRaw,
    all: () => [...out, ...err].join('\n'),
  };
  const io: CliIo = {
    stdin: Readable.from([]),
    isTTY: false,
    out: (s) => {
      out.push(s);
    },
    err: (s) => {
      err.push(s);
    },
    writeOut: (s) => {
      outRaw += s;
    },
    writeErr: (s) => {
      errRaw += s;
    },
  };
  return { io, cap };
}

/** A stdin that yields the given lines (simulates piping). */
export function pipedStdin(lines: string[]): NodeJS.ReadableStream {
  return Readable.from(lines.map((l) => `${l}\n`));
}

/** Clean up all temp dirs created by freshEnv in this file. */
export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
