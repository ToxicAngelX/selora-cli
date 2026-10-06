/**
 * The commander program: every command registration in one place, exported as
 * `buildProgram(io)` so the completion generator (and its tests) can walk the
 * LIVE program — command names, descriptions, and options — instead of a
 * hand-maintained list that would drift. `main()` in index.ts parses argv
 * against the program built here.
 */

import { Command } from 'commander';
import { VERSION } from './version.js';
import type { CliContext, CliIo } from './context.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runWhoami } from './commands/whoami.js';
import { runBalance } from './commands/balance.js';
import { runUsage } from './commands/usage.js';
import { runModels } from './commands/models.js';
import { runModel } from './commands/model.js';
import { runKeys } from './commands/keys.js';
import { runChat } from './commands/chat.js';
import { runTheme } from './commands/theme.js';
import { runInit } from './commands/init.js';
import { runRun } from './commands/run.js';
import { runSessions } from './commands/sessions.js';
import { runCompletion } from './commands/completion.js';

export function buildProgram(io: CliIo): Command {
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
    .description(
      'log in with email + password (creates a CLI API key), or validate an existing key',
    )
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option(
      '--key [value]',
      'log in with an API key (prompts or reads stdin when the value is omitted)',
    )
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
      await runModel(ctxFor(modelCmd), typeof id === 'string' ? id : undefined, {
        unset: opts['unset'] === true,
      });
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
        {
          name: typeof opts['name'] === 'string' ? opts['name'] : undefined,
          yes: opts['yes'] === true,
        },
      );
    });

  const chatCmd = program
    .command('chat')
    .description(
      'chat with a model in an interactive streaming session (agent tools, permission-gated)',
    )
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this session (default: the configured default model)')
    .option('--safe', 'restrict the agent to read-only tools')
    .option('--yes', 'auto-approve tool execution non-interactively (still respects --safe)')
    .action(async (opts: Record<string, unknown>) => {
      await runChat(ctxFor(chatCmd), {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        safe: opts['safe'] === true,
        yes: opts['yes'] === true,
      });
    });

  const themeCmd = program
    .command('theme [name]')
    .description('show the UI theme, or set it (galaxy, nebula, mono)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async (name: unknown, _opts: Record<string, unknown>) => {
      await runTheme(ctxFor(themeCmd), { name: typeof name === 'string' ? name : undefined });
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
    .description('one-shot streaming completion with the agent tool loop (permissions gated)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this request')
    .option('--session <name>', 'resume/create a named conversation session')
    .option('--safe', 'restrict the agent to read-only tools')
    .option('--yes', 'auto-approve tool execution non-interactively (still respects --safe)')
    .option('--max-turns <n>', 'agent turn cap (default: 25; selora.json agent.maxTurns)')
    .action(async (prompt: unknown, opts: Record<string, unknown>) => {
      const maxTurnsRaw = opts['maxTurns'];
      let maxTurns: number | undefined;
      if (typeof maxTurnsRaw === 'string' && maxTurnsRaw.trim() !== '') {
        const n = Number(maxTurnsRaw);
        maxTurns = Number.isInteger(n) ? n : Number.NaN;
      }
      await runRun(ctxFor(runCmd), typeof prompt === 'string' ? prompt : undefined, {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        session: typeof opts['session'] === 'string' ? opts['session'] : undefined,
        yes: opts['yes'] === true,
        safe: opts['safe'] === true,
        maxTurns,
      });
    });

  const sessionsCmd = program
    .command('sessions [action] [name]')
    .description('manage agent conversation sessions (list, show, rm; default: list)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--yes', 'confirm rm non-interactively')
    .action(async (action: unknown, name: unknown, opts: Record<string, unknown>) => {
      await runSessions(
        ctxFor(sessionsCmd),
        typeof action === 'string' ? action : undefined,
        typeof name === 'string' ? name : undefined,
        { yes: opts['yes'] === true },
      );
    });

  // [shell] optional; runCompletion defaults from $SHELL when omitted.
  const completionCmd = program
    .command('completion [shell]')
    .description('print a shell completion script (bash, zsh, or fish)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async (shell: unknown, _opts: Record<string, unknown>) => {
      await runCompletion(
        ctxFor(completionCmd),
        typeof shell === 'string' ? shell : undefined,
        program,
      );
    });

  return program;
}
