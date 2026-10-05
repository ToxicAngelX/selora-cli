/**
 * `selora model [id]` — show the configured default model (fallback
 * 'glm-5.3-flash' at DISPLAY time only, never written implicitly), or fetch a
 * model's detail (auth:'none' route) and save it as the default. Unknown ids
 * surface the backend's honest 404 ("Model not available"). `--unset` clears
 * the stored default. The backend exposes no context length / vision flag —
 * neither is displayed (docs/api-gaps.md).
 */

import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings, saveConfig } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { getModel } from '../api/endpoints/models.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';

/** Display-time fallback when no default is configured — never auto-written. */
export const DEFAULT_MODEL_FALLBACK = 'glm-5.3-flash';

export interface ModelFlags {
  unset?: boolean | undefined;
}

function moneyCell(raw: string): string {
  return raw !== '' ? formatUsd(raw) : '—';
}

function renderLimits(r: Renderer, limits: Record<string, unknown>): void {
  const keys = Object.keys(limits).sort();
  if (keys.length === 0) {
    r.field('Limits', '—');
    return;
  }
  r.field('Limits', '');
  for (const key of keys) {
    let value: string;
    try {
      value = JSON.stringify(limits[key]) ?? 'null';
    } catch {
      value = '(unreadable)';
    }
    r.field(`  ${key}`, value);
  }
}

export async function runModel(ctx: CliContext, id: string | undefined, flags: ModelFlags): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });

  if (flags.unset === true) {
    const cfg = loadConfig();
    if (cfg.defaultModel === undefined) {
      if (ctx.json) r.jsonOut({ ok: true, cleared: false, note: 'No default model configured.' });
      else r.bullet('No default model configured — nothing to clear.');
      return;
    }
    const next = { ...cfg };
    delete next.defaultModel;
    saveConfig(next);
    if (ctx.json) r.jsonOut({ ok: true, cleared: true });
    else r.ok('Default model cleared');
    return;
  }

  if (id === undefined || id.trim() === '') {
    const cfg = loadConfig();
    const current = cfg.defaultModel ?? DEFAULT_MODEL_FALLBACK;
    if (ctx.json) {
      r.jsonOut({ ok: true, default_model: current, configured: cfg.defaultModel !== undefined });
      return;
    }
    r.line('SELORA MODEL');
    r.divider();
    r.field('Default', current);
    r.bullet('Set with: selora model <id> · clear with: selora model --unset');
    return;
  }

  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({ baseUrl, apiKey: getStoredKey(), debug: ctx.debug, logger: ctx.io.err });

  try {
    const m = await getModel(client, id.trim());
    const savedId = m.id !== '' ? m.id : id.trim();
    saveConfig({ ...loadConfig(), defaultModel: savedId });
    if (ctx.json) {
      r.jsonOut({ ok: true, model: m, default_model_set: savedId });
      return;
    }
    r.line('SELORA MODEL');
    r.divider();
    r.field('ID', m.id !== '' ? m.id : '—');
    r.field('Name', m.display_name !== '' ? m.display_name : '—');
    r.field('Provider', m.provider !== '' ? m.provider : '—');
    r.field('Status', m.status !== '' ? m.status : '—');
    r.field('$/M in', moneyCell(m.pricing.input_per_1m));
    r.field('$/M out', moneyCell(m.pricing.output_per_1m));
    renderLimits(r, m.limits);
    r.ok(`Default model set to ${savedId}`);
  } catch (err) {
    // Unknown model: 404 → the backend's own "Model not available" message.
    r.renderError(err);
  }
}
