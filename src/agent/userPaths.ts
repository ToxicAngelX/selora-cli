/**
 * v0.3 user path resolution — the layer that lets the agent work on the whole
 * machine (docs/agent.md) while keeping the sandbox honest:
 *
 *  - `~`, `$VAR` / `${VAR}` / `%VAR%`, and the aliases desktop / downloads /
 *    documents all expand to real absolute paths (on Windows the OneDrive
 *    Desktop redirect is checked: %USERPROFILE%\Desktop vs
 *    %OneDrive%\Desktop — whichever exists).
 *  - A path that stays inside the project root resolves exactly like the v0.2
 *    sandbox (realpath + re-containment — a symlink cannot smuggle anything).
 *  - A path OUTSIDE the root does not error — it resolves (realpath'd) and is
 *    returned as `inside: false`; the TOOL decides whether that access was
 *    granted this session (ctx.outsideDirs, granted per-directory by an
 *    'always' answer) and otherwise reports `outside` so the permission gate
 *    can ask the user with the absolute path in hand.
 *
 *  - A relative path that does NOT exist in the project but whose first
 *    segment is an alias (e.g. "desktop/Projects") expands via the alias —
 *    but a real project-relative folder always wins, so a project containing
 *    a `desktop/` directory is not shadowed.
 *
 * Everything is injectable (env, home, exists, platform) so tests simulate
 * Windows on POSIX hermetically. This module never throws; bad input is an
 * honest {ok:false} error string (same tone as paths.ts).
 */

import { lstatSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface PathEnvOpts {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Existence probe (default: lstat — a dangling symlink does not count). */
  exists?: (abs: string) => boolean;
  platform?: NodeJS.Platform;
}

export const PATH_ALIASES: readonly string[] = ['desktop', 'downloads', 'documents'];

export type UserPathResolution =
  | { ok: true; inside: true; abs: string; rel: string }
  | { ok: true; inside: false; abs: string }
  | { ok: false; error: string };

function optsOf(opts?: PathEnvOpts): Required<PathEnvOpts> {
  return {
    env: opts?.env ?? process.env,
    home: opts?.home ?? homedir(),
    exists: opts?.exists ?? ((p) => defaultExists(p)),
    platform: opts?.platform ?? process.platform,
  };
}

function defaultExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function sepFor(platform: NodeJS.Platform): string {
  return platform === 'win32' ? '\\' : '/';
}

function isAbsFor(platform: NodeJS.Platform, p: string): boolean {
  if (platform === 'win32') {
    return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\'); // drive or UNC
  }
  return isAbsolute(p);
}

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  const joined = parts.join(sepFor(platform));
  // Normalizing duplicate separators keeps display clean without path module
  // semantics (which differ per host platform — tests simulate win32 on POSIX).
  return platform === 'win32' ? joined.replace(/\\+/g, '\\') : joined.replace(/\/{2,}/g, '/');
}

function insideDir(dir: string, candidate: string, platform: NodeJS.Platform): boolean {
  const s = sepFor(platform);
  if (candidate === dir) return true;
  return candidate.startsWith(dir.endsWith(s) ? dir : dir + s);
}

/** realpath when the whole path exists; else realpath of the deepest existing ancestor + the rest. */
function resolveRealPath(candidate: string): string {
  const direct = safeRealpath(candidate);
  if (direct !== undefined) return direct;
  const parts = candidate.split(sep);
  for (let i = parts.length; i > 0; i -= 1) {
    const prefix = parts.slice(0, i).join(sep);
    const real = safeRealpath(prefix === '' ? sep : prefix);
    if (real === undefined) continue;
    const rest = parts.slice(i).join(sep);
    return rest === '' ? real : `${real}${sep}${rest}`;
  }
  return candidate;
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Expand $VAR, ${VAR}, and %VAR% using the env. Unknown variables are left
 * as written (the resulting path then simply does not resolve further, and
 * the honest error surfaces at the next layer).
 */
export function expandPathVars(input: string, opts?: PathEnvOpts): string {
  const { env } = optsOf(opts);
  return input.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (whole, braced, plain, win) => {
    const name = braced ?? plain ?? win;
    const value = name !== undefined ? env[name] : undefined;
    return value !== undefined ? value : whole;
  });
}

/**
 * Resolve one of the desktop / downloads / documents aliases to a real
 * directory. On Windows, the OneDrive redirect wins when that folder exists
 * (OneDrive, OneDriveConsumer, or OneDriveConsumer env var + "Desktop" etc.);
 * otherwise %USERPROFILE%\<Name>. On POSIX, $HOME/<Name>. Returns null when
 * the alias is unknown or nothing plausible exists — the caller then treats
 * the segment as a plain relative path.
 */
export function resolveAliasDir(alias: string, opts?: PathEnvOpts): string | null {
  const o = optsOf(opts);
  const wanted = alias.toLowerCase();
  if (!(PATH_ALIASES as readonly string[]).includes(wanted)) return null;
  const proper =
    wanted === 'desktop' ? 'Desktop' : wanted === 'downloads' ? 'Downloads' : 'Documents';
  const candidates: string[] = [];
  if (o.platform === 'win32') {
    const userprofile = o.env['USERPROFILE'] ?? o.home;
    if (userprofile !== undefined && userprofile !== '')
      candidates.push(joinFor('win32', userprofile, proper));
    for (const one of ['OneDrive', 'OneDriveConsumer', 'OneDriveCommercial']) {
      const base = o.env[one];
      if (base !== undefined && base !== '') candidates.push(joinFor('win32', base, proper));
    }
  } else {
    const home = o.home;
    if (home !== '') candidates.push(joinFor(o.platform, home, proper));
  }
  for (const c of candidates) {
    if (o.exists(c)) return c;
  }
  return candidates[0] ?? null;
}

/** Split off a leading alias segment: 'desktop/Projects' → ['desktop', 'Projects']. */
function splitAliasPrefix(
  p: string,
  platform: NodeJS.Platform,
): { alias: string; rest: string } | null {
  const normalized = p.replace(/\\/g, '/');
  const slash = normalized.indexOf('/');
  const first = (slash < 0 ? normalized : normalized.slice(0, slash)).toLowerCase();
  if (!(PATH_ALIASES as readonly string[]).includes(first)) return null;
  const rest = slash < 0 ? '' : normalized.slice(slash + 1).replace(/\//g, sepFor(platform));
  return { alias: first, rest };
}

/**
 * The full resolution. `root` is the project root (the sandbox root). The
 * returned abs path is realpath-resolved (existing portion) so symlinks
 * cannot disguise a target; `rel` is '/'-separated like paths.ts.
 */
export function resolveUserPath(
  root: string,
  input: unknown,
  opts?: PathEnvOpts,
): UserPathResolution {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  const o = optsOf(opts);
  const raw = input.trim();
  if (raw.includes('\0')) return { ok: false, error: 'path contains a NUL byte' };

  const rootReal = safeRealpath(root) ?? resolve(root);
  const expanded = expandPathVars(raw, { env: o.env });

  let candidate: string;
  if (
    expanded.startsWith('~') &&
    (expanded.length === 1 || expanded[1] === '/' || expanded[1] === '\\')
  ) {
    const rest = expanded.slice(1).replace(/^[\\/]+/, '');
    candidate = rest === '' ? o.home : joinFor(o.platform, o.home, rest);
  } else if (isAbsFor(o.platform, expanded)) {
    candidate = expanded;
  } else {
    // Relative: a REAL project-relative path/alias wins over the alias names.
    const inRoot = resolve(rootReal, expanded);
    const aliasSplit = splitAliasPrefix(expanded, o.platform);
    if (aliasSplit !== null && !o.exists(inRoot)) {
      const dir = resolveAliasDir(aliasSplit.alias, opts);
      if (dir !== null) {
        candidate = aliasSplit.rest === '' ? dir : joinFor(o.platform, dir, aliasSplit.rest);
      } else {
        candidate = inRoot;
      }
    } else {
      candidate = inRoot;
    }
  }

  // Normalize POSIX-y candidates through resolve() (no-op for absolute win32
  // strings, which resolve() would mangle on a POSIX host).
  const normalized =
    o.platform === 'win32' && isAbsFor('win32', candidate) ? candidate : resolve(candidate);
  const abs = resolveRealPath(normalized);

  if (insideDir(rootReal, abs, o.platform)) {
    return {
      ok: true,
      inside: true,
      abs,
      rel: relative(rootReal, abs).split(sep).join('/'),
    };
  }
  return { ok: true, inside: false, abs };
}

/** True when `abs` sits inside (or equals) one of the session-granted dirs. */
export function isInsideAny(
  dirs: readonly string[],
  abs: string,
  platform?: NodeJS.Platform,
): boolean {
  const plat = platform ?? process.platform;
  return dirs.some((d) => insideDir(d, abs, plat));
}

/**
 * The directory an "always" answer grants for an outside target: the target
 * itself when it is an existing directory, else its parent (creating
 * <dir>/Projects grants <dir>).
 */
export function grantDirFor(abs: string, opts?: PathEnvOpts): string {
  const o = optsOf(opts);
  if (o.exists(abs)) return abs;
  const s = sepFor(o.platform);
  const cut = abs.lastIndexOf(s);
  if (cut <= 0) return abs;
  return abs.slice(0, cut);
}
