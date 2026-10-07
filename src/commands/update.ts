/**
 * `selora update` — self-update. Compares VERSION against the npm registry's
 * `latest` dist-tag for `selora` and, when newer, runs the install itself:
 * `npm install -g selora@latest` spawned as a child (it inherits the same
 * stdio so the user sees npm's own progress; a global install needs their
 * npm, not ours). `--check` only reports; `--yes` skips the prompt.
 *
 * Network bits are injectable so tests never touch the real registry.
 */

import { spawn } from 'node:child_process';
import type { CliContext } from '../context.js';
import { VERSION } from '../version.js';
import { Renderer } from '../terminal/render.js';

const REGISTRY_LATEST_URL = 'https://registry.npmjs.org/-/package/selora/dist-tags';

/** What the registry call returns — injectable for tests. */
export type LatestVersionSource = () => Promise<string | null>;

/** What the install step runs — injectable for tests. */
export type InstallRunner = (version: string) => Promise<{ code: number | null }>;

const fetchLatest: LatestVersionSource = async () => {
  try {
    const res = await fetch(REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { latest?: unknown };
    return typeof body.latest === 'string' ? body.latest : null;
  } catch {
    return null;
  }
};

const runInstall: InstallRunner = (version) =>
  new Promise((resolve) => {
    // npm on PATH (the user's own npm — the one their global prefix belongs to).
    // stdio inherit: npm prints its own progress; the child IS the update.
    const child = spawn('npm', ['install', '-g', `selora@${version}`], {
      stdio: 'inherit',
      windowsHide: true,
    });
    child.on('error', () => resolve({ code: null }));
    child.on('close', (code) => resolve({ code }));
  });

function parseVersion(v: string): number[] {
  return v.split('.').map((p) => Number.parseInt(p, 10));
}

/** Semver-lite: newer = true when `a` > `b` (returns false for malformed). */
export function isNewer(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

export async function runUpdate(
  ctx: CliContext,
  opts: { check?: boolean; yes?: boolean; fetchLatestVersion?: LatestVersionSource; install?: InstallRunner } = {},
): Promise<void> {
  const r = new Renderer({ out: ctx.io.out, err: ctx.io.err, json: ctx.json, debug: ctx.debug });
  const latestSource = opts.fetchLatestVersion ?? fetchLatest;
  const installer = opts.install ?? runInstall;

  const latest = await latestSource();
  if (latest === null) {
    if (ctx.json) {
      r.jsonOut({ ok: false, error: 'could_not_check', current: VERSION });
    } else {
      r.line('selora — update');
      r.divider();
      r.field('Current', VERSION);
      r.line('· could not reach the npm registry — check your network and retry');
    }
    process.exitCode = 1;
    return;
  }

  const upToDate = !isNewer(latest, VERSION);

  if (ctx.json) {
    r.jsonOut({
      ok: true,
      current: VERSION,
      latest,
      update_available: !upToDate,
    });
    return;
  }

  r.line('selora — update');
  r.divider();
  r.field('Current', VERSION);
  r.field('Latest', latest);

  if (upToDate) {
    r.line('✓ up to date — nothing to do');
    return;
  }

  if (opts.check === true) {
    r.line(`· update available: run \`npm install -g selora@${latest}\``);
    return;
  }

  if (opts.yes !== true) {
    // No interactive prompt machinery here — one honest line telling the user
    // how to apply it, exit 0 (an available update is not a failure).
    r.line(`· update available — run \`selora update --yes\` to install selora@${latest}`);
    return;
  }

  r.line(`· installing selora@${latest} …`);
  const result = await installer(latest);
  if (result.code === 0) {
    r.line(`✓ updated to ${latest} — run \`selora --version\` to confirm`);
  } else {
    r.line(`✗ install failed (exit ${result.code ?? 'none'}) — run \`npm install -g selora@${latest}\` manually`);
    process.exitCode = 1;
  }
}
