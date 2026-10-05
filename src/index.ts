import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { VERSION } from './version.js';
import { defaultIo, type CliContext, type CliIo } from './context.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runWhoami } from './commands/whoami.js';
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
  const program = new Command();

  program
    .name('selora')
    .description('Open-source CLI for the Selora API gateway')
    .version(VERSION, '-V, --version', 'output the CLI version')
    .exitOverride()
    .showHelpAfterError('(Run `selora --help` for usage.)');

  // Global options live on the root program AND on each subcommand so both
  // `selora --json whoami` and `selora whoami --json` work.
  program
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation');

  const ctxFor = (cmd: Command): CliContext => {
    const root = program.opts<Record<string, unknown>>();
    const sub = cmd.opts<Record<string, unknown>>();
    const flag = (name: string): boolean => Boolean(root[name] ?? sub[name]);
    const apiUrlRaw = root['apiUrl'] ?? sub['apiUrl'];
    return {
      debug: flag('debug'),
      json: flag('json'),
      apiUrl: typeof apiUrlRaw === 'string' && apiUrlRaw.trim() !== '' ? apiUrlRaw : undefined,
      io,
    };
  };

  program
    .command('login')
    .description('log in with email + password (creates a CLI API key), or validate an existing key')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--key [value]', 'log in with an API key (prompts or reads stdin when the value is omitted)')
    .action(async (opts: Record<string, unknown>) => {
      const key = opts['key'];
      const flags = {
        key: typeof key === 'string' ? key : key === true ? true : undefined,
      };
      await runLogin(ctxFor(program.commands[0]!), flags);
    });

  program
    .command('logout')
    .description('clear the stored API key (optionally revoke it server-side)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--revoke', 'also revoke the key on the server (matches by key hint)')
    .option('--yes', 'confirm --revoke non-interactively')
    .action(async (opts: Record<string, unknown>) => {
      await runLogout(ctxFor(program.commands[1]!), {
        revoke: opts['revoke'] === true,
        yes: opts['yes'] === true,
      });
    });

  program
    .command('whoami')
    .description('show the account, plan, trial, and wallet for the stored key')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runWhoami(ctxFor(program.commands[2]!));
    });

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
