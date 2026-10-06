/**
 * The tool path sandbox. Every filesystem tool resolves its input through
 * resolveToolPath() FIRST — the rules (docs/agent.md):
 *  - The tool's world is the project root (the cwd at launch). Absolute paths
 *    must already be inside it; relative paths resolve against it.
 *  - Containment is checked on the RESOLVED path, so `..` cannot climb out.
 *  - Symlinks are resolved (realpath) and re-checked, so a link pointing
 *    outside the project is refused rather than followed out.
 *  - read/search tools refuse files over MAX_TOOL_FILE_BYTES (256 KB) and
 *    paths matching the project's context exclude globs (the selora.json
 *    `context.exclude` list — or the shipped defaults when there is no file).
 *
 * Errors are honest strings the tool returns as its result — never exceptions
 * from this module.
 */

import { lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadProjectConfig, DEFAULT_CONTEXT_EXCLUDE } from '../config/project.js';
import { globToRegExp } from './tools/glob.js';

/** Files larger than this are refused by read/search tools (size reported). */
export const MAX_TOOL_FILE_BYTES = 256 * 1024;

export type PathResolution = { ok: true; abs: string; rel: string } | { ok: false; error: string };

function inside(root: string, candidate: string): boolean {
  if (candidate === root) return true;
  return candidate.startsWith(root + sep);
}

/**
 * Resolve a tool input path inside `root` and verify containment. `input` is
 * untrusted model output: anything that is not a plain non-empty string is
 * refused with the exact reason.
 */
export function resolveToolPath(root: string, input: unknown): PathResolution {
  if (typeof input !== 'string' || input.trim() === '') {
    return { ok: false, error: 'path must be a non-empty string' };
  }
  const p = input.trim();
  if (p.includes('\0')) return { ok: false, error: 'path contains a NUL byte' };
  const rootReal = safeRealpath(root) ?? resolve(root);
  const candidate = isAbsolute(p) ? resolve(p) : resolve(rootReal, p);
  if (!inside(rootReal, candidate)) {
    return { ok: false, error: `path escapes the project root: ${input}` };
  }
  // Symlinks: resolve the target and re-check containment. For a path that
  // does not exist yet (write_file), resolve the deepest EXISTING ancestor
  // and re-append the rest — so a symlinked directory cannot smuggle a new
  // file outside the project.
  const abs = resolveReal(candidate);
  if (!inside(rootReal, abs)) {
    return { ok: false, error: `path resolves outside the project root (symlink?): ${input}` };
  }
  // rel is the user-facing, wire-facing form: forward slashes on every platform
  // (path.relative yields '\\' on Windows otherwise, and every summary, preview,
  // and glob match is written against '/'-separated rels).
  return { ok: true, abs, rel: relative(rootReal, abs).split(sep).join('/') };
}

/** realpath when the whole path exists; else realpath of the deepest existing ancestor + the rest. */
function resolveReal(candidate: string): string {
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
 * The exclude globs enforced for read/search tools: the project's selora.json
 * `context.exclude` when present, else the shipped defaults (node_modules and
 * dist trees at any depth — written as double-star patterns in
 * DEFAULT_CONTEXT_EXCLUDE). v0.1 saved these globs without reading them;
 * v0.2's agent reads exactly this half — `context.include` stays advisory (a
 * hint of what matters), never a whitelist, so the agent can still read files
 * like package.json that sit outside the default includes.
 */
export function effectiveExcludeGlobs(root: string): string[] {
  const context = loadProjectConfig(root).context;
  if (context !== undefined && context.exclude.length > 0) return [...context.exclude];
  return [...DEFAULT_CONTEXT_EXCLUDE];
}

/** True when `rel` (root-relative, `/`-separated) matches an exclude glob. */
export function isExcludedRel(rel: string, exclude: readonly string[]): boolean {
  return exclude.some((pattern) => globToRegExp(pattern).test(rel));
}

/** stat() a resolved path; null when missing/unreadable — never throws. */
export function statPath(abs: string): { size: number; isFile: boolean } | null {
  try {
    const st = statSync(abs);
    return { size: st.size, isFile: st.isFile() };
  } catch {
    return null;
  }
}

/** lstat() wrapper for existence checks — never throws. */
export function pathExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}
