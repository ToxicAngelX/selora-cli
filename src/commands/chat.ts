/**
 * `selora chat [--model <id>] [--safe] [--yes]` — the interactive agent REPL
 * (v0.7: slash-command menu + @path completion at the prompt).
 *
 * What changed in v0.9 (docs/commands/chat.md):
 *  - Ctrl+R at the prompt opens a history search over this session's sent
 *    prompts plus every persisted session of the project (the store
 *    `selora resume` reads) — newest first, deduped, substring filter;
 *    Enter INSERTS the pick at the prompt (never sends), Esc restores the
 *    stashed line. TTY-menu-capable only; inert otherwise.
 *  - `! <cmd>` runs a one-shot shell command in the project root without
 *    leaving the session: output renders as a dim folded block (last 40
 *    lines + "… N more lines"), the exit code is shown (non-zero
 *    highlighted), and NOTHING is sent to the model. No permission gate —
 *    the user typed it. Mid-turn a `!` line is refused (never queued);
 *    `\!` escapes a literal leading bang.
 *  - plan mode joins the shift+tab cycle (manual → acceptEdits → auto →
 *    plan): reads run, mutating tool calls are denied by the loop and
 *    recorded as proposals — `/plan` shows the list, `/plan clear` empties
 *    it (it survives mode switches).
 *  - the mid-turn input queue is capped at ONE: the first typed-ahead line
 *    queues with a notice, a second is discarded with a notice (echoed
 *    dimly, never sent); Ctrl+C aborting a turn also drops the queued line.
 *  - stability: a renderer exception can never kill the REPL (the turn
 *    degrades to raw text with a one-line notice); split multibyte keypress
 *    input reassembles via a StringDecoder instead of garbling.
 *
 * What changed in v0.8 (docs/commands/chat.md):
 *  - the workspace trust screen runs BEFORE the banner: an untrusted cwd on
 *    an interactive, menu-capable terminal gets the Claude-Code-style
 *    arrow-key check ("Yes, I trust this folder" / "No, exit"). Trusting
 *    persists to trusted.json (0600) in the config dir — asked once per
 *    folder. Non-TTY, --json, --yes, NO_COLOR and TERM=dumb never see it
 *    (`selora trust add <dir>` pre-trusts for scripts and first runs);
 *  - fixed: in auto mode (and on a manual 'y') an approved OUTSIDE-root tool
 *    call now grants the touched directory for the session before the real
 *    run — v0.7 granted only on 'allow-session', so auto mode failed every
 *    outside path with "outside the project root and access was not granted".
 *
 * What changed in v0.7 (docs/commands/chat.md):
 *  - typing `/` opens an inline menu under the prompt: the slash commands with
 *    their descriptions, ↑/↓ to move, Tab/Enter to run, Esc to dismiss — the
 *    filter is prefix+substring fuzzy, and `/help`, the menu, and dispatch all
 *    share ONE SlashCommand registry (they cannot drift apart);
 *  - `@` gets the same engine for file paths: matching files/dirs from the
 *    project root (dirs complete with a trailing `/` and deepen, image
 *    extensions highlighted, capped at 12 rows + a "+N more" hint);
 *  - `/model` with no args offers the model list as an arrow-key picker
 *    (switching is verified exactly like `/model <id>`);
 *  - mechanically: readline runs over a PassThrough "wire" and a PromptRouter
 *    owns stdin while the prompt is active — TTY-only; non-TTY, --json,
 *    NO_COLOR and TERM=dumb keep the v0.6 wiring and behavior verbatim.
 *
 * What changed in v0.6 (docs/commands/chat.md):
 *  - the conversation is NO LONGER in-memory only: after every COMPLETED turn
 *    it is saved (atomically) to `.selora/sessions/chat.json` — a crash or a
 *    kill loses nothing that completed. Aborted/failed turns are still dropped
 *    entirely (a half-finished turn would corrupt the wire history);
 *  - on launch, a saved non-empty chat session triggers a one-line
 *    `Resume the previous session? [y/N]` offer (never silent auto-resume —
 *    the user may want a fresh start). `selora resume [name]` opens a saved
 *    session directly (any name, or the most recent) with no question;
 *  - `@<path>` tokens in a message attach local images (png/jpg/jpeg/webp/gif,
 *    ≤4 MB, max 4 per message) as image_url parts; the transcript shows
 *    `[image: name, 12.4 KB]` — base64 never prints.
 *
 * Kept v0.5 behavior: the pinned ambient banner (DECSTBM scroll region,
 * ambient twinkle) with the honest scrollback tradeoff; permission MODES with
 * the status line (shift+tab cycles manual → acceptEdits → auto; --safe pins
 * a read-only display mode; --yes starts in auto); reasoning never printed
 * (the spinner's `✦ Thinking…` carries it); the prompt reprompts BARE on an
 * empty Enter.
 *
 * Kept v0.3/v0.4 behavior: the agent loop with the full toolset per message
 * (permission-gated per call; --safe restricts to read-only tools), the
 * markdown-streaming renderer, the tool-call display with colored diffs,
 * the galaxy spinner while a reply streams, slash commands (/help /model
 * /theme /clear /tools /permissions /cost /exit), the session summary on
 * exit. Footers ONLY when the usage chunk actually arrived, Ctrl+C aborts a
 * reply and keeps the session, Ctrl+D/Ctrl+C at the prompt exits.
 */

import * as readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings, saveConfig } from '../config/index.js';
import { loadProjectConfig } from '../config/project.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { getModel, listModels } from '../api/endpoints/models.js';
import type { ChatMessage } from '../api/endpoints/chat.js';
import { getStoredKey } from '../auth/storage.js';
import { PromptClosedError } from '../auth/prompts.js';
import { Renderer } from '../terminal/render.js';
import { chatFooterLine, formatChatCost } from './chat-footer.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';
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
import { createModeAsker, modeStatusLine, nextMode, type PermissionMode } from '../agent/modes.js';
import type { Tool } from '../agent/tool.js';
import { themeFor, isThemeName, THEME_NAMES, type ThemeName } from '../ui/theme.js';
import {
  loadSession,
  saveSession,
  SESSION_VERSION,
  type StoredSession,
} from '../agent/session/store.js';
import { collectPromptHistory } from '../agent/session/history.js';
import { imageMarker, parseImageInput, userMessageContent } from '../images.js';
import {
  parseBangLine,
  renderShellBlock,
  startShellCommand,
  type ShellRunResult,
} from '../shellescape.js';
import {
  AMBIENT_DRIFT,
  AMBIENT_INTERVAL_MS,
  STARTUP_FRAME_COUNT,
  bannerHeight,
  makeLogoScene,
  renderAmbientFrame,
  renderCompactFrame,
  renderSceneFrame,
  renderStartupFrames,
  renderStartupScreen,
  startupTail,
  sweepPhase,
  type LogoScene,
} from '../ui/logo.js';
import { playFrames, trimEnd } from '../ui/animate.js';
import { MarkdownStream } from '../ui/markdown.js';
import { renderUnifiedDiff } from '../ui/diff.js';
import { Spinner } from '../ui/spinner.js';
import { diffStyleFor, markdownStyleFor, renderToolResult, renderToolStart } from '../ui/chatui.js';
import {
  PromptRouter,
  pickFromList,
  promptMenuCapable,
  rawCapable,
  slashHelpLine,
  type SlashCommand,
} from '../ui/promptmenu.js';
import { isTrustedDir } from '../config/trust.js';
import { runTrustScreen, trustScreenCapable } from '../ui/trustscreen.js';

export interface ChatFlags {
  model?: string | undefined;
  /** Restrict the agent to read-only tools. */
  safe?: boolean;
  /** Auto-approve tool execution (non-interactive; still filtered by --safe). */
  yes?: boolean;
  /**
   * Project root for the session store and the agent sandbox (defaults to
   * process.cwd()). The test seam: suites pass a temp dir so chat auto-save
   * never writes into the real repo.
   */
  cwd?: string | undefined;
  /**
   * Open this saved session directly (set by `selora resume [name]`): no
   * resume question, the history is seeded, and auto-save continues under the
   * same name.
   */
  resumeName?: string | undefined;
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

/**
 * Rows the transcript region needs beneath the pinned banner for pinning to
 * be worth it (tips + the prompt block + a few reply rows).
 */
const MIN_REGION_ROWS = 8;

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

  // ------------------------------------------------------------------
  // Session state (v0.6). The conversation auto-saves to
  // .selora/sessions/<name>.json after every completed turn — `chat` for a
  // bare `selora chat`, the given name for `selora resume <name>`. An
  // explicit resume skips the launch question; a bare chat with a saved
  // non-empty chat.json asks once (never silent auto-resume).
  // ------------------------------------------------------------------
  const cwd = flags.cwd ?? process.cwd();
  const sessionName = flags.resumeName ?? 'chat';
  let resumed: StoredSession | null = null;
  if (flags.resumeName !== undefined) {
    resumed = loadSession(cwd, flags.resumeName);
    if (resumed === null) {
      process.exitCode = 1;
      const message = `no session named "${flags.resumeName}" in this project`;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }
  }
  // The pending resume offer (bare chat only, never --json automation).
  const savedChat = flags.resumeName === undefined ? loadSession(cwd, 'chat') : null;
  const offerPending = !ctx.json && savedChat !== null && savedChat.messages.length > 0;

  const flagModel = flags.model !== undefined ? flags.model.trim() : '';

  // The galaxy theme. Color level keys off the REAL stdout (a captured test
  // io is "TTY" but a piped stdout is not — NO_COLOR/non-TTY stay plain).
  // isThemeName guards the config value: an unknown stored name falls back to
  // galaxy instead of needing an edit here for every new theme.
  const configuredTheme = loadConfig().theme;
  let themeName: ThemeName =
    configuredTheme !== undefined && isThemeName(configuredTheme) ? configuredTheme : 'galaxy';
  let theme = themeFor(themeName, process.stdout.isTTY === true);

  // ------------------------------------------------------------------
  // Workspace trust (v0.8) — the Claude-Code-style one-time folder check.
  // An untrusted cwd on an interactive, menu-capable terminal gets the
  // arrow-key trust screen BEFORE the banner and the REPL; trusting persists
  // (config-dir trusted.json, 0600), so the question is asked once per
  // folder. Non-TTY, --json, --yes, NO_COLOR and TERM=dumb never see it —
  // pipelines must not block, and --yes is already the stronger commitment
  // (it implies trust for the session and persists nothing).
  // ------------------------------------------------------------------
  if (
    trustScreenCapable({
      isTTY: ctx.io.isTTY,
      json: ctx.json,
      yes: flags.yes === true,
      stdinRawCapable: rawCapable(ctx.io.stdin),
      env: process.env,
    }) &&
    !isTrustedDir(cwd)
  ) {
    const trusted = await runTrustScreen({
      cwd,
      theme,
      io: { stdin: ctx.io.stdin, write: (s) => ctx.io.writeErr(s) },
    });
    if (!trusted) return; // "· not trusted — exiting" printed; exit 0
  }

  // ------------------------------------------------------------------
  // The pinned ambient banner (v0.5). On a color-capable TTY with enough
  // rows, the logo/starfield canvas is drawn at the TOP of a cleared screen
  // and kept alive forever: a DECSTBM scroll region confines the transcript
  // below it, and a slow timer re-colors the same scene in place (DECSC/
  // DECRC — ESC 7 / ESC 8, the universally supported save/restore — around
  // the burst, so readline, the spinner and the permission menu never
  // notice; CSI s/u is NOT universal and must not be used here). Everything
  // degrades to the classic inline screen under NO_COLOR/mono/
  // SELORA_NO_ANIMATE/short terminals.
  // ------------------------------------------------------------------
  let ambientTimer: NodeJS.Timeout | undefined;
  let regionActive = false;
  let ambientScene: LogoScene | null = null;
  let ambientWidth = 80;

  function ambientBurst(tick: number): void {
    const rows =
      ambientScene !== null
        ? renderAmbientFrame(ambientScene, theme, tick)
        : renderCompactFrame(theme, ambientWidth, tick * AMBIENT_DRIFT);
    // No trailing newline: the last banner row must never feed the scroll.
    ctx.io.writeOut(
      `\x1b7\x1b[1;1H${rows.map((row) => `\x1b[2K${trimEnd(row)}`).join('\r\n')}\x1b8`,
    );
  }

  function onResize(): void {
    if (!regionActive) return;
    // A resize reflows the transcript in terminal-specific ways and DECSTBM
    // re-homes the cursor on xterm/Windows Terminal — re-pinning would
    // corrupt the input line's position. Honest degradation instead: unpin
    // and print a fresh STATIC banner inline at the new width (the session
    // continues normally; /exit + restart restores the pinned banner).
    unpin();
    const w = (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80);
    for (const line of renderStartupScreen(theme, { width: w })) r.line(line);
  }

  /** Last-resort region reset if the process dies without a clean return. */
  function exitReset(): void {
    if (regionActive) {
      try {
        process.stdout.write('\x1b[r');
      } catch {
        // best effort — the process is going down
      }
      regionActive = false;
    }
  }

  function unpin(): void {
    if (ambientTimer !== undefined) {
      clearInterval(ambientTimer);
      ambientTimer = undefined;
    }
    process.stdout.removeListener('resize', onResize);
    process.removeListener('exit', exitReset);
    if (regionActive) {
      ctx.io.writeOut('\x1b[r');
      regionActive = false;
    }
  }

  if (!ctx.json) {
    const width = (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80);
    const rows = process.stdout.rows ?? 24;
    const height = bannerHeight(width);
    // Animation gates on the REAL stdout (a captured test io never animates)
    // and an enabled theme (level 0 covers NO_COLOR, TERM=dumb, mono, pipes).
    const canAnimate =
      process.stdout.isTTY === true &&
      theme.level > 0 &&
      process.env['SELORA_NO_ANIMATE'] === undefined;
    // Pinning additionally needs working room beneath the banner (tips, the
    // prompt block, a few reply rows) — otherwise the classic screen.
    const pin = canAnimate && rows >= height + MIN_REGION_ROWS;

    if (pin) {
      // Take over the screen: clear + home, then the intro sweep at the top.
      ctx.io.writeOut('\x1b[2J\x1b[H');
      ambientWidth = width;
      ambientScene = height > 1 ? makeLogoScene(width, Math.random) : null;
      const sweep = Array.from({ length: STARTUP_FRAME_COUNT }, (_, k) =>
        ambientScene !== null
          ? renderSceneFrame(
              ambientScene,
              theme,
              sweepPhase(k, STARTUP_FRAME_COUNT),
              k - (STARTUP_FRAME_COUNT - 1),
            )
          : renderCompactFrame(theme, width, sweepPhase(k, STARTUP_FRAME_COUNT)),
      );
      await playFrames(sweep, { write: ctx.io.writeOut, sleep });
      // The transcript region: everything below the banner scrolls, the
      // banner stays. The tips are the region's first content — honestly
      // transient, they scroll away with the conversation.
      ctx.io.writeOut(`\x1b[${height + 1};${rows}r\x1b[${height + 1};1H`);
      regionActive = true;
      process.once('exit', exitReset);
      process.stdout.on('resize', onResize);
      for (const line of startupTail(theme, { width })) r.line(line);
      let tick = 0;
      ambientTimer = setInterval(() => {
        tick += 1;
        ambientBurst(tick);
      }, AMBIENT_INTERVAL_MS);
      ambientTimer.unref?.();
    } else {
      const frames = renderStartupFrames(theme, { width });
      const animate = canAnimate && rows >= frames[0]!.length + 2;
      if (animate) {
        await playFrames(frames, { write: ctx.io.writeOut, sleep });
      } else {
        // The final frame — the same pure output the animation lands on.
        for (const line of frames[frames.length - 1]!) r.line(line);
      }
    }
  }

  // Persistent readline interface (the buffering pattern from
  // auth/prompts.ts): lines queue while a turn is streaming, prompts go to
  // stderr, and readline's own echo is forwarded to raw stdout — except in
  // --json mode, where stdout carries ONLY reply text (echoed input would
  // pollute the machine channel).
  const echo = new Writable({
    write(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
      if (!ctx.json) ctx.io.writeOut(chunk.toString());
      cb();
    },
  });

  // v0.7: on a capable terminal the prompt gains the slash-command menu and
  // the @path completion. readline then runs over a PassThrough "wire" and a
  // PromptRouter owns the real stdin: menu keys (↑/↓/Tab/Enter/Esc while the
  // menu is open) are consumed, every other byte is forwarded — readline's
  // own keypress decoder, editing, echo, and history are untouched. The
  // uncapable paths (non-TTY, --json, NO_COLOR, TERM=dumb, no raw mode) keep
  // the v0.6 wiring verbatim: stdin straight into readline.
  const menuOn = promptMenuCapable({
    json: ctx.json,
    stdinIsTTY: ctx.io.isTTY,
    stdoutIsTTY: process.stdout.isTTY === true,
    stdinRawCapable: rawCapable(ctx.io.stdin),
    env: process.env,
  });
  const wire = menuOn ? new PassThrough() : null;
  if (wire !== null) {
    // readline toggles raw mode on ITS input (constructor/resume/close) —
    // delegate to the real stdin so the terminal stays per-key, exactly like
    // the direct wiring. (Without this the prompt would run in cooked mode.)
    const stdinRaw = ctx.io.stdin as { setRawMode?(mode: boolean): void };
    (wire as PassThrough & { setRawMode?: (mode: boolean) => void }).setRawMode = (
      mode: boolean,
    ) => {
      try {
        stdinRaw.setRawMode?.(mode);
      } catch {
        // best effort
      }
    };
  }
  /** True only while the REPL awaits a line at the prompt (shift+tab + menu gate). */
  let promptActive = false;
  /** Set once the permission mode exists (shift+tab handler for the router). */
  const cycleModeRef: { fn: (() => void) | undefined } = { fn: undefined };
  /** The slash-command registry — filled in below; the router reads it live. */
  let slashCommands: readonly SlashCommand[] = [];
  const rl = readline.createInterface({
    input: wire ?? ctx.io.stdin,
    output: echo,
    terminal: ctx.io.isTTY,
  });
  // The trust screen's picker pauses stdin on cleanup (a flowing raw tty keeps
  // node alive otherwise). Readline on a paused stream never emits 'line' —
  // resume it so the first keystroke after trusting lands.
  (wire ?? ctx.io.stdin).resume();
  // The prompt readline repaints on line edits (a backspace redraws
  // prompt+line — with readline's default '> ' the marker was clobbered).
  // Same string drawPrompt writes, so a refresh is invisible.
  rl.setPrompt(`${theme.gradient('❯')} `);

  // The router attaches immediately: typed-ahead input during startup (the
  // resume offer, model verification) must reach readline exactly like v0.6's
  // direct wiring. The menu itself only opens while promptActive.
  // v0.9: `sentPrompts` is this session's contribution to the Ctrl+R pool
  // (filled as turns start; the router reads the pool live at search-open).
  const sentPrompts: string[] = [];
  // v0.9: plan-mode proposals (mutating tool labels the loop denied), shown
  // by /plan; survives mode switches by living outside the loop.
  const planProposals: string[] = [];
  let router: PromptRouter | undefined;
  if (wire !== null) {
    router = new PromptRouter({
      stdin: ctx.io.stdin,
      rl,
      wire,
      isPromptActive: () => promptActive,
      onShiftTab: () => cycleModeRef.fn?.(),
      slashCommands: () => slashCommands,
      historyItems: () => collectPromptHistory(cwd, sentPrompts),
      cwd,
      write: (s) => ctx.io.writeErr(s),
      theme: () => theme,
      cols: () => (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80),
    });
    router.attach();
  }

  const queued: string[] = [];
  const waiters: Array<{ resolve: (line: string) => void; reject: (err: Error) => void }> = [];
  let closed = false;
  let currentAbort: AbortController | null = null;
  /** Set while a `!` shell command runs (Ctrl+C kills it instead of exiting). */
  let currentShellKill: (() => void) | null = null;

  /** A turn (model) or a `!` command is running — the prompt is not waiting. */
  const turnInFlight = (): boolean => currentAbort !== null || currentShellKill !== null;
  /** A dim UI notice on the UI channel (stderr) — never the reply channel. */
  const note = (text: string): void => {
    ctx.io.writeErr(`${theme.dim(text)}\n`);
  };

  // v0.9: at most ONE line queues behind a running turn. The first typed-ahead
  // line queues with a notice; a second is DISCARDED with a notice (echoed
  // dimly so it is visually not lost — never queued, never sent). `!` shell
  // lines mid-turn are refused outright (instant commands must not run at a
  // surprising later moment). Empty lines mid-turn drop silently rather than
  // eat the single slot. Lines arriving with NO turn in flight (startup
  // typed-ahead, piped bursts) keep the v0.8 behavior: queued in order.
  rl.on('line', (line: string) => {
    const w = waiters.shift();
    if (w !== undefined) {
      w.resolve(line);
      return;
    }
    if (turnInFlight()) {
      const t = line.trim();
      if (t === '') return;
      if (t.startsWith('!') && !t.startsWith('\\!')) {
        note('· a turn is streaming — ! commands wait for the prompt (not queued)');
        return;
      }
      if (queued.length === 0) {
        queued.push(line);
        note('· queued — runs when this turn finishes');
      } else {
        note('· one prompt already queued — it runs next');
        note(`· discarded: ${t.length > 80 ? `${t.slice(0, 79)}…` : t}`);
      }
      return;
    }
    queued.push(line);
  });
  const closeLines = (): void => {
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!.reject(new PromptClosedError());
    }
  };
  rl.on('close', closeLines);
  // Ctrl+C: mid-`!`-command → kill the command; mid-stream → abort the
  // request and keep the session; at the prompt (nothing in flight) → exit.
  rl.on('SIGINT', () => {
    if (currentShellKill !== null) {
      currentShellKill();
      return;
    }
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

  // The resume offer (v0.6): a bare `selora chat` with a saved non-empty
  // chat.json asks ONCE — one keystroke, never a silent auto-resume. The
  // question rides the REPL's own line queue, so typed-ahead input survives.
  // Any answer other than y/yes (including Ctrl+D) starts fresh; the saved
  // session stays on disk either way.
  if (offerPending && savedChat !== null) {
    ctx.io.writeErr(
      `Resume the previous session? (${savedChat.messages.length} messages, updated ${savedChat.updatedAt}) [y/N] `,
    );
    let answer = '';
    try {
      answer = (await nextLine()).trim().toLowerCase();
    } catch {
      answer = ''; // prompt closed (Ctrl+D) — start fresh
    }
    if (answer === 'y' || answer === 'yes') resumed = savedChat;
  }

  // Model resolution: --model > the resumed session's model > the configured
  // default > the built-in fallback. (Resolved AFTER the offer so an accepted
  // session's model applies — and a declined one never does.)
  const wanted =
    flagModel !== ''
      ? flagModel
      : resumed !== null && resumed.model !== ''
        ? resumed.model
        : (loadConfig().defaultModel ?? DEFAULT_MODEL_FALLBACK);

  let current: SessionModel;
  try {
    current = await verifyModel(client, wanted);
  } catch (err) {
    // Unknown model: the backend's own "Model not available" message, verbatim,
    // plus the listing hint. The REPL is NOT started on a bad model.
    process.exitCode = 1;
    unpin();
    router?.detach();
    rl.close();
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

  r.ok(`Connected to ${modelLabel(current)}`);
  if (resumed !== null) {
    r.bullet(`Resumed session "${sessionName}" — ${resumed.messages.length} messages restored`);
  }

  // The permission mode (v0.5; v0.9 added plan): shift+tab cycles manual →
  // acceptEdits → auto → plan at the prompt. --safe is a toolset restriction,
  // not a mode — the status line shows a read-only display mode and cycling
  // is off. --yes starts in auto (deletions still ask — neverAutoAllow is
  // honored in every mode).
  const safeMode = flags.safe === true;
  let mode: PermissionMode = flags.yes === true ? 'auto' : 'manual';

  // The permission menu hands the line editor back in COOKED mode (its
  // cleanup setRawMode(false)s after pausing readline) — re-assert raw mode
  // so the prompt keeps per-key editing. (v0.6 left the REPL cooked after
  // the first permission menu; the menu engine needs per-key delivery.)
  const resumeInputRaw = (): void => {
    rl.resume();
    try {
      (ctx.io.stdin as { setRawMode?(m: boolean): void }).setRawMode?.(true);
    } catch {
      // best effort — line input still works without raw mode
    }
  };

  // ONE permission asker for the whole session, sharing the REPL's line
  // queue (never a second 'line' listener — the menu pauses the editor and
  // takes raw mode only while it runs). The interactive asker is WRAPPED in
  // the mode asker: per request, the current mode may auto-allow it.
  const permissions: PermissionAsker = ctx.json
    ? flags.yes === true
      ? createAutoAsker()
      : createDenyingAsker()
    : createModeAsker(
        createInteractiveAsker({
          stdin: ctx.io.stdin,
          isTTY: ctx.io.isTTY,
          err: ctx.io.err,
          nextLine,
          pauseInput: () => rl.pause(),
          resumeInput: menuOn ? resumeInputRaw : () => rl.resume(),
          rawWrite: ctx.io.writeErr,
          style: {
            marker: (s) => theme.cyan(s),
            selected: (s) => theme.star(s),
            option: (s) => theme.dim(s),
            hint: (s) => theme.dim(s),
          },
        }),
        () => mode,
      );

  // shift+tab (CSI Z, backtab) at the prompt cycles the permission mode.
  // Gated by promptActive: mid-turn and mid-menu the bytes belong elsewhere.
  // With the menu engine the prompt router owns stdin and calls cycleMode
  // (only while its menu is closed); the legacy path keeps the v0.6 stdin
  // listener. Readline itself ignores the sequence (no completer cycles on it).
  const cycleMode = (): void => {
    if (!promptActive) return;
    mode = nextMode(mode);
    // Redraw the mode line in place — only while the input row has not
    // wrapped (a wrapped input sits more than one row below the mode line;
    // the next full prompt draw shows the new mode instead). DECSC/DECRC
    // save/restore, the universally supported pair.
    const w = (process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80);
    if (rl.line.length + 2 < w) {
      ctx.io.writeErr(`\x1b7\x1b[1A\r\x1b[2K${theme.dim(modeStatusLine(mode))}\x1b8`);
    }
  };
  cycleModeRef.fn = !ctx.json && !safeMode ? cycleMode : undefined;
  const onShiftTab = (chunk: Buffer | string): void => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (s !== '\x1b[Z') return;
    cycleMode();
  };
  if (!menuOn && !ctx.json && !safeMode) ctx.io.stdin.on('data', onShiftTab);
  const detachShiftTab = (): void => {
    ctx.io.stdin.removeListener('data', onShiftTab);
  };

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
  const maxTurns = loadProjectConfig(cwd).agent?.maxTurns ?? DEFAULT_MAX_TURNS;

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

  /**
   * The prompt block: a dim context line (model · cwd · tokens), the dim
   * mode status line, and the gradient ❯ marker the user types after.
   */
  function drawPrompt(): void {
    const tokens = sessionTokens > 0 ? ` · ${formatCount(BigInt(sessionTokens))} tokens` : '';
    ctx.io.writeErr(theme.dim(`${current.id} · ${shortCwd()}${tokens}\n`));
    ctx.io.writeErr(`${theme.dim(modeStatusLine(safeMode ? 'safe' : mode))}\n`);
    ctx.io.writeErr(`${theme.gradient('❯')} `);
  }

  /**
   * Empty Enter reprompts with the bare marker only — reprinting the status
   * lines on every empty line is what made them look duplicated.
   */
  function drawBarePrompt(): void {
    ctx.io.writeErr(`${theme.gradient('❯')} `);
  }

  // The conversation — seeded from the resumed session when there is one.
  const history: ChatMessage[] = resumed !== null ? [...resumed.messages] : [];

  // Crash-safe auto-save (v0.6): after every COMPLETED turn the history is
  // written atomically to .selora/sessions/<name>.json. A save failure never
  // breaks the REPL — it is reported once and the conversation continues in
  // memory.
  const sessionCreatedAt = resumed?.createdAt ?? new Date().toISOString();
  let savedOnce = resumed !== null;
  let saveWarned = false;
  function persistSession(): void {
    const toSave: StoredSession = {
      version: SESSION_VERSION,
      name: sessionName,
      model: current.id,
      createdAt: sessionCreatedAt,
      updatedAt: sessionCreatedAt, // saveSession refreshes it
      messages: [...history],
    };
    try {
      saveSession(cwd, toSave);
      savedOnce = true;
    } catch (err) {
      if (!saveWarned) {
        saveWarned = true;
        r.bullet(
          `could not save the chat session (${err instanceof Error ? err.message : String(err)}) — the conversation continues in memory`,
        );
      }
    }
  }

  // ------------------------------------------------------------------
  // The slash-command registry (v0.7) — ONE source for /help, the prompt
  // menu, and dispatch; the three cannot drift apart. run() returns 'exit'
  // to end the session; anything else continues the REPL. Unknown input
  // keeps the v0.6 message byte-for-byte.
  // ------------------------------------------------------------------
  const switchModel = async (arg: string): Promise<void> => {
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
  };

  // /model with no args: the arrow-key picker on a menu-capable TTY (the
  // switch is verified exactly like `/model <id>`); the plain current-model
  // line everywhere else — and as the fallback if the list cannot load.
  const showOrPickModel = async (): Promise<void> => {
    if (menuOn) {
      try {
        const models = await listModels(client);
        if (models.length > 0) {
          const at = models.findIndex((m) => m.id === current.id);
          const picked = await pickFromList(
            'Select a model (↑/↓ · Enter to switch · Esc keeps current)',
            models.map((m) => ({
              label: m.id,
              hint: m.display_name === '' ? undefined : m.display_name,
            })),
            at === -1 ? 0 : at,
            {
              stdin: ctx.io.stdin,
              write: ctx.io.writeErr,
              pauseInput: () => rl.pause(),
              resumeInput: resumeInputRaw,
              theme,
            },
          );
          if (picked !== null) {
            await switchModel(models[picked]!.id);
            return;
          }
        }
      } catch {
        // the picker is an enhancement — fall through to the plain line
      }
    }
    r.bullet(`Current model: ${modelLabel(current)}`);
  };

  slashCommands = [
    {
      name: 'help',
      description: 'show this list',
      run: () => {
        for (const cmd of slashCommands) r.bullet(slashHelpLine(cmd));
        r.bullet('shift+tab — cycle the permission mode (manual → accept edits → auto → plan)');
        r.bullet('Ctrl+R — search past prompts (Enter inserts, does not send)');
        r.bullet('! <cmd> — run a shell command here (never sent to the model)');
        r.bullet('? — keyboard shortcuts');
      },
    },
    {
      name: 'model',
      argsHint: '[id]',
      description: 'show or switch the model (verified before switching)',
      run: async (args) => {
        if (args === '') await showOrPickModel();
        else await switchModel(args);
      },
    },
    {
      name: 'theme',
      argsHint: '[name]',
      description: `show or switch the UI theme (${THEME_NAMES.join(', ')})`,
      run: (args) => {
        if (args === '') {
          r.bullet(`Current theme: ${themeName} (available: ${THEME_NAMES.join(', ')})`);
          return;
        }
        if (!isThemeName(args)) {
          r.fail(`unknown theme "${args}" — available: ${THEME_NAMES.join(', ')}`);
          return;
        }
        themeName = args;
        theme = themeFor(args, process.stdout.isTTY === true);
        // The old spinner is never running here (slash commands are read at the
        // prompt; the spinner only runs mid-turn) — safe to swap.
        spinner = makeSpinner();
        // readline's repaint prompt follows the new theme too.
        rl.setPrompt(`${theme.gradient('❯')} `);
        saveConfig({ ...loadConfig(), theme: themeName });
        r.ok(`Theme set to ${themeName}`);
      },
    },
    {
      name: 'clear',
      description: 'clear the conversation history',
      run: () => {
        history.length = 0;
        // Clear the saved session too — "clear" must not resurrect on resume.
        persistSession();
        r.bullet('History cleared.');
      },
    },
    {
      name: 'tools',
      description: 'list the agent tools available this session',
      run: () => {
        r.bullet(
          `Tools (${tools.length}, mode: ${safeMode ? 'safe' : mode}): ${tools.map((t) => t.name).join(', ')}`,
        );
      },
    },
    {
      name: 'permissions',
      description: 'show what is auto-allowed this session',
      run: () => {
        const dump = allows.dump();
        if (dump.rules.length === 0 && dump.outsideDirs.length === 0) {
          r.bullet('Nothing auto-allowed yet — every tool call asks first.');
        } else {
          for (const rule of dump.rules) r.bullet(`auto-allowed: ${rule}`);
          for (const dir of dump.outsideDirs) r.bullet(`outside access: ${dir}`);
        }
        r.bullet('(memory-only — gone when the session ends)');
      },
    },
    {
      name: 'plan',
      argsHint: '[clear]',
      description: 'show the plan-mode proposal list (or clear it)',
      run: (args) => {
        if (args === 'clear') {
          planProposals.length = 0;
          r.bullet('Plan cleared.');
          return;
        }
        if (args !== '') {
          r.bullet('usage: /plan [clear]');
          return;
        }
        if (planProposals.length === 0) {
          r.bullet('No proposals yet — in plan mode every mutating tool call is recorded here.');
          return;
        }
        r.bullet(
          `Plan (${planProposals.length} proposal${planProposals.length === 1 ? '' : 's'}, newest last) — switch modes (shift+tab) to execute:`,
        );
        planProposals.forEach((label, i) => {
          r.bullet(`  ${i + 1}. ${label}`);
        });
      },
    },
    {
      name: 'cost',
      description: 'session totals (requests, tokens, cost)',
      run: () => {
        const parts = [
          `Requests: ${formatCount(BigInt(sessionRequests))}`,
          `Tokens: ${formatCount(BigInt(sessionTokens))}`,
        ];
        if (sessionCostMicro !== undefined && sessionCostMicro !== 0n) {
          parts.push(`Cost: ${formatChatCost(microToWireString(sessionCostMicro))}`);
        }
        r.bullet(parts.join(' · '));
      },
    },
    {
      name: 'exit',
      description: 'end the session (Ctrl+D also works)',
      run: () => 'exit',
    },
  ];

  /**
   * Dispatch a `/...` line through the registry. Commands that take no args
   * reject them ('/clear now' is unknown, as v0.6); /model and /theme take
   * the remainder as args. Unknown commands keep the v0.6 hint verbatim.
   */
  const dispatchSlash = async (trimmed: string): Promise<'exit' | 'handled' | 'unknown'> => {
    const head = trimmed.split(' ')[0]!;
    const cmd = slashCommands.find((c) => `/${c.name}` === head);
    const args = trimmed.slice(head.length).trim();
    if (cmd === undefined || (args !== '' && cmd.argsHint === undefined)) {
      r.bullet(`Unknown command ${head} — /help lists commands.`);
      return 'unknown';
    }
    // A command fault must never kill the REPL (v0.9 stability).
    let outcome: void | 'exit';
    try {
      outcome = await cmd.run(args);
    } catch (err) {
      r.fail(`/${cmd.name} failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'handled';
    }
    return outcome === 'exit' ? 'exit' : 'handled';
  };

  // fullPrompt: the status lines print once per real turn; an empty line
  // reprompts bare. promptActive gates the shift+tab mode cycling.
  let fullPrompt = true;
  for (;;) {
    promptActive = true;
    if (fullPrompt) drawPrompt();
    else drawBarePrompt();
    let line: string;
    try {
      line = await nextLine();
    } catch (err) {
      if (err instanceof PromptClosedError) break; // Ctrl+D / Ctrl+C at prompt
      throw err;
    } finally {
      promptActive = false;
    }
    const trimmed = line.trim();
    fullPrompt = trimmed !== '';
    if (trimmed === '') continue; // empty line → bare reprompt
    if (trimmed === '?') {
      for (const cmd of [
        'shift+tab — cycle the permission mode (manual → accept edits → auto → plan)',
        '? — this list',
        'Ctrl+R — search past prompts (Enter inserts, does not send)',
        '! <cmd> — run a shell command here (never sent to the model)',
        'Ctrl+C — stop the streaming reply (at the prompt: exit)',
        'Ctrl+D — exit the session',
        '/help — the slash commands',
      ]) {
        r.bullet(cmd);
      }
      continue;
    }
    if (trimmed.startsWith('/')) {
      const outcome = await dispatchSlash(trimmed);
      if (outcome === 'exit') break;
      continue;
    }

    // `!` shell escape (v0.9): run the command here in the project root and
    // show the folded output + exit code — the command and its output are
    // NEVER sent to the model and never enter the prompt history. No
    // permission gate: the user typed it (same trust as their own terminal).
    // `\!` escapes a literal leading bang (the backslash is consumed).
    const bang = parseBangLine(trimmed);
    if (bang.kind === 'shell') {
      if (bang.command === '') {
        r.bullet('! runs a shell command here — e.g. ! npm test (never sent to the model)');
        continue;
      }
      const handle = startShellCommand(bang.command, cwd);
      currentShellKill = handle.kill;
      let shellResult: ShellRunResult;
      try {
        shellResult = await handle.done;
      } finally {
        currentShellKill = null;
      }
      for (const outLine of renderShellBlock(shellResult, theme)) {
        ctx.io.writeErr(`${outLine}\n`);
      }
      continue;
    }
    const messageText = bang.kind === 'escaped' ? bang.text : trimmed;

    // Images (v0.6): `@<path>` tokens attach local files as image_url parts.
    // A parse failure (missing file, >4 MB, more than 4) sends NOTHING — the
    // user fixes and retypes; the turn never starts.
    const parsed = parseImageInput(messageText, cwd);
    if (!parsed.ok) {
      r.fail(parsed.error);
      continue;
    }
    if (parsed.text === '' && parsed.images.length === 0) continue; // only whitespace/escapes

    // A chat turn: the agent loop with the full in-memory history.
    for (const img of parsed.images) {
      // The transcript marker — base64 NEVER prints.
      ctx.io.writeOut(`${theme.dim(imageMarker(img))}\n`);
    }
    history.push({ role: 'user', content: userMessageContent(parsed.text, parsed.images) });
    // The Ctrl+R pool (v0.9): the RAW line as typed, so a re-inserted prompt
    // round-trips (@image tokens and the `\!` escape intact).
    sentPrompts.push(trimmed);
    const controller = new AbortController();
    currentAbort = controller;
    hooks.registerInterrupt?.(() => controller.abort());
    const md = new MarkdownStream(markdownStyleFor(theme));
    let stopSpinnerOnDelta = true;
    // v0.9 stability: a renderer fault degrades the turn to raw text with a
    // one-line notice — it can NEVER kill the REPL.
    let mdBroken = false;
    let renderWarned = false;
    const noteHiccup = (): void => {
      if (renderWarned) return;
      renderWarned = true;
      try {
        r.bullet('render hiccup — continuing with unstyled output');
      } catch {
        // the channel itself is down — nothing more to say
      }
    };
    const safeFlush = (): string => {
      if (mdBroken) return '';
      try {
        return md.flush();
      } catch {
        mdBroken = true;
        noteHiccup();
        return '';
      }
    };
    if (spinnerAllowed) spinner.start();
    try {
      const result = await runAgentLoop({
        client,
        model: current.id,
        messages: [...history],
        tools,
        maxTurns,
        cwd,
        permissions,
        // Modes own approval now; the loop-level bypass is kept ONLY for
        // --json --yes (machine runs — its legacy hands-free semantics).
        autoApprove: flags.yes === true && ctx.json,
        allows,
        renderDiff,
        signal: controller.signal,
        // v0.9: plan mode — mutating tool calls become /plan proposals.
        planGate: {
          isPlanMode: () => mode === 'plan',
          onProposal: (label) => {
            planProposals.push(label);
          },
        },
        callbacks: {
          onDelta: (text) => {
            try {
              if (stopSpinnerOnDelta) {
                spinner.stop();
                stopSpinnerOnDelta = false;
              }
              if (mdBroken) {
                r.writeRaw(`${text}\n`);
                return;
              }
              const rendered = md.push(text);
              if (rendered !== '') r.writeRaw(`${rendered}\n`); // stdout, live
            } catch {
              mdBroken = true;
              noteHiccup();
              try {
                r.writeRaw(`${text}\n`);
              } catch {
                // the channel itself is down
              }
            }
          },
          onReasoning: () => {
            // Thinking is NEVER printed — the spinner carries it: a
            // shimmering "Thinking…" while reasoning deltas stream.
            if (spinnerAllowed) {
              spinner.setFixedWord('Thinking…');
              if (!spinner.running) spinner.start();
            }
          },
          onToolStart: (name, label) => {
            if (spinner.running) spinner.stop();
            stopSpinnerOnDelta = false;
            try {
              ctx.io.writeErr(`${renderToolStart(name, label, theme)}\n`);
            } catch {
              noteHiccup();
            }
          },
          // Loop activity lines (· outside access granted for this session: …,
          // · denied by user, …) — plain dim stderr rows, same lane as the
          // tool rows so they read as a transcript of what happened.
          onActivity: (line) => {
            try {
              ctx.io.writeErr(`${theme.dim(line)}\n`);
            } catch {
              noteHiccup();
            }
          },
          onToolResult: (info) => {
            try {
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
            } catch {
              noteHiccup();
            }
            if (spinnerAllowed) spinner.start();
          },
          onTurnComplete: (totals) => {
            // The usage chunk closes the turn's stream: flush any buffered
            // partial reply line FIRST so the footer lands BELOW the reply
            // text, never above it (also keeps consecutive tool-loop turns
            // from merging into one markdown line).
            const flushed = safeFlush();
            if (flushed !== '') r.writeRaw(`${flushed}\n`);
            const footer = chatFooterLine(totals.usage, totals.charge);
            if (footer !== undefined) r.gray(footer);
          },
        },
      });
      const tail = safeFlush(); // normally '' — onTurnComplete flushed already
      if (tail !== '') r.writeRaw(`${tail}\n`);

      // The loop returned — the history is consistent; adopt it.
      history.length = 0;
      history.push(...result.messages);
      // Crash-safe: the completed turn is on disk from this moment.
      persistSession();
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
        // Ctrl+C also drops the one queued prompt (v0.9) — an aborted turn
        // must never roll into a line the user typed for a context that no
        // longer exists.
        queued.length = 0;
        r.bullet('Request cancelled — session kept');
      } else if (
        err instanceof SeloraApiError &&
        (err.kind === 'auth' || err.kind === 'auth_revoked')
      ) {
        // Fatal: the key is gone/revoked — exit 1 with the verbatim message.
        r.renderError(err);
        currentAbort = null;
        unpin();
        router?.detach();
        detachShiftTab();
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
  unpin();
  router?.detach();
  detachShiftTab();
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
  // Discoverability: a saved non-empty conversation is resumable.
  if (savedOnce && history.length > 0) {
    r.gray(
      `· Conversation saved — resume it with: selora resume${sessionName === 'chat' ? '' : ` ${sessionName}`}`,
    );
  }
  r.ok('Session ended');
}
