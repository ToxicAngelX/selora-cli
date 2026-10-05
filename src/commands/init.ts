/**
 * `selora init [--model <id>] [--force]` — write a project-local selora.json
 * in the CURRENT directory (distinct from the global XDG config). The stored
 * model is verified via the public GET /v1/models/:id route (auth:'none' —
 * the pricing-bearing internal flavor) BEFORE anything is written; a 404
 * prints the backend's honest "Model not available" and no file appears.
 *
 * The gray bullet after the write is the v0.2 truth: the agent reads the
 * context exclude globs (and the optional hand-edited "agent" section);
 * context.include stays advisory.
 */

import { existsSync } from 'node:fs';
import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { saveProjectConfig, projectConfigPath } from '../config/project.js';
import { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import { getModel } from '../api/endpoints/models.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { DEFAULT_MODEL_FALLBACK } from './model.js';

export interface InitFlags {
  model?: string | undefined;
  force?: boolean;
  /** Directory to write selora.json into (defaults to process.cwd()). */
  cwd?: string | undefined;
}

export async function runInit(ctx: CliContext, flags: InitFlags): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  const cwd = flags.cwd ?? process.cwd();
  const target = projectConfigPath(cwd);
  const existed = existsSync(target);

  if (existed && flags.force !== true) {
    // Refuse to clobber — the user must say --force.
    process.exitCode = 1;
    const message = 'selora.json already exists (use --force)';
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
    else r.fail(message);
    return;
  }

  // --model > the global defaultModel > the CLI's built-in default.
  const flagModel = flags.model !== undefined ? flags.model.trim() : '';
  const wanted =
    flagModel !== '' ? flagModel : (loadConfig().defaultModel ?? DEFAULT_MODEL_FALLBACK);

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  // auth:'none' on the models route — the stored key (if any) is irrelevant
  // and no Authorization header is sent (the internal flavor is the only one
  // with pricing).
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  let modelId: string;
  try {
    const m = await getModel(client, wanted);
    modelId = m.id !== '' ? m.id : wanted;
  } catch (err) {
    // Unknown model: the backend's own "Model not available" message,
    // verbatim, plus the listing hint. NO file is written.
    process.exitCode = 1;
    if (err instanceof SeloraApiError && err.status === 404) {
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

  const path = saveProjectConfig(cwd, modelId);

  if (ctx.json) {
    // created:true for a fresh file; overwritten:true when --force replaced one.
    const shape: Record<string, unknown> = { ok: true, path, model: modelId };
    shape[existed ? 'overwritten' : 'created'] = true;
    r.jsonOut(shape);
    return;
  }

  r.ok(`Wrote selora.json (model: ${modelId})`);
  r.bullet(
    'the agent enforces context.exclude for read/search tools; an optional "agent" section (maxTurns, allowWindowsCmd) can be hand-edited (see docs/agent.md)',
  );
}
