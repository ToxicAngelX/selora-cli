/**
 * `selora chat [--model <id>] [--safe] [--yes]` — the interactive agent REPL
 * (v0.3: Claude-Code-style, galaxy-themed).
 *
 * What changed in v0.3 (docs/commands/chat.md):
 *  - a startup screen (per-character gradient logo + twinkling starfield +
 *    info box: version, model, cwd, plan, tips) — TTY only, never --json.
 *    On a color-capable TTY it plays as a sub-second animated sweep
 *    (SELORA_NO_ANIMATE opts out; short terminals fall back to static);
 *  - every message runs the AGENT LOOP with the full toolset attached
 *    (permission-gated per call; --safe restricts to read-only tools, --yes
 *    auto-approves). One shared readline feeds both the prompt and the
 *    permission menu;
 *  - replies stream through the markdown renderer (completed lines render
 *    live; fenced code blocks render as dim boxed units);
 *  - tool calls render as `● Name(args)` + indented `⎿` result lines with
 *    collapsed content and colored diffs for edits;
 *  - a galaxy spinner (✦ Warping… 12s · tokens) runs while a reply streams —
 *    only on a real TTY stderr, never under NO_COLOR/non-TTY/--json;
 *  - slash commands: /help /model /theme /clear /tools /permissions /cost
 *    /exit; a session summary (duration · tokens · files changed) on exit.
 *
 * Unchanged v0.2 behavior: model verification before the REPL starts
 * (404 → the backend's honest message, no REPL), in-memory-only history
 * (aborted/failed turns dropped entirely), reasoning deltas dim-gray on
 * stderr, footers ONLY when the usage chunk actually arrived, Ctrl+C aborts
 * a reply and keeps the session, Ctrl+D/Ctrl+C at the prompt exits.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings, saveConfig } from '../config/index.js';
import { loadProjectConfig } from '../config/project.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { getModel } from '../api/endpoints/models.js';
import { getMe } from '../api/endpoints/me.js';
import type { ChatMessage } from '../api/endpoints/chat.js';
import { getStoredKey } from '../auth/storage.js';
import { PromptClosedError } from '../auth/prompts.js';
import { Renderer } from '../terminal/render.js';
import { chatFooterLine, formatChatCost } from './chat-footer.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';
import { VERSION } from '../version.js';
import { formatCount, formatDurationCompact } from '../format.js';
import { microToWireString } from '../money.js';
import { runAgentLoop, DEFAULT_MAX_TURNS } from '../agent/loop.js';
import { builtinTools } from '../agent/tools/index.js';
import {
  SessionAllows,
  createInteractiveAsker,
  createAutoAsker,
  createDenyingAsker,
  type PermissionAsker,
} from '../agent/permissions.js';
import type { Tool } from '../agent/tool.js';
import { themeFor, isThemeName, THEME_NAMES, type ThemeName } from '../ui/theme.js';
import { renderStartupFrames } from '../ui/logo.js';
import { playFrames } from '../ui/animate.js';
import { MarkdownStream } from '../ui/markdown.js';
import { renderUnifiedDiff } from '../ui/diff.js';
import { Spinner } from '../ui/spinner.js';
import { diffStyleFor, markdownStyleFor, renderToolResult, renderToolStart } from '../ui/chatui.js';

export interface ChatFlags {
  model?: string | undefined;
  /** Restrict the agent to read-only tools. */
  safe?: boolean;
  /** Auto-approve tool execution (non-interactive; still filtered by --safe). */
  yes?: boolean;
}

/**
 * Minimal test/automation seam: if provided, called once per turn with a
 * function that aborts the in-flight request (what Ctrl+C does live).
 */
export interface ChatHooks {
  registerInterrupt?: ((interrupt: () => void) => void) | undefined;
}

interface SessionModel {
  id: string;
  displayName: string;
}

/** Plain setTimeout-as-promise for the startup animation's frame cadence. */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Verifies a model id via the public /v1/models/:id route; 404 propagates. */
async function verifyModel(client: SeloraClient, id: string): Promise<SessionModel> {
  const m = await getModel(client, id);
  return { id: m.id !== '' ? m.id : id, displayName: m.display_name };
}

function modelLabel(m: SessionModel): string {
  return m.displayName !== '' ? `${m.id} (${m.displayName})` : m.id;
}

/** The startup box's plan line — honest, degrades to 'unknown' on failure. */
async function fetchPlanLabel(client: SeloraClient): Promise<string> {
  try {
    const me = await getMe(client);
    if (me.plan_term !== null && me.plan_term.plan_name !== null) return me.plan_term.plan_name;
    if (me.plan_term !== null && me.plan_term.kind === 'trial') return 'free trial';
    if (me.plan !== null && me.plan.name !== '') return me.plan.name;
    return 'no active plan';
  } catch {
    return 'unknown';
  }
}

function shortCwd(): string {
  const cwd = process.cwd();
  const home = process.env['HOME'] ?? '';
  return home !== '' && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
}

/** Tools that count as "files changed" for the exit summary. */
const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_dir',
  'move',
  'copy',
  'remove',
  'git_commit',
]);

export async function runChat(
  ctx: CliContext,
  flags: ChatFlags,
  hooks: ChatHooks = {},
): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  if (!ctx.io.isTTY) {
    process.exitCode = 1;
    const message = 'selora chat needs an interactive terminal — use: selora run "<prompt>"';
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'http_error', message } });
    else r.fail(message);
    return;
  }

  // Fail fast on a missing key: chat is the API-key-only route.
  if (getStoredKey() === undefined) {
    r.renderError(
      new SeloraApiError({ kind: 'auth', message: 'You are not logged in. Run: selora login' }),
    );
    return;
  }

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  const flagModel = flags.model !== undefined ? flags.model.trim() : '';
  const wanted =
    flagModel !== '' ? flagModel : (loadConfig().defaultModel ?? DEFAULT_MODEL_FALLBACK);

  let current: SessionModel;
  try {
    current = await verifyModel(client, wanted);
  } catch (err) {
    // Unknown model: the backend's own "Model not available" message, verbatim,
    // plus the listing hint. The REPL is NOT started on a bad model.
    process.exitCode = 1;
    if (err instanceof SeloraApiError) {
      if (err.status === 404) {
        if (ctx.json) r.jsonOut({ ok: false, error: err.toJson() });
        else {
          r.fail(err.apiMessage ?? err.message);
          r.bullet('List available models with: selora models');
        }
        return;
      }
      r.renderError(err);
      return;
    }
    r.renderError(err);
    return;
  }

  // The galaxy theme. Color level keys off the REAL stdout (a captured test
  // io is "TTY" but a piped stdout is not — NO_COLOR/non-TTY stay plain).
  // isThemeName guards the config value: an unknown stored name falls back to
  // galaxy instead of needing an edit here for every new theme.
  const configuredTheme = loadConfig().theme;
  let themeName: ThemeName =
    configuredTheme !== undefined && isThemeName(configuredTheme) ? configuredTheme : 'galaxy';
  let theme = themeFor(themeName, process.stdout.isTTY === true);

  if (!ctx.json) {
    const plan = await fetchPlanLabel(client);
    const width = process.stdout.columns ?? 80;
    const info = { version: VERSION, model: modelLabel(current), cwd: shortCwd(), plan };
    const frames = renderStartupFrames(info, theme, { width });
    // Animation gates on the REAL stdout (a captured test io never animates),
    // an enabled theme (level 0 covers NO_COLOR, TERM=dumb, mono, pipes), and
    // enough rows to redraw without hitting the scroll-region top.
    const animate =
      process.stdout.isTTY === true &&
      theme.level > 0 &&
      process.env['SELORA_NO_ANIMATE'] === undefined &&
      (process.stdout.rows ?? 24) >= frames[0]!.length + 2;
    if (animate) {
      await playFrames(frames, { write: ctx.io.writeOut, sleep });
    } else {
      // The final frame — the same pure output the animation lands on.
      for (const line of frames[frames.length - 1]!) r.line(line);
    }
  }

  r.ok(`Connected to ${modelLabel(current)}`);

  // Persistent readline interface over stdin (the buffering pattern from
  // auth/prompts.ts): lines queue while a turn is streaming, prompts go to
  // stderr, and readline's own echo is forwarded to raw stdout.
  const echo = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      ctx.io.writeOut(chunk.toString());
      cb();
    },
  });
  const rl = readline.createInterface({
    input: ctx.io.stdin,
    output: echo,
    terminal: ctx.io.isTTY,
  });

  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;
  let currentAbort: AbortController | null = null;

  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) w.resolve(line);
    else queued.push(line);
  });
  const closeLines = (): void => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!.reject(new PromptClosedError());
    }
  };
  rl.on('close', closeLines);
  // Ctrl+C: mid-stream → abort the request and keep the session; at the
  // prompt (no stream in flight) → exit cleanly.
  rl.on('SIGINT', () => {
    if (currentAbort !== null) {
      currentAbort.abort();
      return;
    }
    closeLines();
    rl.close();
  });

  function nextLine(): Promise<string> {
    const buffered = queued.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    if (closed) return Promise.reject(new PromptClosedError());
    return new Promise<string>((resolve, reject) => {
      waiters.push({ resolve, reject });
    });
  }

  // ONE permission asker for the whole session, sharing the REPL's line
  // queue (never a second 'line' listener — the menu pauses the editor and
  // takes raw mode only while it runs).
  const permissions: PermissionAsker = ctx.json
    ? flags.yes === true
      ? createAutoAsker()
      : createDenyingAsker()
    : createInteractiveAsker({
        stdin: ctx.io.stdin,
        isTTY: ctx.io.isTTY,
        err: ctx.io.err,
        nextLine,
        pauseInput: () => rl.pause(),
        resumeInput: () => rl.resume(),
        rawWrite: ctx.io.writeErr,
        style: {
          marker: (s) => theme.cyan(s),
          selected: (s) => theme.star(s),
          option: (s) => theme.dim(s),
          hint: (s) => theme.dim(s),
        },
      });

  // Session-scoped permission memory (memory-only, never persisted).
  const allows = new SessionAllows();

  // Session stats for the footer, /cost, and the exit summary.
  const startedAt = Date.now();
  let sessionTokens = 0;
  let sessionCostMicro: bigint | undefined = undefined;
  let sessionRequests = 0;
  const filesChanged = new Set<string>();

  const tools: Tool[] = flags.safe
    ? builtinTools().filter((t) => t.kind === 'read')
    : builtinTools();
  const maxTurns = loadProjectConfig(process.cwd()).agent?.maxTurns ?? DEFAULT_MAX_TURNS;
  const permissionMode = flags.safe === true ? 'safe' : flags.yes === true ? 'auto' : 'ask';

  const renderDiff = (before: string, after: string): readonly string[] =>
    renderUnifiedDiff(before, after, diffStyleFor(theme), { context: 3 });

  // Built per theme: /theme swaps the live theme object, and the spinner must
  // follow it — a spinner constructed once would keep the pre-switch palette.
  const makeSpinner = (): Spinner =>
    new Spinner(
      { write: ctx.io.writeErr },
      { theme, tokenSource: () => (sessionTokens > 0 ? sessionTokens : undefined) },
    );
  let spinner = makeSpinner();
  // The spinner redraws a line in place — only meaningful on a real TTY.
  const spinnerAllowed = process.stderr.isTTY === true && !ctx.json;

  /** The dim status line + the gradient ❯ marker (the prompt). */
  function drawPrompt(): void {
    const tokens = sessionTokens > 0 ? ` · ${formatCount(BigInt(sessionTokens))} tokens` : '';
    ctx.io.writeErr(theme.dim(`${current.id} · ${shortCwd()} · ${permissionMode}${tokens}\n`));
    ctx.io.writeErr(`${theme.gradient('❯')} `);
  }

  const history: ChatMessage[] = [];

  for (;;) {
    drawPrompt();
    let line: string;
    try {
      line = await nextLine();
    } catch (err) {
      if (err instanceof PromptClosedError) break; // Ctrl+D / Ctrl+C at prompt
      throw err;
    }
    const trimmed = line.trim();
    if (trimmed === '') continue; // empty line → reprompt
    if (trimmed === '/exit') break;
    if (trimmed === '/help') {
      for (const cmd of [
        '/help — show this list',
        '/model [id] — show or switch the model (verified before switching)',
        `/theme [name] — show or switch the UI theme (${THEME_NAMES.join(', ')})`,
        '/clear — clear the conversation history',
        '/tools — list the agent tools available this session',
        '/permissions — show what is auto-allowed this session',
        '/cost — session totals (requests, tokens, cost)',
        '/exit — end the session (Ctrl+D also works)',
      ]) {
        r.bullet(cmd);
      }
      continue;
    }
    if (trimmed === '/cost') {
      const parts = [
        `Requests: ${formatCount(BigInt(sessionRequests))}`,
        `Tokens: ${formatCount(BigInt(sessionTokens))}`,
      ];
      if (sessionCostMicro !== undefined && sessionCostMicro !== 0n) {
        parts.push(`Cost: ${formatChatCost(microToWireString(sessionCostMicro))}`);
      }
      r.bullet(parts.join(' · '));
      continue;
    }
    if (trimmed === '/tools') {
      r.bullet(
        `Tools (${tools.length}, mode: ${permissionMode}): ${tools.map((t) => t.name).join(', ')}`,
      );
      continue;
    }
    if (trimmed === '/permissions') {
      const dump = allows.dump();
      if (dump.rules.length === 0 && dump.outsideDirs.length === 0) {
        r.bullet('Nothing auto-allowed yet — every tool call asks first.');
      } else {
        for (const rule of dump.rules) r.bullet(`auto-allowed: ${rule}`);
        for (const dir of dump.outsideDirs) r.bullet(`outside access: ${dir}`);
      }
      r.bullet('(memory-only — gone when the session ends)');
      continue;
    }
    if (trimmed === '/clear') {
      history.length = 0;
      r.bullet('History cleared.');
      continue;
    }
    if (trimmed === '/theme' || trimmed.startsWith('/theme ')) {
      const arg = trimmed.slice('/theme'.length).trim();
      if (arg === '') {
        r.bullet(`Current theme: ${themeName} (available: ${THEME_NAMES.join(', ')})`);
        continue;
      }
      if (!isThemeName(arg)) {
        r.fail(`unknown theme "${arg}" — available: ${THEME_NAMES.join(', ')}`);
        continue;
      }
      themeName = arg;
      theme = themeFor(arg, process.stdout.isTTY === true);
      // The old spinner is never running here (slash commands are read at the
      // prompt; the spinner only runs mid-turn) — safe to swap.
      spinner = makeSpinner();
      saveConfig({ ...loadConfig(), theme: themeName });
      r.ok(`Theme set to ${themeName}`);
      continue;
    }
    if (trimmed === '/model' || trimmed.startsWith('/model ')) {
      const arg = trimmed.slice('/model'.length).trim();
      if (arg === '') {
        r.bullet(`Current model: ${modelLabel(current)}`);
        continue;
      }
      try {
        const next = await verifyModel(client, arg);
        current = next;
        r.ok(`Switched to ${current.id}`);
      } catch (err) {
        if (err instanceof SeloraApiError && err.status === 404) {
          r.fail(err.apiMessage ?? err.message);
          r.bullet('List available models with: selora models');
        } else if (err instanceof SeloraApiError) {
          r.fail(err.message);
          if (err.hint !== undefined) r.bullet(err.hint);
        } else {
          r.fail('Model check failed.');
        }
        // Keep the current model on any failure.
      }
      continue;
    }
    if (trimmed.startsWith('/')) {
      r.bullet(`Unknown command ${trimmed.split(' ')[0]} — /help lists commands.`);
      continue;
    }

    // A chat turn: the agent loop with the full in-memory history.
    history.push({ role: 'user', content: trimmed });
    const controller = new AbortController();
    currentAbort = controller;
    hooks.registerInterrupt?.(() => controller.abort());
    const md = new MarkdownStream(markdownStyleFor(theme));
    let sawReasoning = false;
    let stopSpinnerOnDelta = true;
    if (spinnerAllowed) spinner.start();
    try {
      const result = await runAgentLoop({
        client,
        model: current.id,
        messages: [...history],
        tools,
        maxTurns,
        cwd: process.cwd(),
        permissions,
        autoApprove: flags.yes === true,
        allows,
        renderDiff,
        signal: controller.signal,
        callbacks: {
          onDelta: (text) => {
            if (stopSpinnerOnDelta) {
              spinner.stop();
              stopSpinnerOnDelta = false;
            }
            const rendered = md.push(text);
            if (rendered !== '') r.writeRaw(`${rendered}\n`); // stdout, live
          },
          onReasoning: (text) => {
            sawReasoning = true;
            if (spinner.running) spinner.stop();
            r.writeRawGray(text); // stderr, dim gray
          },
          onToolStart: (name, label) => {
            if (spinner.running) spinner.stop();
            stopSpinnerOnDelta = false;
            ctx.io.writeErr(`${renderToolStart(name, label, theme)}\n`);
          },
          onToolResult: (info) => {
            for (const outLine of renderToolResult(
              {
                name: info.name,
                label: info.label,
                ok: info.ok,
                summary: info.summary,
                content: info.content,
                diff: info.diff,
              },
              theme,
            )) {
              ctx.io.writeErr(`${outLine}\n`);
            }
            if (spinnerAllowed) spinner.start();
          },
          onTurnComplete: (totals) => {
            const footer = chatFooterLine(totals.usage, totals.charge);
            if (footer !== undefined) r.gray(footer);
          },
        },
      });
      const tail = md.flush();
      if (tail !== '') r.writeRaw(`${tail}\n`);
      if (sawReasoning) r.writeRawGray('\n');

      // The loop returned — the history is consistent; adopt it.
      history.length = 0;
      history.push(...result.messages);
      sessionRequests += 1;
      if (result.usageTotal !== undefined) sessionTokens += result.usageTotal.totalTokens;
      if (result.chargeTotalMicro !== undefined) {
        sessionCostMicro = (sessionCostMicro ?? 0n) + result.chargeTotalMicro;
      }
      for (const e of result.toolEvents) {
        if (e.ok && WRITE_TOOL_NAMES.has(e.name)) filesChanged.add(e.label);
      }
      if (result.stop === 'max-turns') {
        r.bullet(`stopped at the turn cap (${maxTurns}) — raise agent.maxTurns in selora.json`);
      } else if (result.stop === 'tool-failures') {
        process.exitCode = 1;
        r.fail('agent stopped: 3 consecutive tool failures');
      }
    } catch (err) {
      spinner.stop();
      // The failed turn is dropped entirely — the user can retype it.
      history.pop();
      if (err instanceof SeloraApiError && err.kind === 'cancelled') {
        r.bullet('Request cancelled — session kept');
      } else if (
        err instanceof SeloraApiError &&
        (err.kind === 'auth' || err.kind === 'auth_revoked')
      ) {
        // Fatal: the key is gone/revoked — exit 1 with the verbatim message.
        r.renderError(err);
        currentAbort = null;
        rl.close();
        return;
      } else if (err instanceof SeloraApiError) {
        r.fail(err.message);
        if (err.hint !== undefined) r.bullet(err.hint);
      } else {
        r.fail('Unexpected CLI error.');
        r.bullet('(run with --debug for details)');
      }
    } finally {
      spinner.stop();
      currentAbort = null;
    }
  }

  spinner.stop();
  rl.close();

  // The exit summary: duration, requests, tokens, cost, files changed.
  const elapsed = formatDurationCompact(Date.now() - startedAt);
  const parts = [
    `Session: ${elapsed === '' ? 'under 1s' : elapsed}`,
    `${formatCount(BigInt(sessionRequests))} request${sessionRequests === 1 ? '' : 's'}`,
  ];
  if (sessionTokens > 0) parts.push(`${formatCount(BigInt(sessionTokens))} tokens`);
  if (sessionCostMicro !== undefined && sessionCostMicro !== 0n) {
    parts.push(`${formatChatCost(microToWireString(sessionCostMicro))}`);
  }
  if (filesChanged.size > 0) {
    const names = [...filesChanged];
    const shown = names.slice(0, 3).join(', ');
    parts.push(
      `${names.length} file change${names.length === 1 ? '' : 's'}${names.length > 3 ? ` (${shown}…)` : names.length === 3 ? ` (${shown})` : ` (${shown})`}`,
    );
  }
  r.gray(`· ${parts.join(' · ')}`);
  r.ok('Session ended');
}
