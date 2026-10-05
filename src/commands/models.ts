/**
 * `selora models` — the model table. Calls /v1/models with auth:'none'
 * (load-bearing: the internal flavor — the only one WITH pricing — is only
 * returned when no Authorization header is sent). NO context-length and NO
 * vision columns: the backend does not expose them (docs/api-gaps.md).
 * `supports_1m_context:true` models get a `1m` tag next to the id.
 */

import type { CliContext } from '../context.js';
import { resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { listModels, type ModelSummary } from '../api/endpoints/models.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';

function moneyCell(raw: string): string {
  return raw !== '' ? formatUsd(raw) : '—';
}

export async function runModels(ctx: CliContext): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const settings = resolveSettings();
  const baseUrl = ctx.apiUrl ?? settings.apiUrl;
  const client = new SeloraClient({
    baseUrl,
    apiKey: getStoredKey(),
    debug: ctx.debug,
    logger: ctx.io.err,
  });

  try {
    const models = await listModels(client);
    if (ctx.json) {
      r.jsonOut({ ok: true, models });
      return;
    }
    r.line('SELORA MODELS');
    r.divider();
    if (models.length === 0) {
      r.line('No models available.');
      return;
    }
    const sorted: ModelSummary[] = [...models].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const rows = sorted.map((m) => ({
      id: m.supports_1m_context ? `${m.id} 1m` : m.id,
      provider: m.provider !== '' ? m.provider : '—',
      in: moneyCell(m.pricing.input_per_1m),
      out: moneyCell(m.pricing.output_per_1m),
      status: m.status !== '' ? m.status : '—',
      name: m.display_name,
    }));
    const wId = Math.max(2, ...rows.map((x) => x.id.length)) + 2;
    const wProv = Math.max(8, ...rows.map((x) => x.provider.length)) + 2;
    const wIn = Math.max(6, ...rows.map((x) => x.in.length)) + 2;
    const wOut = Math.max(7, ...rows.map((x) => x.out.length)) + 2;
    r.gray(
      `${'ID'.padEnd(wId)}${'PROVIDER'.padEnd(wProv)}${'$/M IN'.padStart(wIn)}${'$/M OUT'.padStart(wOut)} STATUS`,
    );
    for (const row of rows) {
      r.line(
        `${row.id.padEnd(wId)}${row.provider.padEnd(wProv)}${row.in.padStart(wIn)}${row.out.padStart(wOut)} ${row.status}`,
      );
      if (row.name !== '' && row.name !== row.id.replace(/ 1m$/, '')) {
        r.gray(`  ${row.name}`);
      }
    }
  } catch (err) {
    r.renderError(err);
  }
}
