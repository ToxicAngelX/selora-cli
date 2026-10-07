/**
 * File tools: read_file, write_file, edit_file. v0.3 paths resolve through
 * agent/userPaths.ts — `~`, env vars, and the desktop/downloads/documents
 * aliases expand, and a path OUTSIDE the project root is no longer a hard
 * refusal: the dry run reports it as `outside` so the permission gate can ask
 * the user (showing the absolute path); the real run executes only when the
 * resolved path sits inside a session-granted directory. Inside-root paths
 * keep the full v0.2 sandbox (symlink realpath re-checks) and the project's
 * context.exclude globs; the 256 KB caps apply everywhere.
 *
 * Input is untrusted model JSON: every field is checked with Object.hasOwn
 * before use; a bad shape is an honest {ok:false} result that goes back to
 * the model, never a crash. edit_file (v0.3) requires the find string to
 * match UNIQUELY — an ambiguous edit is refused with the occurrence count —
 * and both its dry run and its result carry before/after for a colored diff.
 *
 * v1.3 (diff system):
 *  - edit_file gains `replace_all` (change every occurrence — the uniqueness
 *    rule is lifted deliberately) and its refusals got precise: not-found
 *    shows the closest-looking line with its number; ambiguous lists the
 *    occurrence line numbers.
 *  - every diff payload carries `path` and `kind` ('created' | 'modified' |
 *    'deleted') so the diff renderer can title/highlight correctly and the
 *    session history can checkpoint honestly.
 *  - write_file dry runs (and real runs) now carry the diff too: creates
 *    diff against '' and overwrites against the old content (read back only
 *    when the existing file is within the tool size cap).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool, ToolResult } from '../tool.js';
import { effectiveExcludeGlobs, isExcludedRel, MAX_TOOL_FILE_BYTES, statPath } from '../paths.js';
import { isInsideAny, resolveUserPath } from '../userPaths.js';

const READ_DEFAULT_LINES = 200;
const READ_MAX_LINES = 10_000;
/** Preview display cap — the permission prompt never floods the terminal. */
const PREVIEW_CAP = 16 * 1024;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

/**
 * Resolve a tool input path for this context. Three outcomes:
 *  - 'error'      — refused before anything happens (bad shape, NUL, …)
 *  - 'outside'    — outside the project root AND not granted this session;
 *                   dry runs report it (permission gate asks), real runs fail
 *  - 'resolved'   — inside the root (rel present) or an granted outside dir
 */
type PathOutcome =
  | { kind: 'error'; error: string }
  | { kind: 'outside'; abs: string; display: string }
  | { kind: 'resolved'; abs: string; display: string; rel: string };

function resolveForTool(
  ctx: { cwd: string; outsideDirs?: readonly string[] },
  input: unknown,
): PathOutcome {
  const res = resolveUserPath(ctx.cwd, input);
  if (!res.ok) return { kind: 'error', error: res.error };
  if (res.inside) return { kind: 'resolved', abs: res.abs, display: res.rel, rel: res.rel };
  if (isInsideAny(ctx.outsideDirs ?? [], res.abs)) {
    return { kind: 'resolved', abs: res.abs, display: res.abs, rel: res.abs };
  }
  return { kind: 'outside', abs: res.abs, display: res.abs };
}

/** The outside-pending dry-run/real-run result pair every file tool shares. */
function outsideResults(tool: string, display: string, abs: string, dryRun: boolean): ToolResult {
  if (dryRun) {
    return {
      ok: true,
      summary: `would use ${display} — outside the project root`,
      preview: `path outside the project root (needs your approval):\n${abs}`,
      outside: { abs },
    };
  }
  return badShape(`${tool}: ${abs} is outside the project root and access was not granted`);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function capPreview(text: string): string {
  if (text.length <= PREVIEW_CAP) return text;
  return `${text.slice(0, PREVIEW_CAP)}\n(… preview truncated — ${formatBytes(text.length)} total)`;
}

export const readFileTool: Tool = {
  name: 'read_file',
  description:
    'Read a text file. Returns lines starting at start_line (default 1), ' +
    `${READ_DEFAULT_LINES} lines by default (max ${READ_MAX_LINES} via max_lines). ` +
    'Paths may use ~, env vars ($HOME), or the aliases desktop/downloads/documents; ' +
    'paths outside the project root need user approval. Files over 256 KB are refused ' +
    '(their size is reported).',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (project-relative, ~, or an alias like desktop)',
      },
      start_line: {
        type: 'integer',
        description: `First line to return, 1-based (1-${READ_MAX_LINES}, default 1)`,
      },
      max_lines: {
        type: 'integer',
        description: `How many lines to return (1-${READ_MAX_LINES}, default ${READ_DEFAULT_LINES})`,
      },
    },
    required: ['path'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['path'] === 'string' ? r['path'] : '<invalid path>';
    return `read_file(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('read_file: input must be an object');
    if (!Object.hasOwn(r, 'path')) return badShape('read_file: missing required field "path"');
    let startLine = 1;
    if (Object.hasOwn(r, 'start_line')) {
      const v = r['start_line'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > READ_MAX_LINES) {
        return badShape(`read_file: start_line must be an integer between 1 and ${READ_MAX_LINES}`);
      }
      startLine = v;
    }
    let maxLines = READ_DEFAULT_LINES;
    if (Object.hasOwn(r, 'max_lines')) {
      const v = r['max_lines'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > READ_MAX_LINES) {
        return badShape(`read_file: max_lines must be an integer between 1 and ${READ_MAX_LINES}`);
      }
      maxLines = v;
    }
    const p = resolveForTool(ctx, r['path']);
    if (p.kind === 'error') return badShape(`read_file: ${p.error}`);
    if (p.kind === 'outside') return outsideResults('read_file', p.display, p.abs, ctx.dryRun);
    const exclude = effectiveExcludeGlobs(ctx.cwd);
    if (p.rel !== p.abs && isExcludedRel(p.rel, exclude)) {
      return badShape(`read_file: ${p.rel} is excluded by the project context globs`);
    }
    const st = statPath(p.abs);
    if (st === null) return badShape(`read_file: no such file: ${p.display}`);
    if (!st.isFile) return badShape(`read_file: not a file: ${p.display}`);
    if (st.size > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `read_file: ${p.display} is ${formatBytes(st.size)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool file limit`,
      );
    }
    let text: string;
    try {
      text = readFileSync(p.abs, 'utf8');
    } catch (err) {
      return badShape(`read_file: cannot read ${p.display}: ${errText(err)}`);
    }
    const lines = text.split('\n');
    // A trailing newline yields a final empty element — it is not a line.
    const realLines = text.endsWith('\n') ? lines.length - 1 : lines.length;
    if (startLine > realLines) {
      return badShape(
        `read_file: ${p.display} has ${realLines} line${realLines === 1 ? '' : 's'} — start_line ${startLine} is past the end`,
      );
    }
    const from = startLine - 1;
    const shown = lines.slice(from, from + maxLines);
    const truncated = realLines - from > maxLines;
    const body =
      shown.join('\n') +
      (truncated
        ? `\n(… ${realLines - from - maxLines} more lines — pass max_lines to read more)`
        : '');
    // The default read keeps the v0.2 summary shape (tests + muscle memory);
    // a ranged read says the range.
    const range =
      startLine === 1
        ? `${realLines} line${realLines === 1 ? '' : 's'}`
        : `lines ${startLine}-${startLine + shown.length - 1} of ${realLines}`;
    return {
      ok: true,
      summary: `read ${p.display} (${range}, ${formatBytes(st.size)}${truncated ? ', truncated' : ''})`,
      content: body,
    };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write a file, creating parent directories (works for new files and full ' +
    'overwrites). The permission prompt shows the exact content before ' +
    'anything is written. Paths may use ~, env vars, or the aliases ' +
    'desktop/downloads/documents; paths outside the project root need user approval.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (project-relative, ~, or an alias like desktop)',
      },
      content: { type: 'string', description: 'The full file content to write' },
    },
    required: ['path', 'content'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['path'] === 'string' ? r['path'] : '<invalid path>';
    return `write_file(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('write_file: input must be an object');
    if (!Object.hasOwn(r, 'path')) return badShape('write_file: missing required field "path"');
    if (typeof r['path'] !== 'string' || r['path'].trim() === '') {
      return badShape('write_file: path must be a non-empty string');
    }
    if (!Object.hasOwn(r, 'content'))
      return badShape('write_file: missing required field "content"');
    if (typeof r['content'] !== 'string') {
      return badShape('write_file: content must be a string');
    }
    const content = r['content'] as string;
    if (content.length > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `write_file: content is ${formatBytes(content.length)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool limit`,
      );
    }
    const p = resolveForTool(ctx, r['path']);
    if (p.kind === 'error') return badShape(`write_file: ${p.error}`);
    if (p.kind === 'outside') return outsideResults('write_file', p.display, p.abs, ctx.dryRun);
    const existing = statPath(p.abs);
    const existed = existing !== null;
    // The diff payload (v1.3): creates diff against '', overwrites against the
    // old content — read back only within the tool size cap (a bigger existing
    // file still gets the plain preview; never blow memory for a display).
    let before: string | undefined;
    if (existed && existing.size <= MAX_TOOL_FILE_BYTES) {
      try {
        before = readFileSync(p.abs, 'utf8');
      } catch {
        before = undefined; // unreadable — the write itself will surface the error
      }
    }
    const diff =
      before !== undefined || !existed
        ? {
            before: before ?? '',
            after: content,
            path: p.display,
            kind: existed ? ('modified' as const) : ('created' as const),
          }
        : undefined;
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would ${existed ? 'overwrite' : 'write'} ${p.display} (${formatBytes(content.length)})`,
        preview: `${existed ? 'overwrite' : 'write'} ${p.display} — full content:\n${capPreview(content)}`,
        ...(diff !== undefined ? { diff } : {}),
      };
    }
    try {
      mkdirSync(dirname(p.abs), { recursive: true });
      writeFileSync(p.abs, content, 'utf8');
    } catch (err) {
      return badShape(`write_file: cannot write ${p.display}: ${errText(err)}`);
    }
    return {
      ok: true,
      summary: `${existed ? 'overwrote' : 'wrote'} ${p.display} (${formatBytes(content.length)})`,
      ...(diff !== undefined ? { diff } : {}),
    };
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file by replacing a find string with a replacement. The find ' +
    'string must match EXACTLY ONCE in the file — an ambiguous match is ' +
    'refused with the occurrence line numbers (include more surrounding lines ' +
    'to make it unique), and a not-found refusal shows the closest-looking ' +
    'line. Pass replace_all: true to change EVERY occurrence deliberately. ' +
    'The permission prompt shows the change as a diff with context. Paths ' +
    'may use ~, env vars, or the desktop/downloads/documents aliases; paths ' +
    'outside the project root need user approval.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path (project-relative, ~, or an alias like desktop)',
      },
      find: { type: 'string', description: 'The exact text to find (must be unique in the file)' },
      replace: { type: 'string', description: 'The replacement text' },
      replace_all: {
        type: 'boolean',
        description: 'Replace EVERY occurrence of find (default false — find must be unique)',
      },
    },
    required: ['path', 'find', 'replace'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['path'] === 'string' ? r['path'] : '<invalid path>';
    return `edit_file(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('edit_file: input must be an object');
    if (!Object.hasOwn(r, 'path')) return badShape('edit_file: missing required field "path"');
    if (typeof r['path'] !== 'string' || r['path'].trim() === '') {
      return badShape('edit_file: path must be a non-empty string');
    }
    for (const field of ['find', 'replace'] as const) {
      if (!Object.hasOwn(r, field)) return badShape(`edit_file: missing required field "${field}"`);
      if (typeof r[field] !== 'string') {
        return badShape(`edit_file: ${field} must be a string`);
      }
    }
    const find = r['find'] as string;
    if (find === '') return badShape('edit_file: find must not be empty');
    const replace = r['replace'] as string;
    let replaceAll = false;
    if (Object.hasOwn(r, 'replace_all')) {
      if (typeof r['replace_all'] !== 'boolean') {
        return badShape('edit_file: replace_all must be a boolean');
      }
      replaceAll = r['replace_all'];
    }
    const p = resolveForTool(ctx, r['path']);
    if (p.kind === 'error') return badShape(`edit_file: ${p.error}`);
    if (p.kind === 'outside') return outsideResults('edit_file', p.display, p.abs, ctx.dryRun);
    const exclude = effectiveExcludeGlobs(ctx.cwd);
    if (p.rel !== p.abs && isExcludedRel(p.rel, exclude)) {
      return badShape(`edit_file: ${p.rel} is excluded by the project context globs`);
    }
    const st = statPath(p.abs);
    if (st === null) return badShape(`edit_file: no such file: ${p.display}`);
    if (!st.isFile) return badShape(`edit_file: not a file: ${p.display}`);
    if (st.size > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `edit_file: ${p.display} is ${formatBytes(st.size)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool file limit`,
      );
    }
    let text: string;
    try {
      text = readFileSync(p.abs, 'utf8');
    } catch (err) {
      return badShape(`edit_file: cannot read ${p.display}: ${errText(err)}`);
    }
    // Occurrence contract (v1.3): exactly-once, or every-occurrence with
    // replace_all. Refusals are precise — a not-found shows the closest line,
    // an ambiguous match lists the occurrence line numbers.
    const occurrences: number[] = [];
    for (let at = text.indexOf(find); at >= 0; at = text.indexOf(find, at + find.length)) {
      occurrences.push(at);
    }
    if (occurrences.length === 0) {
      return badShape(
        `edit_file: find text not found in ${p.display} (file has ${text.split('\n').length} lines)${closestLineHint(text, find)}`,
      );
    }
    if (occurrences.length > 1 && !replaceAll) {
      const lines = occurrences.map((at) => lineNumberAt(text, at));
      const shown = lines.slice(0, 5).join(', ');
      const more = lines.length > 5 ? `, …` : '';
      return badShape(
        `edit_file: find text matches ${occurrences.length} times in ${p.display} (lines ${shown}${more}) — include more context so it matches exactly once, or pass replace_all: true to change all of them`,
      );
    }
    const next = replaceAll
      ? text.split(find).join(replace)
      : replaceOnce(text, occurrences[0]!, find, replace);
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would replace ${occurrences.length} occurrence${occurrences.length === 1 ? '' : 's'} in ${p.display}`,
        preview: editPreview(text, occurrences[0]!, find, replace),
        diff: { before: text, after: next, path: p.display, kind: 'modified' },
      };
    }
    try {
      writeFileSync(p.abs, next, 'utf8');
    } catch (err) {
      return badShape(`edit_file: cannot write ${p.display}: ${errText(err)}`);
    }
    return {
      ok: true,
      summary: `edited ${p.display}: replaced ${occurrences.length} occurrence${occurrences.length === 1 ? '' : 's'} (${find.length} → ${replace.length} chars)`,
      diff: { before: text, after: next, path: p.display, kind: 'modified' },
    };
  },
};

function replaceOnce(text: string, at: number, find: string, replace: string): string {
  return text.slice(0, at) + replace + text.slice(at + find.length);
}

/** 1-based line number containing byte-offset `at` (JS string offset). */
function lineNumberAt(text: string, at: number): number {
  let line = 1;
  for (let i = 0; i < at; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * The not-found hint: score every file line by how many of the find's first
 * non-empty line's whitespace-separated tokens it contains, and report the
 * best line (number + content, trimmed, ≤80 chars) when at least half its
 * tokens (min 2) match — the model sees the near miss instead of guessing.
 */
function closestLineHint(text: string, find: string): string {
  const needle = find.split('\n').find((l) => l.trim() !== '');
  if (needle === undefined) return '';
  const tokens = needle.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return '';
  const threshold = Math.max(2, Math.ceil(tokens.length / 2));
  let bestLine = -1;
  let bestScore = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    let score = 0;
    for (const tok of tokens) {
      if (lines[i]!.includes(tok)) score += 1;
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  if (bestLine === -1 || bestScore < threshold) return '';
  const shown = lines[bestLine]!.trim();
  return ` — closest match at line ${bestLine + 1}: ${shown.length > 80 ? `${shown.slice(0, 79)}…` : shown}`;
}

/** find/replace with 2 lines of context on each side, for the prompt preview. */
function editPreview(text: string, at: number, find: string, replace: string): string {
  const before = text.slice(0, at);
  const lineNo = before.split('\n').length; // 1-based line containing the match
  const lines = text.split('\n');
  const context = lines
    .slice(Math.max(0, lineNo - 3), lineNo + 3) // 2 lines before, the match line, 2 after
    .join('\n');
  return `edit line ${Math.min(lineNo, lines.length)} — replace:\n${capPreview(find)}\nwith:\n${capPreview(replace)}\ncontext (2 lines each side):\n${capPreview(context)}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
