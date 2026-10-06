/**
 * Search tools: glob (pattern file-finding) and grep (line regex search).
 * Both walk the project through the shared capped walk (5000 entries, exclude
 * globs enforced), skip files over 256 KB (the skip count is reported), and
 * cap their results — glob 500 paths, grep 200 matches — so a runaway query
 * cannot flood the model or the terminal.
 */

import { readFile } from 'node:fs/promises';
import type { Tool, ToolResult } from '../tool.js';
import {
  effectiveExcludeGlobs,
  isExcludedRel,
  MAX_TOOL_FILE_BYTES,
  resolveToolPath,
  statPath,
} from '../paths.js';
import { globToRegExp, walkTree } from './glob.js';

const GLOB_RESULT_CAP = 500;
const GREP_MATCH_CAP = 200;
const GREP_LINE_CAP = 200;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

interface SearchPath {
  abs: string;
  /** Path relative to the project root — for display and exclude checks. */
  rootRel: string;
}

/** Resolve the optional search root (default '.'). */
function resolveSearchPath(cwd: string, input: unknown): SearchPath | { error: string } {
  if (input === undefined) return { abs: cwd, rootRel: '.' };
  if (typeof input !== 'string' || input.trim() === '') {
    return { error: 'path must be a non-empty string when given' };
  }
  const resolved = resolveToolPath(cwd, input);
  if (!resolved.ok) return { error: resolved.error };
  return { abs: resolved.abs, rootRel: resolved.rel };
}

export const globTool: Tool = {
  name: 'glob',
  description:
    'Find files matching a glob pattern (*, **, ?, [class]) under a path ' +
    '(default: the project root). Returns matching file paths, capped at 500. ' +
    'Directories excluded by the project context globs are not visited.',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, e.g. src/**/*.ts' },
      path: { type: 'string', description: 'Directory to search in (default: project root)' },
    },
    required: ['pattern'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['pattern'] === 'string' ? r['pattern'] : '<invalid pattern>';
    return `glob(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('glob: input must be an object');
    if (
      !Object.hasOwn(r, 'pattern') ||
      typeof r['pattern'] !== 'string' ||
      r['pattern'].trim() === ''
    ) {
      return badShape('glob: pattern must be a non-empty string');
    }
    const pattern = (r['pattern'] as string).trim();
    const base = resolveSearchPath(ctx.cwd, Object.hasOwn(r, 'path') ? r['path'] : undefined);
    if ('error' in base) return badShape(`glob: ${base.error}`);
    const exclude = effectiveExcludeGlobs(ctx.cwd);
    const walk = await walkTree({ root: base.abs, exclude });
    const re = globToRegExp(pattern);
    const matches: string[] = [];
    let truncated = false;
    for (const entry of walk.entries) {
      if (isExcludedRel(`${base.rootRel}/${entry.rel}`.replace(/^\.\//, ''), exclude)) continue;
      if (!re.test(entry.rel)) {
        // Also try the basename so `*.ts` works as people expect.
        const base2 = entry.rel.split('/').pop() ?? entry.rel;
        if (!re.test(base2)) continue;
      }
      if (matches.length >= GLOB_RESULT_CAP) {
        truncated = true;
        break;
      }
      matches.push(entry.rel);
    }
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would find files matching ${pattern} under ${base.rootRel}`,
      };
    }
    const notes: string[] = [];
    if (truncated) notes.push(`result list capped at ${GLOB_RESULT_CAP}`);
    if (walk.truncated) notes.push(`directory walk capped at 5000 entries — partial view`);
    const content = matches.length > 0 ? matches.join('\n') : `(no files match ${pattern})`;
    return {
      ok: true,
      summary: `${matches.length} file${matches.length === 1 ? '' : 's'} match ${pattern}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
      content: notes.length > 0 ? `${content}\n(${notes.join('; ')})` : content,
    };
  },
};

export const grepTool: Tool = {
  name: 'grep',
  description:
    'Search file CONTENTS line-by-line with a regular expression under a path ' +
    '(default: the project root), optionally filtered by a glob pattern ' +
    '(e.g. "*.ts"). Returns "path:line:text" matches, capped at 200. Files over ' +
    '256 KB and binary files are skipped (the skip count is reported).',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression to search for (as given)' },
      path: { type: 'string', description: 'Directory to search in (default: project root)' },
      glob: { type: 'string', description: 'Only search files matching this glob (e.g. *.ts)' },
    },
    required: ['pattern'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['pattern'] === 'string' ? r['pattern'] : '<invalid pattern>';
    return `grep(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('grep: input must be an object');
    if (!Object.hasOwn(r, 'pattern') || typeof r['pattern'] !== 'string' || r['pattern'] === '') {
      return badShape('grep: pattern must be a non-empty string');
    }
    const pattern = r['pattern'] as string;
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch (err) {
      return badShape(`grep: invalid regular expression: ${errText(err)}`);
    }
    if (Object.hasOwn(r, 'glob') && (typeof r['glob'] !== 'string' || r['glob'].trim() === '')) {
      return badShape('grep: glob must be a non-empty string when given');
    }
    const globPattern =
      Object.hasOwn(r, 'glob') && typeof r['glob'] === 'string'
        ? (r['glob'] as string).trim()
        : undefined;
    const globRe = globPattern !== undefined ? globToRegExp(globPattern) : undefined;
    const base = resolveSearchPath(ctx.cwd, Object.hasOwn(r, 'path') ? r['path'] : undefined);
    if ('error' in base) return badShape(`grep: ${base.error}`);
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would grep for /${pattern}/ under ${base.rootRel}${globPattern !== undefined ? ` (files matching ${globPattern})` : ''}`,
      };
    }
    const exclude = effectiveExcludeGlobs(ctx.cwd);
    const walk = await walkTree({ root: base.abs, exclude });
    const matches: string[] = [];
    let filesSearched = 0;
    let skippedLarge = 0;
    let skippedBinary = 0;
    let capped = false;

    for (const entry of walk.entries) {
      if (capped) break;
      if (entry.isFile !== true) continue;
      if (isExcludedRel(`${base.rootRel}/${entry.rel}`.replace(/^\.\//, ''), exclude)) continue;
      const display = base.rootRel === '.' ? entry.rel : `${base.rootRel}/${entry.rel}`;
      const st = statPath(entry.abs);
      if (st === null || !st.isFile) continue;
      if (st.size > MAX_TOOL_FILE_BYTES) {
        skippedLarge += 1;
        continue;
      }
      if (
        globRe !== undefined &&
        !globRe.test(entry.rel) &&
        !globRe.test(entry.rel.split('/').pop() ?? '')
      ) {
        continue;
      }
      let text: string;
      try {
        text = await readFile(entry.abs, 'utf8');
      } catch {
        continue; // unreadable file — skipped, never crash
      }
      if (text.includes('\0')) {
        skippedBinary += 1;
        continue;
      }
      filesSearched += 1;
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        if (re.test(lines[i]!)) {
          if (matches.length >= GREP_MATCH_CAP) {
            capped = true;
            break;
          }
          const lineText =
            lines[i]!.length > GREP_LINE_CAP ? `${lines[i]!.slice(0, GREP_LINE_CAP)}…` : lines[i]!;
          matches.push(`${display}:${i + 1}:${lineText}`);
        }
      }
    }

    const notes: string[] = [];
    if (capped) notes.push(`matches capped at ${GREP_MATCH_CAP}`);
    if (skippedLarge > 0)
      notes.push(`${skippedLarge} file${skippedLarge === 1 ? '' : 's'} over 256 KB skipped`);
    if (skippedBinary > 0)
      notes.push(`${skippedBinary} binary file${skippedBinary === 1 ? '' : 's'} skipped`);
    if (walk.truncated) notes.push('directory walk capped at 5000 entries — partial view');
    const content = matches.length > 0 ? matches.join('\n') : `(no matches for /${pattern}/)`;
    return {
      ok: true,
      summary: `${matches.length} match${matches.length === 1 ? '' : 'es'} in ${filesSearched} file${filesSearched === 1 ? '' : 's'}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
      content: notes.length > 0 ? `${content}\n(${notes.join('; ')})` : content,
    };
  },
};

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
