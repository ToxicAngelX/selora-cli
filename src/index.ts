import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CommanderError } from 'commander';
import { defaultIo, type CliIo } from './context.js';
import { buildProgram } from './program.js';
import { Renderer } from './terminal/render.js';

/**
 * Entry point for the selora CLI.
 *
 * Exported so tests can import and drive it; it never calls process.exit() on
 * success — it only sets `process.exitCode` on failure and lets Node exit
 * naturally once the event loop drains.
 *
 * `io` is injectable for tests (captured stdout/stderr, piped stdin).
 */
export async function main(argv: string[], io: CliIo = defaultIo()): Promise<void> {
  const program = buildProgram(io);

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      // commander has already written help/version/errors to the right stream;
      // exitOverride() turns its process.exit() calls into thrown errors.
      process.exitCode = error.exitCode;
      return;
    }
    process.exitCode = 1;
    const r = new Renderer({ out: io.out, err: io.err, json: false, debug: false });
    r.renderError(error);
  }
}

/**
 * True when this module is the Node entry point. Compares the real (symlink-free)
 * path of process.argv[1] — npm .bin entries are symlinks, and Node resolves
 * symlinks for ESM module URLs but not for argv, so a naive comparison misses
 * bin-link invocations.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (typeof entry !== 'string') return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    process.exitCode = 1;
    console.error(error instanceof Error ? String(error.stack ?? error.message) : String(error));
  });
}

// NOTE: the diff subsystem's public API lives at src/diff/index.ts and is
// built as a separate entry (dist/diff/index.js — used by `npm run
// demo:diff`). It is deliberately NOT re-exported here: re-exporting it would
// inflate the published index.d.ts from ~1 KB to ~45 KB.
