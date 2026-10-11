/**
 * The commander program: every command registration in one place, exported as
 * `buildProgram(io)` so the completion generator (and its tests) can walk the
 * LIVE program — command names, descriptions, and options — instead of a
 * hand-maintained list that would drift. `main()` in index.ts parses argv
 * against the program built here.
 */

import { Command, Help } from 'commander';
import pc from 'picocolors';
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
import { runTrust } from './commands/trust.js';
import { runInit } from './commands/init.js';
import { runRun } from './commands/run.js';
import { runResume } from './commands/resume.js';
import { runSessions } from './commands/sessions.js';
import { runCompletion } from './commands/completion.js';
import { runUpdate } from './commands/update.js';
import { THEME_NAMES } from './ui/theme.js';
import { logoLines } from './ui/logo.js';

export function renderBanner(width = 80): string {
  const lines: string[] = [''];
  if (width >= 60) {
    const logo = logoLines();
    const colors = [pc.cyan, pc.blue, pc.magenta, pc.magenta, pc.cyan];
    for (let i = 0; i < logo.length; i += 1) {
      lines.push(colors[i % colors.length]!(logo[i]!));
    }
    lines.push('');
  }
  lines.push(
    `  ${pc.cyan('✦')} ${pc.bold('SELORA')} ${pc.dim(`[v${VERSION}]`)} ${pc.dim('·')} ${pc.dim('AI Gateway & Agent CLI')}`,
  );
  return lines.join('\n');
}

export function buildProgram(io: CliIo): Command {
  const program = new Command();

  program
    .name('selora')
    .description('Open-source CLI for the Selora API gateway')
    .version(VERSION, '-V, --version', 'output the CLI version')
    .exitOverride()
    .showHelpAfterError('(Run `selora --help` for usage.)');

  program.configureOutput({
    writeOut: (str) => io.writeOut(str),
    writeErr: (str) => io.writeErr(str),
  });

  program.configureHelp({
    subcommandTerm: (cmd) => {
      const args = cmd.registeredArguments
        .map((a) =>
          a.required
            ? `<${a.name()}${a.variadic ? '...' : ''}>`
            : `[${a.name()}${a.variadic ? '...' : ''}]`,
        )
        .join(' ');
      return cmd.name() + (args ? ' ' + args : '');
    },
    styleTitle: (str) => pc.bold(str),
    styleUsage: (str) => {
      return str
        .split(' ')
        .map((word) => {
          if (word === 'selora') return pc.cyan(word);
          if (word.startsWith('-') || word === '[options]' || word === '[command]')
            return pc.dim(word);
          if (word.startsWith('<') || word.startsWith('[')) return pc.yellow(word);
          return pc.cyan(word);
        })
        .join(' ');
    },
    styleCommandDescription: (str) => pc.dim(str),
    styleSubcommandTerm: (str) => {
      const spaceIdx = str.indexOf(' ');
      if (spaceIdx === -1) {
        return pc.cyan(str);
      }
      const name = str.slice(0, spaceIdx);
      const args = str.slice(spaceIdx + 1);
      return `${pc.cyan(name)} ${pc.dim(args)}`;
    },
    styleSubcommandDescription: (str) => pc.dim(str),
    styleOptionTerm: (str) => {
      return str
        .replace(/(--?[a-zA-Z0-9-]+)/g, (m) => pc.cyan(m))
        .replace(/(<[^>]+>|\[[^\]]+\])/g, (m) => pc.yellow(m));
    },
    styleOptionDescription: (str) => pc.dim(str),
    formatHelp: (cmd, helper) => {
      const text = Help.prototype.formatHelp.call(helper, cmd, helper);
      if (!cmd.parent) {
        return renderBanner(helper.helpWidth ?? 80) + '\n\n' + text;
      }
      return text;
    },
  });

  program.helpCommand('help [command]', 'display help for command');
  const helpCmd = (program as unknown as { _helpCommand?: { _hidden: boolean } })._helpCommand;
  if (helpCmd) {
    helpCmd._hidden = true;
  }

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

  // ---------------------------------------------------------------------------
  // ⚡ Core & Agent
  // ---------------------------------------------------------------------------

  const chatCmd = program
    .command('chat')
    .helpGroup('⚡ Core & Agent:')
    .description(
      'chat with a model in an interactive streaming session (agent tools, permission-gated)',
    )
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this session (default: the configured default model)')
    .option('--safe', 'restrict the agent to read-only tools')
    .option('--yes', 'auto-approve tool execution non-interactively (still respects --safe)')
    .option('--dry-run', 'show proposed file changes as diffs without writing anything')
    .option('--diff-view <view>', 'diff layout: unified, split, or auto')
    .option('--diff-palette <name>', 'diff palette: classic, colorblind, or mono')
    .action(async (opts: Record<string, unknown>) => {
      await runChat(ctxFor(chatCmd), {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        safe: opts['safe'] === true,
        yes: opts['yes'] === true,
        dryRun: opts['dryRun'] === true,
        diffView: typeof opts['diffView'] === 'string' ? opts['diffView'] : undefined,
        diffPalette: typeof opts['diffPalette'] === 'string' ? opts['diffPalette'] : undefined,
      });
    });

  // [prompt...] variadic (joined with spaces): `selora run check @img.png`
  // works unquoted, and a missing argument still gets the command's own
  // honest usage error rather than commander's generic one.
  const runCmd = program
    .command('run [prompt...]')
    .helpGroup('⚡ Core & Agent:')
    .description(
      'one-shot streaming completion with the agent tool loop (permissions gated); @<path> attaches images',
    )
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', 'model for this request')
    .option('--session <name>', 'resume/create a named conversation session (crash-safe)')
    .option('--safe', 'restrict the agent to read-only tools')
    .option('--yes', 'auto-approve tool execution non-interactively (still respects --safe)')
    .option('--max-turns <n>', 'agent turn cap (default: 25; selora.json agent.maxTurns)')
    .option('--dry-run', 'show proposed file changes as diffs without writing anything')
    .option('--diff-view <view>', 'diff layout: unified, split, or auto')
    .option('--diff-palette <name>', 'diff palette: classic, colorblind, or mono')
    .action(async (promptParts: unknown, opts: Record<string, unknown>) => {
      const maxTurnsRaw = opts['maxTurns'];
      let maxTurns: number | undefined;
      if (typeof maxTurnsRaw === 'string' && maxTurnsRaw.trim() !== '') {
        const n = Number(maxTurnsRaw);
        maxTurns = Number.isInteger(n) ? n : Number.NaN;
      }
      const parts = Array.isArray(promptParts)
        ? promptParts.filter((p): p is string => typeof p === 'string')
        : [];
      await runRun(ctxFor(runCmd), parts.length > 0 ? parts.join(' ') : undefined, {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        session: typeof opts['session'] === 'string' ? opts['session'] : undefined,
        yes: opts['yes'] === true,
        safe: opts['safe'] === true,
        maxTurns,
        dryRun: opts['dryRun'] === true,
        diffView: typeof opts['diffView'] === 'string' ? opts['diffView'] : undefined,
        diffPalette: typeof opts['diffPalette'] === 'string' ? opts['diffPalette'] : undefined,
      });
    });

  const resumeCmd = program
    .command('resume [name]')
    .helpGroup('⚡ Core & Agent:')
    .description('resume a saved conversation in the chat REPL (default: the most recent session)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--model <id>', "model for this session (default: the session's model)")
    .option('--safe', 'restrict the agent to read-only tools')
    .option('--yes', 'auto-approve tool execution non-interactively (still respects --safe)')
    .option('--dry-run', 'show proposed file changes as diffs without writing anything')
    .option('--diff-view <view>', 'diff layout: unified, split, or auto')
    .option('--diff-palette <name>', 'diff palette: classic, colorblind, or mono')
    .action(async (name: unknown, opts: Record<string, unknown>) => {
      await runResume(ctxFor(resumeCmd), typeof name === 'string' ? name : undefined, {
        model: typeof opts['model'] === 'string' ? opts['model'] : undefined,
        safe: opts['safe'] === true,
        yes: opts['yes'] === true,
        dryRun: opts['dryRun'] === true,
        diffView: typeof opts['diffView'] === 'string' ? opts['diffView'] : undefined,
        diffPalette: typeof opts['diffPalette'] === 'string' ? opts['diffPalette'] : undefined,
      });
    });

  const sessionsCmd = program
    .command('sessions [action] [name]')
    .helpGroup('⚡ Core & Agent:')
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

  // ---------------------------------------------------------------------------
  // 👤 Account & Usage
  // ---------------------------------------------------------------------------

  const loginCmd = program
    .command('login')
    .helpGroup('👤 Account & Usage:')
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
    .helpGroup('👤 Account & Usage:')
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
    .helpGroup('👤 Account & Usage:')
    .description('show the account, plan, trial, and wallet for the stored key')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runWhoami(ctxFor(whoamiCmd));
    });

  const balanceCmd = program
    .command('balance')
    .helpGroup('👤 Account & Usage:')
    .description('show wallet balance, plan term, and rolling spend windows')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runBalance(ctxFor(balanceCmd));
    });

  const usageCmd = program
    .command('usage')
    .helpGroup('👤 Account & Usage:')
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

  // ---------------------------------------------------------------------------
  // ⚙ Configuration & Models
  // ---------------------------------------------------------------------------

  const modelsCmd = program
    .command('models')
    .helpGroup('⚙ Configuration & Models:')
    .description('list available models with pricing')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async () => {
      await runModels(ctxFor(modelsCmd));
    });

  const modelCmd = program
    .command('model [id]')
    .helpGroup('⚙ Configuration & Models:')
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
    .helpGroup('⚙ Configuration & Models:')
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

  const themeCmd = program
    .command('theme [name]')
    .helpGroup('⚙ Configuration & Models:')
    .description(`show the UI theme, or set it (${THEME_NAMES.join(', ')})`)
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async (name: unknown, _opts: Record<string, unknown>) => {
      await runTheme(ctxFor(themeCmd), { name: typeof name === 'string' ? name : undefined });
    });

  const initCmd = program
    .command('init')
    .helpGroup('⚙ Configuration & Models:')
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

  const trustCmd = program
    .command('trust [action] [dir]')
    .helpGroup('⚙ Configuration & Models:')
    .description('manage trusted workspaces (list, add, remove; default: list)')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .action(async (action: unknown, dir: unknown, _opts: Record<string, unknown>) => {
      await runTrust(ctxFor(trustCmd), {
        action: typeof action === 'string' ? action : undefined,
        dir: typeof dir === 'string' ? dir : undefined,
      });
    });

  // ---------------------------------------------------------------------------
  // 🛠 Utilities
  // ---------------------------------------------------------------------------

  // [shell] optional; runCompletion defaults from $SHELL when omitted.
  const completionCmd = program
    .command('completion [shell]')
    .helpGroup('🛠 Utilities:')
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

  const updateCmd = program
    .command('update')
    .helpGroup('🛠 Utilities:')
    .description('check for a newer selora on npm and install it')
    .option('--debug', 'show request/response details (always redacted)')
    .option('--json', 'print machine-readable JSON only')
    .option('--api-url <url>', 'Selora gateway base URL for this invocation')
    .option('--check', 'only report availability — never install')
    .option('--yes', 'install without prompting')
    .action(async (_opts: Record<string, unknown>) => {
      await runUpdate(ctxFor(updateCmd), {
        check: updateCmd.opts()['check'] === true,
        yes: updateCmd.opts()['yes'] === true,
      });
    });

  return program;
}
