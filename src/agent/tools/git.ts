/**
 * Git tools — every git invocation goes through spawn("git", args,
 * {shell:false}) with an explicit args array; a commit message is always an
 * argv element, never shell text. The tool set exposes exactly:
 * status / diff / log (read) and commit (stages listed files, then commits)
 * / restore (write). There is deliberately NO tool that can push, pull,
 * fetch, or touch remotes — no flag, no escape hatch; network git operations
 * stay with the human.
 */

import { spawnSync } from 'node:child_process';
import type { Tool, ToolResult } from '../tool.js';

const GIT_OUTPUT_CAP = 64 * 1024;

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

interface GitRun {
  code: number;
  out: string;
  errOut: string;
}

function runGit(args: string[], cwd: string): GitRun {
  try {
    const res = spawnSync('git', args, {
      cwd,
      shell: false,
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
    });
    if (res.error !== undefined) {
      return { code: -1, out: '', errOut: String(res.error.message) };
    }
    return { code: res.status ?? -1, out: res.stdout ?? '', errOut: res.stderr ?? '' };
  } catch (err) {
    return { code: -1, out: '', errOut: errText(err) };
  }
}

function capGit(text: string): { text: string; truncated: boolean } {
  if (text.length <= GIT_OUTPUT_CAP) return { text, truncated: false };
  return { text: text.slice(0, GIT_OUTPUT_CAP), truncated: true };
}

function gitFailed(op: string, run: GitRun): ToolResult {
  const detail = run.errOut.trim() !== '' ? run.errOut.trim() : `exit code ${run.code}`;
  return { ok: false, summary: `git ${op} failed: ${detail}` };
}

/** Optional string field: present-and-string, else undefined (never invented). */
function optString(r: Record<string, unknown>, key: string): string | undefined {
  if (!Object.hasOwn(r, key)) return undefined;
  const v = r[key];
  return typeof v === 'string' ? v : undefined;
}

export const gitStatusTool: Tool = {
  name: 'git_status',
  description: 'Show the working tree status (git status --short --branch).',
  kind: 'read',
  parameters: { type: 'object', properties: {} },
  permissionLabel: () => 'git_status()',
  run: async (_input, ctx) => {
    if (ctx.dryRun) return { ok: true, summary: 'would run: git status --short --branch' };
    const run = runGit(['status', '--short', '--branch'], ctx.cwd);
    if (run.code !== 0) return gitFailed('status', run);
    const lines = run.out.split('\n').filter((l) => l.trim() !== '');
    const changed = lines.filter((l) => !l.startsWith('##')).length;
    return {
      ok: true,
      summary: `git status: ${changed} changed path${changed === 1 ? '' : 's'}`,
      content: run.out.trim() !== '' ? run.out.trimEnd() : '(clean working tree)',
    };
  },
};

export const gitDiffTool: Tool = {
  name: 'git_diff',
  description:
    'Show unstaged changes (git diff), or staged changes with staged: true. ' +
    'Optionally limited to one path.',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Limit the diff to this path' },
      staged: { type: 'boolean', description: 'Show staged (cached) changes instead' },
    },
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const path = optString(r ?? {}, 'path');
    return `git_diff(${path ?? (r !== null && r['staged'] === true ? 'staged' : 'unstaged')})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('git_diff: input must be an object');
    const staged = Object.hasOwn(r, 'staged') && r['staged'] === true;
    const path = optString(r, 'path');
    if (Object.hasOwn(r, 'path') && path === undefined) {
      return badShape('git_diff: path must be a string when given');
    }
    const args = ['diff'];
    if (staged) args.push('--cached');
    if (path !== undefined) args.push('--', path);
    if (ctx.dryRun) {
      return { ok: true, summary: `would run: git ${args.join(' ')}` };
    }
    const run = runGit(args, ctx.cwd);
    if (run.code !== 0) return gitFailed('diff', run);
    const capped = capGit(run.out);
    const lines = run.out.trim() !== '' ? run.out.trimEnd().split('\n').length : 0;
    return {
      ok: true,
      summary: `git diff: ${lines} line${lines === 1 ? '' : 's'}${staged ? ' (staged)' : ''}${capped.truncated ? ' (output truncated at 64 KB)' : ''}`,
      content: run.out.trim() !== '' ? capped.text : '(no changes)',
    };
  },
};

export const gitLogTool: Tool = {
  name: 'git_log',
  description: 'Show recent commits (git log --oneline), most recent first.',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'integer', description: 'How many commits to show (1-100, default 10)' },
    },
  },
  permissionLabel: () => 'git_log()',
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('git_log: input must be an object');
    let limit = 10;
    if (Object.hasOwn(r, 'limit')) {
      const v = r['limit'];
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 100) {
        return badShape('git_log: limit must be an integer between 1 and 100');
      }
      limit = v;
    }
    if (ctx.dryRun) return { ok: true, summary: `would run: git log --oneline -n ${limit}` };
    const run = runGit(['log', '--oneline', '-n', String(limit)], ctx.cwd);
    if (run.code !== 0) return gitFailed('log', run);
    const lines = run.out.trim() !== '' ? run.out.trimEnd().split('\n').length : 0;
    return {
      ok: true,
      summary: `git log: ${lines} commit${lines === 1 ? '' : 's'}`,
      content: run.out.trim() !== '' ? run.out.trimEnd() : '(no commits)',
    };
  },
};

export const gitCommitTool: Tool = {
  name: 'git_commit',
  description:
    'Stage the listed files (git add -- <paths>) and commit them with a ' +
    'message (git commit -m <message> — the message is an argument, never ' +
    'shell text). With no files, commits what is already staged. The ' +
    'permission prompt shows the exact message and file list first.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'The commit message' },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Paths to stage before committing (default: what is already staged)',
      },
    },
    required: ['message'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const msg = optString(r ?? {}, 'message');
    return `git_commit(${msg !== undefined ? `${msg.slice(0, 60)}${msg.length > 60 ? '…' : ''}` : '<invalid message>'})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('git_commit: input must be an object');
    if (
      !Object.hasOwn(r, 'message') ||
      typeof r['message'] !== 'string' ||
      r['message'].trim() === ''
    ) {
      return badShape('git_commit: message must be a non-empty string');
    }
    const message = (r['message'] as string).trim();
    let files: string[] | undefined;
    if (Object.hasOwn(r, 'files')) {
      const v = r['files'];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && x.trim() !== '')) {
        return badShape('git_commit: files must be an array of non-empty path strings');
      }
      files = v as string[];
    }
    if (ctx.dryRun) {
      const list = files !== undefined ? files.join(', ') : 'none — commits what is already staged';
      return {
        ok: true,
        summary: `would commit: "${message}"`,
        preview: `commit message:\n${message}\nfiles to stage: ${list}`,
      };
    }
    if (files !== undefined) {
      const add = runGit(['add', '--', ...files], ctx.cwd);
      if (add.code !== 0) return gitFailed('add', add);
    }
    const commit = runGit(['commit', '-m', message], ctx.cwd);
    if (commit.code !== 0) return gitFailed('commit', commit);
    return {
      ok: true,
      summary: `committed: ${firstLine(commit.out) || message}`,
      content: commit.out.trim() !== '' ? commit.out.trim() : `Committed: ${message}`,
    };
  },
};

export const gitRestoreTool: Tool = {
  name: 'git_restore',
  description:
    'Discard uncommitted changes to a path (git checkout -- <path>). The ' +
    'permission prompt names the exact path; there is no way to restore a ' +
    'whole-tree wildcard.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'The path whose changes are discarded' },
    },
    required: ['path'],
  },
  permissionLabel: (input) => {
    const r = rec(input);
    const p = r !== null && typeof r['path'] === 'string' ? r['path'] : '<invalid path>';
    return `git_restore(${p})`;
  },
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('git_restore: input must be an object');
    if (!Object.hasOwn(r, 'path') || typeof r['path'] !== 'string' || r['path'].trim() === '') {
      return badShape('git_restore: path must be a non-empty string');
    }
    const path = (r['path'] as string).trim();
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would discard changes to ${path}`,
        preview: `git checkout -- ${path}\n(discards uncommitted changes to this path)`,
      };
    }
    const run = runGit(['checkout', '--', path], ctx.cwd);
    if (run.code !== 0) return gitFailed('checkout', run);
    return { ok: true, summary: `restored ${path} (uncommitted changes discarded)` };
  },
};

function firstLine(s: string): string {
  const line = s.split('\n').find((l) => l.trim() !== '') ?? '';
  return line.trim();
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
