/**
 * `selora chat [--model <id>]` — interactive streaming REPL.
 *
 * Model resolution: --model > config defaultModel > 'glm-5.3-flash'. The
 * model is VERIFIED via the public GET /v1/models/:id route before the REPL
 * starts; a 404 prints the backend's honest "Model not available" (plus a
 * `selora models` hint) and never opens the prompt.
 *
 * Conversation state is in-memory only — never written to disk. Aborted
 * (Ctrl+C) and failed turns are dropped from the history entirely, so a
 * retry starts clean. Reasoning deltas stream dim-gray to stderr; content
 * deltas stream to stdout immediately; the per-reply footer appears ONLY
 * when the usage chunk actually arrived — real numbers only, never invented.
 */

import * as readline from 'node:readline';
import { Writable } from 'node:stream';
import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { getModel } from '../api/endpoints/models.js';
import { streamChat, type ChatMessage } from '../api/endpoints/chat.js';
import { getStoredKey } from '../auth/storage.js';
import { PromptClosedError } from '../auth/prompts.js';
import { Renderer } from '../terminal/render.js';
import { formatCount } from '../format.js';
import { formatUsd, formatUsdMicro, parseMoneyMicro } from '../money.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';

export interface ChatFlags {
  model?: string | undefined;
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

/** Verifies a model id via the public /v1/models/:id route; 404 propagates. */
async function verifyModel(client: SeloraClient, id: string): Promise<SessionModel> {
  const m = await getModel(client, id);
  return { id: m.id !== '' ? m.id : id, displayName: m.display_name };
}

function modelLabel(m: SessionModel): string {
  return m.displayName !== '' ? `${m.id} (${m.displayName})` : m.id;
}

/**
 * Per-reply cost display: formatUsd's 2 decimals would collapse a typical
 * per-message charge ("0.018234") to a meaningless "$0.01", so sub-dime
 * amounts show 3 decimals ("$0.018", same truncation-toward-zero rule).
 * Math is BigInt micro-units via the existing money helpers — never floats.
 */
function formatChatCost(charge: string): string {
  const micro = parseMoneyMicro(charge);
  if (micro === null) return formatUsd(charge);
  const abs = micro < 0n ? -micro : micro;
  if (abs !== 0n && abs < 100_000n) {
    const mills = abs / 1000n; // truncate toward zero
    return `$0.${mills.toString().padStart(3, '0')}`;
  }
  return formatUsdMicro(micro);
}

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
    r.renderError(new SeloraApiError({ kind: 'auth', message: 'You are not logged in. Run: selora login' }));
    return;
  }

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({ baseUrl, apiKey: getStoredKey(), debug: ctx.debug, logger: ctx.io.err });

  const flagModel = flags.model !== undefined ? flags.model.trim() : '';
  const wanted = flagModel !== '' ? flagModel : (loadConfig().defaultModel ?? DEFAULT_MODEL_FALLBACK);

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

  const history: ChatMessage[] = [];

  for (;;) {
    r.writeRawGray('> ');
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
      r.bullet('/model [id] — show or switch the model (verified before switching)');
      r.bullet('/help — show this list');
      r.bullet('/exit — end the session (Ctrl+D also works)');
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

    // A chat turn: stream with the full in-memory history.
    history.push({ role: 'user', content: trimmed });
    const controller = new AbortController();
    currentAbort = controller;
    hooks.registerInterrupt?.(() => controller.abort());
    let content = '';
    let sawReasoning = false;
    try {
      const result = await streamChat(
        client,
        { model: current.id, messages: [...history], signal: controller.signal },
        {
          onDelta: (text) => {
            content += text;
            r.writeRaw(text); // stdout, immediately, no buffering
          },
          onReasoning: (text) => {
            sawReasoning = true;
            r.writeRawGray(text); // stderr, dim gray
          },
        },
      );
      if (sawReasoning) r.writeRawGray('\n');
      r.writeRaw('\n');
      history.push({ role: 'assistant', content });
      if (result.usage !== undefined) {
        const parts = [`Tokens: ${formatCount(BigInt(result.usage.totalTokens))}`];
        if (result.charge !== undefined && result.charge !== '') {
          parts.push(`Cost: ${formatChatCost(result.charge)}`);
        }
        r.gray(`  ${parts.join(' · ')}`);
      }
    } catch (err) {
      if (content !== '') r.writeRaw('\n'); // end the partial line
      if (err instanceof SeloraApiError && err.kind === 'cancelled') {
        history.pop(); // drop the aborted pair entirely
        r.bullet('Request cancelled — session kept');
      } else if (err instanceof SeloraApiError && (err.kind === 'auth' || err.kind === 'auth_revoked')) {
        // Fatal: the key is gone/revoked — exit 1 with the verbatim message.
        r.renderError(err);
        currentAbort = null;
        rl.close();
        return;
      } else {
        history.pop(); // failed turn dropped — the user can retype it
        if (err instanceof SeloraApiError) {
          r.fail(err.message);
          if (err.hint !== undefined) r.bullet(err.hint);
        } else {
          r.fail('Unexpected CLI error.');
          r.bullet('(run with --debug for details)');
        }
      }
    } finally {
      currentAbort = null;
    }
  }

  rl.close();
  r.ok('Session ended');
}
