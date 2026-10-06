/**
 * `selora theme [name]` — show the current UI theme, or set it (galaxy |
 * nebula | mono). The choice is saved in the global config.json next to
 * defaultModel and applies to the galaxy UI (chat startup screen, prompt,
 * spinner, diffs). `mono` disables all theme colors — as does NO_COLOR,
 * TERM=dumb, or a non-TTY stream, per the theme's own level detection.
 */

import type { CliContext } from '../context.js';
import { loadConfig, saveConfig } from '../config/index.js';
import { isThemeName, paletteFor, THEME_NAMES, type ThemeName } from '../ui/theme.js';
import { Renderer } from '../terminal/render.js';

export interface ThemeFlags {
  name?: string | undefined;
}

export async function runTheme(ctx: CliContext, flags: ThemeFlags): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  const name = flags.name !== undefined ? flags.name.trim() : '';

  if (name === '') {
    const current = loadConfig().theme ?? 'galaxy';
    if (ctx.json) {
      r.jsonOut({ ok: true, theme: current, available: THEME_NAMES });
      return;
    }
    r.field('Theme', current);
    r.gray(`Available: ${THEME_NAMES.join(', ')}`);
    r.gray('Set one with: selora theme <name>');
    return;
  }

  if (!isThemeName(name)) {
    process.exitCode = 1;
    const message = `unknown theme "${name}" — available: ${THEME_NAMES.join(', ')}`;
    if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
    else {
      r.fail(message);
    }
    return;
  }

  const cfg = loadConfig();
  saveConfig({ ...cfg, theme: name as ThemeName });
  if (ctx.json) {
    r.jsonOut({ ok: true, theme: paletteFor(name).name });
    return;
  }
  r.ok(`Theme set to ${name}`);
  if (name === 'mono') r.bullet('mono disables all theme colors (same as NO_COLOR)');
}
