/**
 * `selora trust [add <dir> | remove <dir>]` — manage the trusted-workspace
 * list (the config-dir trusted.json the chat trust screen reads). No args
 * lists the trusted folders; add/remove resolve the given path to its REAL
 * absolute form (symlinks resolved, on-disk casing) before touching the list.
 *
 * Trust is about the chat trust screen only: it skips the one-time folder
 * question. The agent's permission gates (per-tool prompts, outside-root
 * session grants) are untouched by it.
 */

import type { CliContext } from '../context.js';
import { Renderer } from '../terminal/render.js';
import { canonicalDir, loadTrustedDirs, trustDir, untrustDir } from '../config/trust.js';

export interface TrustFlags {
  /** 'add' | 'remove' | undefined (list). */
  action?: string | undefined;
  /** The directory for add/remove. */
  dir?: string | undefined;
}

const USAGE = 'usage: selora trust [add <dir> | remove <dir>]';

export async function runTrust(ctx: CliContext, flags: TrustFlags): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });

  const action = flags.action?.trim() ?? '';

  if (action === '' || action === 'list') {
    const dirs = loadTrustedDirs();
    if (ctx.json) {
      r.jsonOut({ ok: true, trusted: dirs });
      return;
    }
    if (dirs.length === 0) {
      r.gray('No trusted workspaces — selora chat asks once per folder.');
      r.gray('Trust the current folder with: selora trust add .');
      return;
    }
    for (const d of dirs) r.line(d);
    return;
  }

  if (action === 'add' || action === 'remove') {
    const dir = flags.dir?.trim() ?? '';
    if (dir === '') {
      process.exitCode = 1;
      const message = `selora trust ${action} needs a directory — ${USAGE}`;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }
    if (action === 'add') {
      const canon = trustDir(dir);
      if (canon === null) {
        process.exitCode = 1;
        const message = `cannot trust ${dir} — no such directory`;
        if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
        else r.fail(message);
        return;
      }
      if (ctx.json) {
        r.jsonOut({ ok: true, trusted: canon });
        return;
      }
      r.ok(`Trusted ${canon}`);
      r.bullet('selora chat will not ask about this folder again');
      return;
    }
    // remove
    const removed = untrustDir(dir);
    if (removed === null) {
      const canon = canonicalDir(dir);
      if (ctx.json) {
        r.jsonOut({ ok: true, removed: null, trusted: loadTrustedDirs() });
        return;
      }
      r.bullet(
        canon === null
          ? `${dir} does not resolve to a directory — and is not on the trusted list`
          : `${canon} was not on the trusted list`,
      );
      return;
    }
    if (ctx.json) {
      r.jsonOut({ ok: true, removed, trusted: loadTrustedDirs() });
      return;
    }
    r.ok(`Removed ${removed} from the trusted list`);
    r.bullet('selora chat will ask again in that folder');
    return;
  }

  process.exitCode = 1;
  const message = `unknown action "${action}" — ${USAGE}`;
  if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
  else r.fail(message);
}
