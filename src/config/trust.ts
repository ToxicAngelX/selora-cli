/**
 * The trusted-workspace store (v0.8) — trusted.json in the config dir, next
 * to config.json. When `selora chat` starts in a folder that is not on this
 * list it asks once (the trust screen, src/ui/trustscreen.ts); a "yes" lands
 * here and the question is never asked again for that folder.
 * `selora trust [add|remove]` manages the list by hand.
 *
 * Paths are stored as REAL absolute paths (fs.realpathSync.native): symlinks
 * resolve and Windows gets the on-disk casing, so `~/proj`, a symlinked
 * checkout, and a short-name path all recognize the same folder. The file is
 * mode 0600 like config.json and written atomically (tmp + rename). A missing
 * or malformed file reads as an empty list — never a crash.
 */

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { configDir } from './index.js';

const TRUSTED_FILENAME = 'trusted.json';

export function trustedPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), TRUSTED_FILENAME);
}

/**
 * Read the trusted list. Missing file, malformed JSON, or an unexpected shape
 * all read as EMPTY (with the same stderr honesty config.json gets for
 * malformed content) — a broken trust file must never lock anyone out.
 */
export function loadTrustedDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  let text: string;
  try {
    text = readFileSync(trustedPath(env), 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`· Ignoring malformed ${TRUSTED_FILENAME} — treat it as empty.`);
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`· Ignoring malformed ${TRUSTED_FILENAME} — treat it as empty.`);
    return [];
  }
  const list = (parsed as Record<string, unknown>)['trusted'];
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const entry of list) {
    if (typeof entry === 'string' && isAbsolute(entry) && !out.includes(entry)) out.push(entry);
  }
  return out;
}

/**
 * Write the trusted list atomically (tmp file + rename) with mode 0600
 * (best-effort on Windows). Mirrors saveConfig.
 */
export function saveTrustedDirs(
  dirs: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, TRUSTED_FILENAME);
  const tmp = join(dir, `.${TRUSTED_FILENAME}.tmp-${randomUUID()}`);
  writeFileSync(tmp, `${JSON.stringify({ trusted: dirs }, null, 2)}\n`, { encoding: 'utf8' });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows / unusual filesystems — best effort.
  }
  renameSync(tmp, target);
  try {
    const st = statSync(target);
    if ((st.mode & 0o777) !== 0o600) chmodSync(target, 0o600);
  } catch {
    // best effort
  }
}

/**
 * The canonical form of a directory: absolute + symlink-free (on-disk casing
 * on Windows). Returns null when the path does not exist — a trust entry must
 * name a real folder.
 */
export function canonicalDir(dir: string): string | null {
  try {
    return realpathSync.native(resolve(dir));
  } catch {
    return null;
  }
}

/** True when `dir` (any spelling of it) is on the trusted list. */
export function isTrustedDir(dir: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const canon = canonicalDir(dir);
  if (canon === null) return false;
  return loadTrustedDirs(env).includes(canon);
}

/**
 * Add `dir` to the trusted list. Returns the stored canonical path, or null
 * when the path cannot be resolved to an existing directory.
 */
export function trustDir(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const canon = canonicalDir(dir);
  if (canon === null) return null;
  const dirs = loadTrustedDirs(env);
  if (!dirs.includes(canon)) {
    dirs.push(canon);
    saveTrustedDirs(dirs, env);
  }
  return canon;
}

/**
 * Remove `dir` from the trusted list. Matches the canonical form first, then
 * the plain resolved form (so an entry survives its folder being deleted).
 * Returns the removed canonical/resolved path, or null when it was not listed.
 */
export function untrustDir(dir: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const canon = canonicalDir(dir) ?? resolve(dir);
  const dirs = loadTrustedDirs(env);
  const kept = dirs.filter((d) => d !== canon);
  if (kept.length === dirs.length) return null;
  saveTrustedDirs(kept, env);
  return canon;
}

/** `~`-abbreviate an absolute path for display (the prompt line's style). */
export function homeAbbrev(abs: string, env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HOME'] ?? env['USERPROFILE'] ?? '';
  if (home === '') return abs;
  if (abs === home) return '~';
  const prefix = home.endsWith(sep) ? home : `${home}${sep}`;
  return abs.startsWith(prefix) ? `~${abs.slice(home.length)}` : abs;
}
