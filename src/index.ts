import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import pc from 'picocolors';
import { VERSION } from './version.js';

/**
 * Entry point for the selora CLI.
 *
 * Exported so tests can import and drive it; it never calls process.exit() on
 * success — it only sets `process.exitCode` on failure and lets Node exit
 * naturally once the event loop drains.
 */
export async function main(argv: string[]): Promise<void> {
  const program = new Command();

  program
    .name('selora')
    .description('Open-source CLI for the Selora API gateway')
    .version(VERSION, '-V, --version', 'output the CLI version')
    .exitOverride()
    .showHelpAfterError('(Run `selora --help` for usage.)');

  // Commands will be registered here from src/commands/*.ts in later phases.

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
    console.error(pc.red(error instanceof Error ? error.stack : String(error)));
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
    console.error(pc.red(error instanceof Error ? error.stack : String(error)));
  });
}
