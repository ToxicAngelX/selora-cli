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
import { themeFor, type Theme } from '../ui/theme.js';

/** Display-time fallback when no default is configured — never auto-written. */
export const DEFAULT_MODEL_FALLBACK = 'glm-5.3-flash';

export interface ModelFlags {
  unset?: boolean | undefined;
}

function moneyCell(raw: string): string {
  return raw !== '' ? formatUsd(raw) : '—';
}

function renderModelCard(
  r: Renderer,
  theme: Theme,
  title: string,
  fields: Array<{ label: string; value: string; plainValue: string }>,
  limits: Record<string, unknown>,
): void {
  const limitKeys = Object.keys(limits).sort();
  const limitEntries = limitKeys.map((k) => {
    let val: string;
    try {
      val = JSON.stringify(limits[k]) ?? 'null';
    } catch {
      val = '(unreadable)';
    }
    return { label: `  ${k}`, value: val };
  });

  const maxFieldWidth = Math.max(
    ...fields.map((f) => 12 + f.plainValue.length),
    ...limitEntries.map((e) => e.label.length + e.value.length + 2),
    title.length + 8,
    44,
  );
  const cardWidth = maxFieldWidth + 6;
  const innerWidth = cardWidth - 4;

  r.line('SELORA MODEL');
  r.line(theme.dim(`╭─── ${title} ${'─'.repeat(Math.max(0, cardWidth - title.length - 8))}╮`));
  for (const f of fields) {
    const pad = Math.max(1, innerWidth - 12 - f.plainValue.length);
    r.line(
      `${theme.dim('│')}  ${theme.dim(f.label.padEnd(12))}${f.value}${' '.repeat(pad)}${theme.dim('│')}`,
    );
  }
  if (limitKeys.length === 0) {
    const pad = Math.max(1, innerWidth - 12 - 1);
    r.line(
      `${theme.dim('│')}  ${theme.dim('Limits'.padEnd(12))}—${' '.repeat(pad)}${theme.dim('│')}`,
    );
  } else {
    const pad = Math.max(1, innerWidth - 12);
    r.line(
      `${theme.dim('│')}  ${theme.dim('Limits'.padEnd(12))}${' '.repeat(pad)}${theme.dim('│')}`,
    );
    for (const e of limitEntries) {
      const ePad = Math.max(1, innerWidth - 20 - e.value.length);
      r.line(
        `${theme.dim('│')}  ${theme.dim(e.label.padEnd(20))}${e.value}${' '.repeat(ePad)}${theme.dim('│')}`,
      );
    }
  }
  r.line(theme.dim(`╰${'─'.repeat(cardWidth - 2)}╯`));
}

export async function runModel(
  ctx: CliContext,
  id: string | undefined,
  flags: ModelFlags,
): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const theme = themeFor(loadConfig().theme, ctx.io.isTTY);

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
    const isConfigured = cfg.defaultModel !== undefined;
    const badge = isConfigured ? '[configured]' : '[default fallback]';
    const badgeColored = isConfigured ? theme.success(badge) : theme.dim(badge);

    r.line('SELORA MODEL');
    const cardWidth = 54;
    r.line(theme.dim(`╭─── Current Model ${'─'.repeat(Math.max(0, cardWidth - 21))}╮`));
    const pad = Math.max(1, cardWidth - 4 - 12 - current.length - badge.length);
    r.line(
      `${theme.dim('│')}  ${theme.dim('Default'.padEnd(12))}${theme.cyan(current)}${' '.repeat(pad)}${badgeColored}  ${theme.dim('│')}`,
    );
    r.line(theme.dim(`╰${'─'.repeat(cardWidth - 2)}╯`));
    r.bullet('Set with: selora model <id> · clear with: selora model --unset');
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

  try {
    const m = await getModel(client, id.trim());
    const savedId = m.id !== '' ? m.id : id.trim();
    saveConfig({ ...loadConfig(), defaultModel: savedId });
    if (ctx.json) {
      r.jsonOut({ ok: true, model: m, default_model_set: savedId });
      return;
    }

    const statusBadge =
      m.status === 'active'
        ? theme.success('[active]')
        : m.status !== ''
          ? theme.dim(`[${m.status}]`)
          : '—';
    const statusPlain = m.status !== '' ? `[${m.status}]` : '—';

    const fields: Array<{ label: string; value: string; plainValue: string }> = [
      {
        label: 'ID',
        value: m.id !== '' ? theme.cyan(m.id) : '—',
        plainValue: m.id !== '' ? m.id : '—',
      },
      {
        label: 'Name',
        value: m.display_name !== '' ? m.display_name : '—',
        plainValue: m.display_name !== '' ? m.display_name : '—',
      },
      {
        label: 'Provider',
        value: m.provider !== '' ? m.provider : '—',
        plainValue: m.provider !== '' ? m.provider : '—',
      },
      {
        label: 'Status',
        value: statusBadge,
        plainValue: statusPlain,
      },
      {
        label: '$/M in',
        value: moneyCell(m.pricing.input_per_1m),
        plainValue: moneyCell(m.pricing.input_per_1m),
      },
      {
        label: '$/M out',
        value: moneyCell(m.pricing.output_per_1m),
        plainValue: moneyCell(m.pricing.output_per_1m),
      },
    ];

    renderModelCard(r, theme, 'Model Details', fields, m.limits);
    r.ok(`Default model set to ${savedId}`);
  } catch (err) {
    // Unknown model: 404 → the backend's own "Model not available" message.
    r.renderError(err);
  }
}
