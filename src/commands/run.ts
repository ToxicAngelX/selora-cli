/**
 * `selora run "<prompt>"` — one-shot streaming completion through the exact
 * SAME pipeline as chat (streamChat): content deltas stream to stdout the
 * moment they arrive, reasoning deltas go dim-gray to stderr, and the real
 * numbers-only footer (shared with chat) appears only when the usage chunk
 * actually arrived. No REPL, nothing written to disk — a single user message
 * in memory, gone when the process exits. Non-interactive by design and safe
 * with a piped stdout.
 *
 * Model resolution (silent unless --debug): --model > the project's
 * selora.json model > the global defaultModel > 'glm-5.3-flash'.
 *
 * Tool-call honesty: when the model actually requested tools on the wire
 * (finish_reason 'tool_calls' or any delta carrying tool_calls), the reply is
 * followed by a gray stderr line pointing at docs/agent.md — real detection,
 * never prompt-text guessing.
 *
 * --json mode does NOT mix streamed text with machine output: the reply is
 * buffered and printed as ONE {ok:true, model, content, usage?, charge?,
 * finishReason} object (no streaming display) — documented in
 * docs/commands/run.md.
 */

import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { loadProjectConfig } from '../config/project.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { streamChat } from '../api/endpoints/chat.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { chatFooterLine } from './chat-footer.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';

export interface RunFlags {
  model?: string | undefined;
  /** Directory whose selora.json is consulted (defaults to process.cwd()). */
  cwd?: string | undefined;
}

type ModelSource =
  '--model flag' | 'project selora.json' | 'global default model' | 'built-in default';

/**
 * --model flag > project selora.json (cwd) > global defaultModel >
 * 'glm-5.3-flash'. The source is reported only under --debug — normal runs
 * print nothing about the hierarchy.
 */
function resolveModel(flags: RunFlags): { model: string; source: ModelSource } {
  const flagModel = flags.model !== undefined ? flags.model.trim() : '';
  if (flagModel !== '') return { model: flagModel, source: '--model flag' };
  const project = loadProjectConfig(flags.cwd ?? process.cwd()).model;
  if (project !== undefined && project !== '')
    return { model: project, source: 'project selora.json' };
  const globalDefault = loadConfig().defaultModel;
  if (globalDefault !== undefined && globalDefault !== '')
    return { model: globalDefault, source: 'global default model' };
  return { model: DEFAULT_MODEL_FALLBACK, source: 'built-in default' };
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

  const { model, source } = resolveModel(flags);
  if (ctx.debug) r.bullet(`model: ${model} (resolved from ${source})`);

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  // Single user message, in-memory only — never written anywhere.
  let content = '';
  let sawReasoning = false;
  try {
    const result = await streamChat(
      client,
      { model, messages: [{ role: 'user', content: prompt }] },
      {
        onDelta: (text) => {
          content += text;
          // --json buffers instead of streaming — one object at the end.
          if (!ctx.json) r.writeRaw(text);
        },
        onReasoning: (text) => {
          sawReasoning = true;
          if (!ctx.json) r.writeRawGray(text);
        },
      },
    );

    if (ctx.json) {
      const shape: Record<string, unknown> = {
        ok: true,
        model,
        content,
        finishReason: result.finishReason,
      };
      if (result.usage !== undefined) {
        shape['usage'] = {
          promptTokens: result.usage.promptTokens,
          completionTokens: result.usage.completionTokens,
          totalTokens: result.usage.totalTokens,
        };
      }
      if (result.charge !== undefined && result.charge !== '') shape['charge'] = result.charge;
      r.jsonOut(shape);
      return;
    }

    if (sawReasoning) r.writeRawGray('\n');
    r.writeRaw('\n'); // end the streamed reply line
    const footer = chatFooterLine(result.usage, result.charge);
    if (footer !== undefined) r.gray(footer);
    // The model actually requested tools on the wire — say what v0.1 cannot do.
    if (result.toolCallsRequested) {
      r.bullet('agent mode not implemented yet — see docs/agent.md');
    }
  } catch (err) {
    if (!ctx.json && content !== '') r.writeRaw('\n'); // end the partial line
    // Same mapping as chat: 402 window message verbatim, 429 retry hint,
    // 401 → login guidance, in-band stream errors verbatim.
    r.renderError(err);
  }
}
