import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError } from 'commander';
import { VERSION } from './version.js';
import { defaultIo, type CliContext, type CliIo } from './context.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runWhoami } from './commands/whoami.js';
import { runBalance } from './commands/balance.js';
import { runUsage } from './commands/usage.js';
import { runModels } from './commands/models.js';
import { runModel } from './commands/model.js';
import { runKeys } from './commands/keys.js';
import { runChat } from './commands/chat.js';
import { runInit } from './commands/init.js';
import { runRun } from './commands/run.js';
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

  const loginCmd = program
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
      await runLogin(ctxFor(loginCmd), flags);
    });

  const logoutCmd = program
    .command('logout')
    .description('clear the stored API key (optionally revoke it server-side)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--revoke', 'also revoke the key on the server (matches by key hint)')
    .option('--yes', 'confirm --revoke non-interactively')
    .action(async (opts: Record<string, unknown>) => {
      await runLogout(ctxFor(logoutCmd), {
        revoke: opts['revoke'] === true,
        yes: opts['yes'] === true,
      });
    });

  const whoamiCmd = program
    .command('whoami')
    .description('show the account, plan, trial, and wallet for the stored key')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runWhoami(ctxFor(whoamiCmd));
    });

  const balanceCmd = program
    .command('balance')
    .description('show wallet balance, plan term, and rolling spend windows')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runBalance(ctxFor(balanceCmd));
    });

  const usageCmd = program
    .command('usage')
    .description('show request/token/spend usage (today, this week, or this month)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--today', 'usage for the last 1 day')
    .option('--week', 'usage for the last 7 days')
    .option('--month', 'usage for the last 30 days')
    .option(
      '--by-model',
      'add the by-model table — labeled all-time because the API does not period-filter it',
    )
    .action(async (opts: Record<string, unknown>) => {
      await runUsage(ctxFor(usageCmd), {
        today: opts['today'] === true,
        week: opts['week'] === true,
        month: opts['month'] === true,
        byModel: opts['byModel'] === true,
      });
    });

  const modelsCmd = program
    .command('models')
    .description('list available models with pricing')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runModels(ctxFor(modelsCmd));
    });

  const modelCmd = program
    .command('model [id]')
    .description('show the default model, or set it to <id>')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--unset', 'clear the configured default model')
    .action(async (id: unknown, opts: Record<string, unknown>) => {
      await runModel(
        ctxFor(modelCmd),
        typeof id === 'string' ? id : undefined,
        { unset: opts['unset'] === true },
      );
    });

  const keysCmd = program
    .command('keys [action] [arg]')
    .description('manage API keys (list, create, revoke; default: list)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--name <name>', 'name for the new key (keys create)')
    .option('--yes', 'confirm revoke non-interactively (keys revoke)')
    .action(async (action: unknown, arg: unknown, opts: Record<string, unknown>) => {
      await runKeys(
        ctxFor(keysCmd),
        typeof action === 'string' ? action : undefined,
        typeof arg === 'string' ? arg : undefined,
        { name: typeof opts['name'] === 'string' ? opts['name'] : undefined, yes: opts['yes'] === true },
      );
    });

  const chatCmd = program
    .command('chat')
    .description('chat with a model in an interactive streaming session')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this session (default: the configured default model)')
    .action(async (opts: Record<string, unknown>) => {
      await runChat(ctxFor(chatCmd), {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
      });
    });

  const initCmd = program
    .command('init')
    .description('write a project-local selora.json (model + future agent context globs)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model to store (default: the configured default model)')
    .option('--force', 'overwrite an existing selora.json')
    .action(async (opts: Record<string, unknown>) => {
      await runInit(ctxFor(initCmd), {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        force: opts['force'] === true,
      });
    });

  // [prompt] (optional at the commander level) so a missing argument gets the
  // command's own honest usage error rather than commander's generic one.
  const runCmd = program
    .command('run [prompt]')
    .description('one-shot streaming completion for a prompt (no REPL)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this request')
    .action(async (prompt: unknown, opts: Record<string, unknown>) => {
      await runRun(
        ctxFor(runCmd),
        typeof prompt === 'string' ? prompt : undefined,
        { model: typeof opts['model'] === 'string' ? opts['model'] : undefined },
      );
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
