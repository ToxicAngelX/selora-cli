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
 * `--session <name>` resumes/saves the conversation under
 * .selora/sessions/<name>.json — saved only when the run completes.
 *
 * Model resolution (silent unless --debug): --model > the resumed session's
 * model > the project's selora.json model > the global defaultModel >
 * 'glm-5.3-flash'. Turn cap: --max-turns > selora.json agent.maxTurns > 25.
 */

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
import { runAgentLoop, DEFAULT_MAX_TURNS } from '../agent/loop.js';
import { builtinTools } from '../agent/tools/index.js';
import {
  createAutoAsker,
  createDenyingAsker,
  createInteractiveAsker,
  type PermissionAsker,
} from '../agent/permissions.js';
import type { Tool } from '../agent/tool.js';
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
  /** Resume/create a named conversation session (saved on completion). */
  session?: string | undefined;
  /** Auto-approve tools non-interactively (still filtered by --safe). */
  yes?: boolean;
  /** Restrict the agent to read-only tools. */
  safe?: boolean;
  /** Turn cap override (1-200; default: selora.json agent.maxTurns or 25). */
  maxTurns?: number | undefined;
}

type ModelSource =
  '--model flag' | 'resumed session' | 'project selora.json' | 'global default model' | 'built-in default';

function resolveModel(flags: RunFlags, session: StoredSession | null): {
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

function resolveMaxTurns(flags: RunFlags, cwd: string): { maxTurns?: number | undefined; error?: string } {
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
): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  if (prompt === undefined || prompt.trim() === '') {
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

  const cwd = flags.cwd ?? process.cwd();

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
  if (ctx.debug) r.bullet(`agent: max ${maxTurns} turns${flags.safe ? ' (safe mode: read-only tools)' : ''}`);

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  // Initial history: the resumed session (if any) + this prompt.
  const messages: ChatMessage[] = [
    ...(session?.messages ?? []),
    { role: 'user', content: prompt },
  ];

  // The toolset: the built-ins, filtered to read-only under --safe.
  const tools: Tool[] = flags.safe ? builtinTools().filter((t) => t.kind === 'read') : builtinTools();

  // The permission gate. JSON mode cannot prompt: --yes auto-approves,
  // otherwise every tool is denied (the denial text says how to change that).
  const permissions: PermissionAsker = ctx.json
    ? flags.yes === true
      ? createAutoAsker()
      : createDenyingAsker()
    : createInteractiveAsker({ stdin: ctx.io.stdin, isTTY: ctx.io.isTTY, err: ctx.io.err });

  let content = '';
  let sawReasoning = false;
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
      callbacks: {
        onDelta: (text) => {
          content += text;
          // --json buffers instead of streaming — one object at the end.
          if (!ctx.json) r.writeRaw(text);
        },
        onReasoning: (text) => {
          sawReasoning = true;
          if (!ctx.json) r.writeRawGray(text);
        },
        onActivity: (line) => {
          if (!ctx.json) r.writeRawGray(`${line}\n`);
        },
        onTurnComplete: (totals) => {
          if (!ctx.json) {
            const footer = chatFooterLine(totals.usage, totals.charge);
            if (footer !== undefined) r.gray(footer);
          }
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
    // Same mapping as chat: 402 window message verbatim, 429 retry hint,
    // 401 → login guidance, in-band stream errors verbatim.
    r.renderError(err);
  }
}
