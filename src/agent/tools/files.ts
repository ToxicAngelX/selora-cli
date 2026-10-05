/**
 * File tools: read_file, write_file, edit_file. All paths go through the
 * sandbox (agent/paths.ts) — root containment, symlink re-check, 256 KB read
 * cap, exclude globs. Input is untrusted model JSON: every field is checked
 * with Object.hasOwn before use; a bad shape is an honest {ok:false} result
 * that goes back to the model, never a crash.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool, ToolResult } from '../tool.js';
import {
  effectiveExcludeGlobs,
  isExcludedRel,
  MAX_TOOL_FILE_BYTES,
  resolveToolPath,
  statPath,
} from '../paths.js';

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
    'Read a text file from the project. Returns the first lines by default ' +
    `(default ${READ_DEFAULT_LINES}, max ${READ_MAX_LINES} via max_lines). ` +
    'Files over 256 KB are refused (their size is reported).',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root' },
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
    let maxLines = READ_DEFAULT_LINES;
    if (Object.hasOwn(r, 'max_lines')) {
      const v = r['max_lines'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > READ_MAX_LINES) {
        return badShape(`read_file: max_lines must be an integer between 1 and ${READ_MAX_LINES}`);
      }
      maxLines = v;
    }
    const resolved = resolveToolPath(ctx.cwd, r['path']);
    if (!resolved.ok) return badShape(`read_file: ${resolved.error}`);
    const exclude = effectiveExcludeGlobs(ctx.cwd);
    if (isExcludedRel(resolved.rel, exclude)) {
      return badShape(`read_file: ${resolved.rel} is excluded by the project context globs`);
    }
    const st = statPath(resolved.abs);
    if (st === null) return badShape(`read_file: no such file: ${resolved.rel}`);
    if (!st.isFile) return badShape(`read_file: not a file: ${resolved.rel}`);
    if (st.size > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `read_file: ${resolved.rel} is ${formatBytes(st.size)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool file limit`,
      );
    }
    let text: string;
    try {
      text = readFileSync(resolved.abs, 'utf8');
    } catch (err) {
      return badShape(`read_file: cannot read ${resolved.rel}: ${errText(err)}`);
    }
    const lines = text.split('\n');
    // A trailing newline yields a final empty element — it is not a line.
    const realLines = text.endsWith('\n') ? lines.length - 1 : lines.length;
    const shown = lines.slice(0, maxLines);
    const truncated = realLines > maxLines;
    const body =
      shown.join('\n') + (truncated ? `\n(… ${realLines - maxLines} more lines — pass max_lines to read more)` : '');
    return {
      ok: true,
      summary: `read ${resolved.rel} (${realLines} line${realLines === 1 ? '' : 's'}, ${formatBytes(st.size)}${truncated ? ', truncated' : ''})`,
      content: body,
    };
  },
};

export const writeFileTool: Tool = {
  name: 'write_file',
  description:
    'Write a file (creates parent directories). The permission prompt shows ' +
    'the exact content before anything is written. Overwrites an existing file.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root' },
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
    if (!Object.hasOwn(r, 'content')) return badShape('write_file: missing required field "content"');
    if (typeof r['content'] !== 'string') {
      return badShape('write_file: content must be a string');
    }
    const content = r['content'] as string;
    const resolved = resolveToolPath(ctx.cwd, r['path']);
    if (!resolved.ok) return badShape(`write_file: ${resolved.error}`);
    if (content.length > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `write_file: content is ${formatBytes(content.length)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool limit`,
      );
    }
    const existed = statPath(resolved.abs) !== null;
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would ${existed ? 'overwrite' : 'write'} ${resolved.rel} (${formatBytes(content.length)})`,
        preview: `${existed ? 'overwrite' : 'write'} ${resolved.rel} — full content:\n${capPreview(content)}`,
      };
    }
    try {
      mkdirSync(dirname(resolved.abs), { recursive: true });
      writeFileSync(resolved.abs, content, 'utf8');
    } catch (err) {
      return badShape(`write_file: cannot write ${resolved.rel}: ${errText(err)}`);
    }
    return {
      ok: true,
      summary: `${existed ? 'overwrote' : 'wrote'} ${resolved.rel} (${formatBytes(content.length)})`,
    };
  },
};

export const editFileTool: Tool = {
  name: 'edit_file',
  description:
    'Edit a file by replacing the FIRST occurrence of a find string with a ' +
    'replacement. The permission prompt shows the change with surrounding context.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path, relative to the project root' },
      find: { type: 'string', description: 'The exact text to find (first occurrence)' },
      replace: { type: 'string', description: 'The replacement text' },
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
    const resolved = resolveToolPath(ctx.cwd, r['path']);
    if (!resolved.ok) return badShape(`edit_file: ${resolved.error}`);
    const st = statPath(resolved.abs);
    if (st === null) return badShape(`edit_file: no such file: ${resolved.rel}`);
    if (!st.isFile) return badShape(`edit_file: not a file: ${resolved.rel}`);
    if (st.size > MAX_TOOL_FILE_BYTES) {
      return badShape(
        `edit_file: ${resolved.rel} is ${formatBytes(st.size)} — over the ${formatBytes(MAX_TOOL_FILE_BYTES)} tool file limit`,
      );
    }
    let text: string;
    try {
      text = readFileSync(resolved.abs, 'utf8');
    } catch (err) {
      return badShape(`edit_file: cannot read ${resolved.rel}: ${errText(err)}`);
    }
    const at = text.indexOf(find);
    if (at < 0) {
      const lineCount = text.split('\n').length;
      return badShape(
        `edit_file: find text not found in ${resolved.rel} (file has ${lineCount} lines)`,
      );
    }
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would replace 1 occurrence in ${resolved.rel}`,
        preview: editPreview(text, at, find, replace),
      };
    }
    const next = text.slice(0, at) + replace + text.slice(at + find.length);
    try {
      writeFileSync(resolved.abs, next, 'utf8');
    } catch (err) {
      return badShape(`edit_file: cannot write ${resolved.rel}: ${errText(err)}`);
    }
    return {
      ok: true,
      summary: `edited ${resolved.rel}: replaced 1 occurrence (${find.length} → ${replace.length} chars)`,
    };
  },
};

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
