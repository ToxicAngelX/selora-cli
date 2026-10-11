/**
 * `selora models` — the model table. Calls /v1/models with auth:'none'
 * (load-bearing: the internal flavor — the only one WITH pricing — is only
 * returned when no Authorization header is sent). NO context-length and NO
 * vision columns: the backend does not expose them (docs/api-gaps.md).
 * `supports_1m_context:true` models get a `1m` tag next to the id.
 */

import type { CliContext } from '../context.js';
import { loadConfig, resolveSettings } from '../config/index.js';
import { SeloraClient } from '../api/client.js';
import { listModels, type ModelSummary } from '../api/endpoints/models.js';
import { getStoredKey } from '../auth/storage.js';
import { Renderer } from '../terminal/render.js';
import { formatUsd } from '../money.js';
import { themeFor } from '../ui/theme.js';

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

  const theme = themeFor(loadConfig().theme, ctx.io.isTTY);

  try {
    const models = await listModels(client);
    if (ctx.json) {
      r.jsonOut({ ok: true, models });
      return;
    }
    r.line('SELORA MODELS');
    r.gray('Tip: select a default model with: selora model <id>');
    r.divider();
    if (models.length === 0) {
      r.line('No models available.');
      return;
    }
    const sorted: ModelSummary[] = [...models].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const rows = sorted.map((m) => {
      const idText = m.supports_1m_context ? `${m.id} 1m` : m.id;
      const providerText = m.provider !== '' ? m.provider : '—';
      const inText = moneyCell(m.pricing.input_per_1m);
      const outText = moneyCell(m.pricing.output_per_1m);
      const statusText = m.status !== '' ? m.status : '—';
      return {
        idText,
        providerText,
        inText,
        outText,
        statusText,
        name: m.display_name,
        rawModel: m,
      };
    });
    const wId = Math.max(2, ...rows.map((x) => x.idText.length)) + 2;
    const wProv = Math.max(8, ...rows.map((x) => x.providerText.length)) + 2;
    const wIn = Math.max(6, ...rows.map((x) => x.inText.length)) + 2;
    const wOut = Math.max(7, ...rows.map((x) => x.outText.length)) + 2;
    r.gray(
      `${'ID'.padEnd(wId)}${'PROVIDER'.padEnd(wProv)}${'$/M IN'.padStart(wIn)}${'$/M OUT'.padStart(wOut)} STATUS`,
    );
    for (const row of rows) {
      const idCol = theme.cyan(row.idText) + ' '.repeat(Math.max(0, wId - row.idText.length));
      const provCol =
        theme.dim(row.providerText) + ' '.repeat(Math.max(0, wProv - row.providerText.length));
      const inCol = ' '.repeat(Math.max(0, wIn - row.inText.length)) + row.inText;
      const outCol = ' '.repeat(Math.max(0, wOut - row.outText.length)) + row.outText;
      const statusCol =
        row.statusText === 'active'
          ? theme.success(row.statusText)
          : row.statusText === 'inactive'
            ? theme.dim(row.statusText)
            : row.statusText;

      r.line(`${idCol}${provCol}${inCol}${outCol} ${statusCol}`);
      if (row.name !== '' && row.name !== row.rawModel.id) {
        r.gray(`  ${row.name}`);
      }
    }
  } catch (err) {
    r.renderError(err);
  }
}
