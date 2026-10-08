/**
 * `selora run "<prompt>"` — one-shot streaming completion, and (v0.2) a REAL
 * agent: the request carries the tool definitions, and when the model
 * actually requests tools on the wire (finish_reason 'tool_calls' / delta
 * tool_calls), each call goes through the permission gate (dry-run preview →
 * y/n/a[/e]) before it executes; results are appended and the model streams
 * again — bounded by the turn cap, with a 3-consecutive-failure breaker and
 * a cumulative token/cost budget across turns. Detection is wire-based,
 * never prompt-text guessing.
 *
 * Content deltas stream to stdout, reasoning dim-gray to stderr, tool
 * activity as gray `→ tool(...)` lines on stderr — the same live-progress
 * contract as v0.1 plus the tool lines. `--safe` restricts the loop to
 * read-only tools; `--yes` auto-approves everything the (possibly --safe)
 * toolset still allows; `--json` buffers machine output and DENIES tools
 * unless --yes is also given (prompts cannot be interactive in JSON mode).
 *
 * v0.6: images and crash-safe sessions. `@<path>` tokens in the prompt attach
 * local images (png/jpg/jpeg/webp/gif, ≤4 MB, max 4) as image_url parts —
 * `selora run "what is in @shot.png"`. And `--session <name>` no longer means
 * "saved only when the run completes": the agent loop reports the history at
 * every resumable checkpoint, so a Ctrl+C (or a failure) mid-run saves the
 * turns completed SO FAR — resume with `selora resume <name>`.
 *
 * Model resolution (silent unless --debug): --model > the resumed session's
 * model > the project's selora.json model > the global defaultModel >
 * 'glm-5.3-flash'. Turn cap: --max-turns > selora.json agent.maxTurns > 25.
 */

import { isAbsolute, resolve } from 'node:path';
import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { loadProjectConfig } from '../config/project.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import type { ChatMessage } from '../api/endpoints/chat.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { chatFooterLine, formatChatCost } from './chat-footer.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';
import { formatCount } from '../format.js';
import {
  imageMarker,
  parseImageInput,
  userMessageContent,
  type ImageAttachment,
} from '../images.js';
import { runAgentLoop, DEFAULT_MAX_TURNS } from '../agent/loop.js';
import { builtinTools } from '../agent/tools/index.js';
import { makeSubagentTool } from '../agent/tools/subagent.js';
import {
  SessionAllows,
  createAutoAsker,
  createDenyingAsker,
  createInteractiveAsker,
  type PermissionAsker,
} from '../agent/permissions.js';
import type { Tool } from '../agent/tool.js';
import { themeFor } from '../ui/theme.js';
import { renderToolResult, renderToolStart } from '../ui/chatui.js';
import { sanitizeTerminalText } from '../ui/terminal-text.js';
import { resolveDiffConfig } from '../config/diff.js';
import { computeFileDiff, DiffHistory, guardPath, renderFileDiff } from '../diff/index.js';
import type { FileChange, RenderOptions } from '../diff/types.js';
import {
  loadSession,
  newSession,
  saveSession,
  sessionNameOk,
  type StoredSession,
} from '../agent/session/store.js';

export interface RunFlags {
  model?: string | undefined;
  /** Directory whose selora.json is consulted (defaults to process.cwd()). */
  cwd?: string | undefined;
  /** Resume/create a named conversation session (saved at every checkpoint). */
  session?: string | undefined;
  /** Auto-approve tools non-interactively (still filtered by --safe). */
  yes?: boolean;
  /** Restrict the agent to read-only tools. */
  safe?: boolean;
  /** Turn cap override (1-200; default: selora.json agent.maxTurns or 25). */
  maxTurns?: number | undefined;
  /** v1.3: permissions.mode dry-run — proposed changes print, nothing writes. */
  dryRun?: boolean;
  /** v1.3: diff layout override — 'unified' | 'split' | 'auto'. */
  diffView?: string | undefined;
  /** v1.3: diff palette override — 'classic' | 'colorblind' | 'mono'. */
  diffPalette?: string | undefined;
}

/**
 * Minimal test/automation seam: if provided, called once with a function that
 * aborts the in-flight run (what Ctrl+C does live — SIGINT aborts, then the
 * completed turns are saved).
 */
export interface RunHooks {
  registerInterrupt?: ((interrupt: () => void) => void) | undefined;
}

type ModelSource =
  | '--model flag'
  | 'resumed session'
  | 'project selora.json'
  | 'global default model'
  | 'built-in default';

function resolveModel(
  flags: RunFlags,
  session: StoredSession | null,
): {
  model: string;
  source: ModelSource;
} {
  const flagModel = flags.model !== undefined ? flags.model.trim() : '';
  if (flagModel !== '') return { model: flagModel, source: '--model flag' };
  if (session !== null && session.model !== '') {
    return { model: session.model, source: 'resumed session' };
  }
  const project = loadProjectConfig(flags.cwd ?? process.cwd()).model;
  if (project !== undefined && project !== '')
    return { model: project, source: 'project selora.json' };
  const globalDefault = loadConfig().defaultModel;
  if (globalDefault !== undefined && globalDefault !== '')
    return { model: globalDefault, source: 'global default model' };
  return { model: DEFAULT_MODEL_FALLBACK, source: 'built-in default' };
}

function resolveMaxTurns(
  flags: RunFlags,
  cwd: string,
): { maxTurns?: number | undefined; error?: string } {
  if (flags.maxTurns !== undefined) {
    if (!Number.isInteger(flags.maxTurns) || flags.maxTurns < 1 || flags.maxTurns > 200) {
      return { maxTurns: undefined, error: '--max-turns must be an integer between 1 and 200' };
    }
    return { maxTurns: flags.maxTurns };
  }
  const fromConfig = loadProjectConfig(cwd).agent?.maxTurns;
  return { maxTurns: fromConfig ?? DEFAULT_MAX_TURNS };
}

export async function runRun(
  ctx: CliContext,
  prompt: string | undefined,
  flags: RunFlags,
  hooks: RunHooks = {},
): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  const cwd = flags.cwd ?? process.cwd();

  // Images: `@<path>` tokens attach local files as image_url parts. A parse
  // failure (missing file, too large, too many) exits 1 BEFORE any request.
  let promptText = prompt ?? '';
  let images: ImageAttachment[] = [];
  if (prompt !== undefined) {
    const parsed = parseImageInput(prompt, cwd);
    if (!parsed.ok) {
      process.exitCode = 1;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message: parsed.error } });
      else r.fail(parsed.error);
      return;
    }
    promptText = parsed.text;
    images = parsed.images;
  }

  if (promptText.trim() === '' && images.length === 0) {
    process.exitCode = 1;
    const message = 'Usage: selora run "<prompt>"';
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
    else r.fail(message);
    return;
  }

  // Same fail-fast as chat: /v1/chat/completions is API-key-only.
  if (getStoredKey() === undefined) {
    r.renderError(
      new SeloraApiError({ kind: 'auth', message: 'You are not logged in. Run: selora login' }),
    );
    return;
  }

  // Session: load the existing conversation or start a fresh one.
  let session: StoredSession | null = null;
  if (flags.session !== undefined) {
    if (!sessionNameOk(flags.session)) {
      process.exitCode = 1;
      const message =
        'session name must be 1-64 chars: letters, digits, dash, underscore, dot (alphanumeric first)';
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }
    session = loadSession(cwd, flags.session) ?? newSession(flags.session, '');
  }
  /** How many messages the session already held — the crash-save baseline. */
  const sessionBaseCount = session?.messages.length ?? 0;

  const { model, source } = resolveModel(flags, session);
  if (session !== null) session.model = model;
  if (ctx.debug) r.bullet(`model: ${model} (resolved from ${source})`);

  const { maxTurns, error: turnError } = resolveMaxTurns(flags, cwd);
  if (turnError !== undefined || maxTurns === undefined) {
    process.exitCode = 1;
    const message = turnError ?? 'invalid --max-turns';
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
    else r.fail(message);
    return;
  }
  if (ctx.debug)
    r.bullet(`agent: max ${maxTurns} turns${flags.safe ? ' (safe mode: read-only tools)' : ''}`);

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  // Initial history: the resumed session (if any) + this prompt (text and/or
  // image parts — the multimodal user content shape).
  const userContent = userMessageContent(promptText, images);
  const messages: ChatMessage[] = [
    ...(session?.messages ?? []),
    { role: 'user', content: userContent },
  ];
  // Attached images are announced once, on stderr — stdout stays reply text.
  if (!ctx.json) {
    for (const img of images) r.bullet(imageMarker(img));
  }

  // The toolset: the built-ins, filtered to read-only under --safe.
  const tools: Tool[] = flags.safe
    ? builtinTools().filter((t) => t.kind === 'read')
    : builtinTools();

  // v0.3: the galaxy theme for the permission prompt's colored diffs and the
  // rich tool display (TTY only; plain otherwise — NO_COLOR/non-TTY stay clean).
  const theme = themeFor(loadConfig().theme, ctx.io.isTTY);
  const richDisplay = ctx.io.isTTY && !ctx.json;

  // v1.3: the diff system — config + flags (flags win), the boxed renderer for
  // every diff the loop surfaces, dry-run mode, and on-disk checkpoints so a
  // later `selora chat` session can /undo what a run changed.
  if (
    flags.diffView !== undefined &&
    flags.diffView !== 'unified' &&
    flags.diffView !== 'split' &&
    flags.diffView !== 'auto'
  ) {
    process.exitCode = 1;
    r.fail(`invalid --diff-view "${flags.diffView}" — expected unified, split, or auto`);
    return;
  }
  if (
    flags.diffPalette !== undefined &&
    flags.diffPalette !== 'classic' &&
    flags.diffPalette !== 'colorblind' &&
    flags.diffPalette !== 'mono'
  ) {
    process.exitCode = 1;
    r.fail(`invalid --diff-palette "${flags.diffPalette}" — expected classic, colorblind, or mono`);
    return;
  }
  const diffConfig = resolveDiffConfig(loadConfig(), {
    diffView: flags.diffView,
    diffPalette: flags.diffPalette,
    dryRun: flags.dryRun === true,
  });
  const diffHistory = new DiffHistory({
    root: cwd,
    maxBytes: diffConfig.historyMaxSizeMB * 1024 * 1024,
  });
  const runDiffRenderOpts = (): RenderOptions => ({
    view: diffConfig.view,
    width: process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80,
    maxLines: diffConfig.maxLines,
    palette: diffConfig.palette,
    syntaxHighlight: diffConfig.syntaxHighlight,
    wordDiff: diffConfig.wordDiff,
    showWhitespace: diffConfig.showWhitespace,
    expandGenerated: !diffConfig.collapseGenerated,
  });
  const renderDiff = (before: string, after: string, path?: string): readonly string[] => {
    const p = path ?? 'file';
    const change: FileChange =
      before === '' && after !== ''
        ? { kind: 'created', path: p, newText: after }
        : after === '' && before !== ''
          ? { kind: 'deleted', path: p, oldText: before }
          : { kind: 'modified', path: p, oldText: before, newText: after };
    return renderFileDiff(
      computeFileDiff(change, { context: diffConfig.context }),
      theme,
      runDiffRenderOpts(),
    );
  };

  // The permission gate. JSON mode cannot prompt: --yes auto-approves,
  // otherwise every tool is denied (the denial text says how to change that).
  const permissions: PermissionAsker = ctx.json
    ? flags.yes === true
      ? createAutoAsker()
      : createDenyingAsker()
    : createInteractiveAsker({
        stdin: ctx.io.stdin,
        isTTY: ctx.io.isTTY,
        err: ctx.io.err,
        rawWrite: ctx.io.writeErr,
        style: {
          marker: (s) => theme.cyan(s),
          selected: (s) => theme.star(s),
          option: (s) => theme.dim(s),
          hint: (s) => theme.dim(s),
        },
      });

  // v1.0 subagents: the model can delegate self-contained tasks to a nested
  // agent loop sharing this run's cwd, permission gate, and session memory.
  // --safe keeps it out (read-only means read-only); --json without --yes
  // keeps it out (the sub's prompts can't display in JSON mode).
  const allows = new SessionAllows();
  if (!flags.safe && !(ctx.json && flags.yes !== true)) {
    tools.push(
      makeSubagentTool({
        client,
        model: () => model,
        permissions,
        allows,
        renderDiff,
        onSubEvent: (line) => {
          if (!ctx.json) r.writeRawGray(`${line}\n`);
        },
        signal: () => interrupt.signal,
        autoApprove: flags.yes === true,
        parentTools: tools,
      }),
    );
  }

  let content = '';
  let sawReasoning = false;

  // Crash-safe sessions (v0.6): the loop reports the history at every
  // resumable checkpoint. Ctrl+C aborts the in-flight stream (previously the
  // process just died and an attached session lost EVERYTHING) — the catch
  // path then saves the turns completed so far.
  const interrupt = new AbortController();
  const onSigint = (): void => interrupt.abort();
  process.once('SIGINT', onSigint);
  hooks.registerInterrupt?.(() => interrupt.abort());
  let checkpoint: ChatMessage[] | undefined;

  try {
    const result = await runAgentLoop({
      client,
      model,
      messages,
      tools,
      maxTurns,
      cwd,
      permissions,
      autoApprove: flags.yes === true,
      allows,
      signal: interrupt.signal,
      renderDiff,
      dryRun: diffConfig.reviewMode === 'dry-run',
      onFileChange: (rec) => {
        // Resolve through the sandbox guard so the checkpoint records the
        // REALPATHED absolute path (macOS tmpdir is a symlink — a naive
        // resolve(cwd, …) fails containment there).
        const g = guardPath(cwd, rec.path);
        diffHistory.record({
          absPath: g.ok ? g.value : isAbsolute(rec.path) ? rec.path : resolve(cwd, rec.path),
          displayPath: rec.path,
          changeKind: rec.kind,
          beforeText: rec.kind === 'created' ? undefined : rec.before,
          afterText: rec.after,
          mode: undefined,
        });
      },
      callbacks: {
        onDelta: (text) => {
          const safeText = sanitizeTerminalText(text);
          content += safeText;
          // --json buffers instead of streaming — one object at the end.
          if (!ctx.json) r.writeRaw(safeText);
        },
        onReasoning: (text) => {
          sawReasoning = true;
          if (!ctx.json) r.writeRawGray(text);
        },
        onActivity: (line) => {
          // Plain progress lines — only in the non-rich (non-TTY) renderer.
          if (!ctx.json && !richDisplay) r.writeRawGray(`${line}\n`);
        },
        onToolStart: richDisplay
          ? (name, label) => {
              ctx.io.writeErr(`${renderToolStart(name, label, theme)}\n`);
            }
          : undefined,
        onToolResult: richDisplay
          ? (info) => {
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
            }
          : undefined,
        onTurnComplete: (totals) => {
          if (!ctx.json) {
            const footer = chatFooterLine(totals.usage, totals.charge);
            if (footer !== undefined) r.gray(footer);
          }
        },
        onHistorySnapshot: (snap) => {
          checkpoint = snap;
        },
      },
    });

    // The loop returned (did not throw) — the turn history is consistent, so
    // a session can be saved.
    if (session !== null) {
      session = { ...session, model, messages: result.messages };
      const path = saveSession(cwd, session);
      if (!ctx.json) r.bullet(`session saved: ${flags.session} (${path})`);
    }

    if (ctx.json) {
      const shape: Record<string, unknown> = {
        ok: true,
        model,
        content,
        finishReason: result.finishReason,
        turns: result.turns,
        tools: result.toolEvents.map((e) => ({
          tool: e.name,
          label: e.label,
          ok: e.ok,
          summary: e.summary,
        })),
      };
      if (result.usageTotal !== undefined) {
        shape['usage'] = {
          promptTokens: result.usageTotal.promptTokens,
          completionTokens: result.usageTotal.completionTokens,
          totalTokens: result.usageTotal.totalTokens,
        };
      }
      if (result.chargeTotal !== undefined && result.chargeTotal !== '') {
        shape['charge'] = result.chargeTotal;
      }
      if (flags.session !== undefined) shape['session'] = flags.session;
      if (result.stop !== 'completed') shape['stopped'] = result.stop;
      r.jsonOut(shape);
      if (result.stop === 'tool-failures') process.exitCode = 1;
      return;
    }

    if (sawReasoning) r.writeRawGray('\n');
    r.writeRaw('\n'); // end the streamed reply line

    // Cumulative budget line — per-turn footers already printed above.
    if (result.usageTotal !== undefined) {
      const parts = [
        `Agent totals: ${formatCount(BigInt(result.turns))} turn${result.turns === 1 ? '' : 's'}`,
        `Tokens: ${formatCount(BigInt(result.usageTotal.totalTokens))}`,
      ];
      if (result.chargeTotalMicro !== undefined && result.chargeTotal !== undefined) {
        parts.push(`Cost: ${formatChatCost(result.chargeTotal)}`);
      }
      r.gray(`  ${parts.join(' · ')}`);
    }

    if (result.stop === 'max-turns') {
      r.bullet(
        `stopped at the turn cap (${maxTurns}) — raise agent.maxTurns in selora.json or pass --max-turns`,
      );
    } else if (result.stop === 'tool-failures') {
      process.exitCode = 1;
      r.fail('agent stopped: 3 consecutive tool failures');
    }
  } catch (err) {
    if (!ctx.json && content !== '') r.writeRaw('\n'); // end the partial line

    // Crash-safe save: whatever turn died, the checkpoints before it survived.
    // Never mid-turn state — the loop only reports wire-valid histories.
    if (session !== null && checkpoint !== undefined && checkpoint.length > sessionBaseCount) {
      try {
        session = { ...session, model, messages: checkpoint };
        saveSession(cwd, session);
        if (!ctx.json) {
          r.bullet(
            `session "${flags.session ?? ''}" saved up to the last completed turn — resume: selora resume ${flags.session ?? ''}`,
          );
        }
      } catch {
        if (!ctx.json) r.bullet('could not save the session — the completed turns are lost');
      }
    }

    if (err instanceof SeloraApiError && err.kind === 'cancelled') {
      // Ctrl+C: not a failure — the Unix 130, and (with --session) the turns
      // completed so far are already saved above.
      process.exitCode = 130;
      if (ctx.json) {
        r.jsonOut({ ok: false, error: { kind: 'cancelled', message: 'Request cancelled.' } });
      } else {
        r.bullet('Interrupted — request cancelled.');
      }
      return;
    }
    // Same mapping as chat: 402 window message verbatim, 429 retry hint,
    // 401 → login guidance, in-band stream errors verbatim.
    r.renderError(err);
  } finally {
    process.removeListener('SIGINT', onSigint);
    // The interactive asker owns a readline over stdin — an open readline on
    // a TTY keeps the event loop alive and the process would never exit.
    permissions.close?.();
  }
}
