/**
 * Minimal fnmatch-style glob matcher + directory walk — no dependencies.
 *
 * Supported syntax (documented exactly in docs/agent.md):
 *   `*`        any characters except the path separator
 *   `**`       any number of path segments, including none — `**` before a
 *              separator matches zero or more whole directories (a pattern
 *              of double-star, separator, "node_modules", separator,
 *              double-star matches node_modules/x and a/node_modules/b);
 *              a trailing `**` matches everything below
 *   `?`        one character except the separator
 *   `[abc]`    character class, ranges `[a-z]`, negation `[!abc]` or `[^abc]`
 *   anything else is a literal
 *
 * Unbalanced quotes/classes degrade to literal matching — the matcher never
 * throws on a pattern. Matching is case-sensitive.
 *
 * The walk visits at most MAX_WALK_ENTRIES entries (a hard stop, reported to
 * the caller so it can say so honestly) and prunes directories the caller
 * excludes.
 */

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

export const MAX_WALK_ENTRIES = 5000;

/** Compile a glob pattern to a RegExp. `pattern` must be a non-empty string. */
export function globToRegExp(pattern: string): RegExp {
  const src = globToSource(pattern);
  try {
    return new RegExp(`^${src}$`);
  } catch {
    // A class the regex engine rejects (e.g. "[z-a]") — recompile with every
    // class flattened to a literal, so a bad pattern never throws.
    return new RegExp(`^${escapeRegExp(pattern)}$`);
  }
}

function globToSource(pattern: string): string {
  const pat = pattern.replace(/^\.\//, '').replace(/\/+$/, '');
  let out = '';
  let i = 0;
  while (i < pat.length) {
    const c = pat[i]!;
    if (c === '*') {
      if (pat[i + 1] === '*') {
        // `**` — any number of segments. `**/` (zero+ whole segments) and a
        // trailing `**` (anything below) are the two useful placements.
        if (pat[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if (c === '[') {
      const close = findClassClose(pat, i + 1);
      if (close > i + 1) {
        out += classSource(pat.slice(i + 1, close));
        i = close + 1;
        continue;
      }
      // Unclosed or empty class: literal '['.
      out += escapeRegExp('[');
      i += 1;
      continue;
    }
    out += escapeRegExp(c);
    i += 1;
  }
  return out;
}

/** Find the `]` closing a class opened at pat[i-1]. A `]` right after `[` or `[!` is a literal. */
function findClassClose(pat: string, start: number): number {
  let j = start;
  if (pat[j] === '!' || pat[j] === '^') j += 1;
  if (pat[j] === ']') j += 1; // leading `]` is literal
  while (j < pat.length && pat[j] !== ']') j += 1;
  return j < pat.length ? j : -1;
}

/** Translate a fnmatch class body ("abc", "a-z", "!abc") to a regex class. */
function classSource(body: string): string {
  let inner = body;
  let negate = false;
  if (inner.startsWith('!') || inner.startsWith('^')) {
    negate = true;
    inner = inner.slice(1);
  }
  let safe = '';
  for (const ch of inner) {
    // Escape regex-special chars INSIDE a class (']' matters for the
    // leading-literal-']' case); keep `-` (range) as-is.
    if (ch === ']' || ch === '\\' || ch === '^') safe += `\\${ch}`;
    else safe += ch;
  }
  return `[${negate ? '^' : ''}${safe}]`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface WalkOptions {
  /** Directory to walk (absolute or resolved by the caller). */
  root: string;
  /** Patterns (e.g. the project exclude globs). Matching directories are pruned. */
  exclude: readonly string[];
  /** Hard stop after this many entries (default MAX_WALK_ENTRIES). */
  maxEntries?: number | undefined;
}

export interface WalkEntry {
  /** Path relative to the walk root, `/`-separated, no leading `./`. */
  rel: string;
  /** Absolute path. */
  abs: string;
  isFile: boolean;
}

export interface WalkResult {
  entries: WalkEntry[];
  /** True when the entry cap was hit — the walk is a partial view. */
  truncated: boolean;
}

/**
 * Deterministic (sorted, depth-first) walk of `root`. `exclude` patterns are
 * matched against paths relative to the walk root; a directory whose own path
 * would put everything under an excluded pattern is pruned entirely.
 */
export async function walkTree(opts: WalkOptions): Promise<WalkResult> {
  const max = opts.maxEntries ?? MAX_WALK_ENTRIES;
  const excludeRes = opts.exclude.map((p) => globToRegExp(p));
  const entries: WalkEntry[] = [];
  let truncated = false;

  // A directory is pruned when anything below it is excluded — tested with a
  // child sentinel so `**/node_modules/**` also prunes the bare `node_modules`.
  const dirExcluded = (relDir: string): boolean =>
    excludeRes.some((re) => re.test(`${relDir}/x`));

  async function walk(absDir: string, relDir: string): Promise<void> {
    if (truncated) return;
    let dirents;
    try {
      dirents = await readdir(absDir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip, never crash the walk
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (entries.length >= max) {
        truncated = true;
        return;
      }
      const rel = relDir === '' ? d.name : `${relDir}/${d.name}`;
      if (d.isDirectory()) {
        if (dirExcluded(rel)) continue;
        await walk(join(absDir, d.name), rel);
        continue;
      }
      // isFile() false covers symlinks (lstat semantics) — resolve them: a
      // symlink to a file is a file entry; a broken/dangling one is skipped.
      if (d.isFile()) {
        entries.push({ rel, abs: join(absDir, d.name), isFile: true });
      } else {
        // symlink: stat the target through the readdir-provided path
        entries.push({ rel, abs: join(absDir, d.name), isFile: false });
      }
    }
  }

  await walk(opts.root, '');
  return { entries, truncated };
}
