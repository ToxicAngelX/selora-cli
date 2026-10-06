/**
 * Filesystem management tools (v0.3): list_dir, create_dir, move, copy,
 * remove — the whole-machine companions to the project-sandbox file tools
 * in files.ts. Every path resolves through resolveUserPath
 * (agent/userPaths.ts): an inside-root path behaves exactly like the v0.2
 * sandbox, an outside-root path either matches a session-granted directory
 * (ctx.outsideDirs) or is surfaced to the permission gate as `outside`
 * (dry run) / refused with an honest error (real run) — the pattern every
 * tool here follows verbatim.
 *
 * Design decisions worth writing down:
 *  - removeGuard guards ALL write targets in this module, not only remove:
 *    the spec asked for remove, and extending it to create_dir / move / copy
 *    destinations is deliberate — a model that may not delete C:\Windows
 *    must not be able to move a directory onto it either. The guard refuses
 *    drive roots, the home directory ITSELF (paths inside home are fine),
 *    and the platform system folders. Platform is injectable so POSIX tests
 *    simulate win32 exactly.
 *  - remove is neverAutoAllow: one approval must never blanket the next
 *    destructive call.
 *  - remove's guard runs BEFORE the dry-run preview, so a guarded path
 *    fails without ever prompting — no dry run can claim a guarded success.
 *  - Trash is node:fs only (no new dependencies): XDG Trash with a
 *    .trashinfo file on Linux, ~/.Trash on macOS, and on win32 a plain
 *    permanent delete — there is no shell-free Windows recycle bin, and the
 *    preview and result say so plainly instead of pretending one was used.
 *  - create_dir is idempotent like mkdir -p (an existing directory is an
 *    ok "already exists"); a file in the way is an honest error.
 *  - move/copy targets never overwrite: an existing non-directory target
 *    (or an existing same-named entry inside an into-dir target) refuses
 *    instead of silently replacing. move falls back from renameSync to
 *    copy+remove on EXDEV so cross-filesystem moves still work.
 *  - Input is untrusted model JSON: every field is Object.hasOwn-checked
 *    before use, bad shapes are honest {ok:false} result strings, and
 *    nothing in this module throws.
 */

import {
  copyFileSync,
  cpSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '../tool.js';
import { isInsideAny, resolveUserPath } from '../userPaths.js';

/** Display cap for one list_dir result (… +N more carries the rest). */
const MAX_LIST_ENTRIES = 500;
/** Hard cap on entries read from one directory (the walk safety valve). */
const MAX_LIST_WALK = 5000;
/** folderStats walk cap — beyond this the totals are honest lower bounds. */
const MAX_STATS_ENTRIES = 20_000;
/** permissionLabel path cap (raw input, truncated with an ellipsis). */
const LABEL_CAP = 60;

const POSIX_SYSTEM_DIRS: readonly string[] = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/System',
  // macOS: /etc is a symlink into /private — paths arrive realpath-resolved,
  // so the guard must know the REAL destination too. (/private/var is
  // deliberately NOT listed: macOS keeps temp dirs under /private/var/folders,
  // and Linux's list guards /etc but not /var either.)
  '/private/etc',
];

const WIN_SYSTEM_DIRS: readonly string[] = [
  'C:\\Windows',
  'C:\\Program Files',
  'C:\\Program Files (x86)',
  'C:\\ProgramData',
  'C:\\System',
];

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

/** Byte formatter for the display lines and stats notes: B, then KB (1 decimal). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function pathExists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

interface LStat {
  isDir: boolean;
  isFile: boolean;
  size: number;
}

function lstatPath(abs: string): LStat | null {
  try {
    const st = lstatSync(abs);
    return { isDir: st.isDirectory(), isFile: st.isFile(), size: st.size };
  } catch {
    return null;
  }
}

function nameCmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** candidate is parent itself or somewhere below it (host separators). */
function isWithin(parent: string, candidate: string): boolean {
  if (candidate === parent) return true;
  return candidate.startsWith(parent + sep);
}

function labelPath(input: unknown, field: string): string {
  const r = rec(input);
  const v = r !== null ? r[field] : undefined;
  if (typeof v !== 'string' || v.trim() === '') return '<invalid path>';
  return v.length > LABEL_CAP ? `${v.slice(0, LABEL_CAP)}…` : v;
}

interface ResolvedPath {
  /** true when the path sits inside the project root. */
  inside: boolean;
  /** Realpath-resolved absolute path. */
  abs: string;
  /** '/'-separated root-relative path (inside only; '' for the root itself). */
  rel: string | undefined;
  /** What summaries show: rel inside the root, abs outside. */
  display: string;
}

type Target = { handled: ToolResult } | { target: ResolvedPath };

/**
 * Resolve one tool path through userPaths and apply the outside-access
 * pattern: ungranted outside access returns the `outside` dry-run result
 * (so the permission gate can ask) or an honest refusal on a real run.
 */
function resolveTarget(
  tool: string,
  ctx: ToolContext & { dryRun: boolean },
  input: unknown,
): Target {
  const res = resolveUserPath(ctx.cwd, input);
  if (!res.ok) return { handled: badShape(`${tool}: ${res.error}`) };
  const display = res.inside ? (res.rel === '' ? '.' : res.rel) : res.abs;
  if (!res.inside && !isInsideAny(ctx.outsideDirs ?? [], res.abs)) {
    if (ctx.dryRun) {
      return {
        handled: {
          ok: true,
          summary: `would access ${display} — outside the project root`,
          preview: `path outside the project root:\n${res.abs}`,
          outside: { abs: res.abs },
        },
      };
    }
    return {
      handled: badShape(
        `${tool}: ${res.abs} is outside the project root and access was not granted`,
      ),
    };
  }
  return {
    target: { inside: res.inside, abs: res.abs, rel: res.inside ? res.rel : undefined, display },
  };
}

/** Display form for <dir>/<name> (rel concat inside the root, join outside). */
function displayJoin(dir: ResolvedPath, name: string): string {
  if (!dir.inside) return join(dir.abs, name);
  return dir.rel === '' ? name : `${dir.rel}/${name}`;
}

// ---------------------------------------------------------------------------
// removeGuard — the shared write-target safety net
// ---------------------------------------------------------------------------

/** Normalize for comparison: win32 folds case and forward slashes. */
function normFor(p: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? p.replace(/\//g, '\\').toLowerCase() : p;
}

function sameOrBelow(abs: string, dir: string, platform: NodeJS.Platform): boolean {
  const a = normFor(abs, platform);
  const d = normFor(dir, platform);
  const s = platform === 'win32' ? '\\' : '/';
  return a === d || a.startsWith(d + s);
}

/** Segments after the leading \\ of a UNC path (\\server → 1, \\server\share → 2). */
function uncSegments(abs: string): number {
  return abs
    .slice(2)
    .split('\\')
    .filter((seg) => seg !== '').length;
}

/**
 * Refuse targets that must never be touched by a write tool: drive roots
 * ('/', 'C:\', 'D:', UNC roots), the home directory itself (deleting things
 * INSIDE home is allowed), and anything at or inside a platform system
 * folder. `home`/`platform` are injectable so tests simulate win32 on POSIX
 * hermetically. Never throws; every refusal is an explicit honest error.
 */
export function removeGuard(
  abs: string,
  opts?: { home?: string; platform?: NodeJS.Platform },
): { ok: true } | { ok: false; error: string } {
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? homedir();

  if (abs === '/' || abs === '\\') {
    return { ok: false, error: `refusing to operate on a filesystem root: ${abs}` };
  }
  if (platform === 'win32') {
    if (/^[a-zA-Z]:[\\/]?$/.test(abs)) {
      return { ok: false, error: `refusing to operate on a drive root: ${abs}` };
    }
    if (abs.startsWith('\\\\') && uncSegments(abs) <= 2) {
      return { ok: false, error: `refusing to operate on a UNC root: ${abs}` };
    }
  }

  if (home !== '' && normFor(abs, platform) === normFor(home, platform)) {
    return {
      ok: false,
      error: `refusing to operate on the home directory itself: ${abs} (paths inside it are fine)`,
    };
  }

  const systemDirs = platform === 'win32' ? WIN_SYSTEM_DIRS : POSIX_SYSTEM_DIRS;
  for (const dir of systemDirs) {
    if (sameOrBelow(abs, dir, platform)) {
      return { ok: false, error: `refusing to operate at or inside the system folder ${dir}` };
    }
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// folderStats + trash
// ---------------------------------------------------------------------------

export interface FolderStats {
  items: number;
  bytes: number;
  /** true when the 20,000-entry walk cap stopped the count — totals are lower bounds. */
  truncated: boolean;
}

/**
 * Count entries and file bytes under a directory (lstat-based, so symlinked
 * directories are never followed and cycles cannot loop). Unreadable
 * entries are skipped; hitting MAX_STATS_ENTRIES sets `truncated` so the
 * caller can say so honestly.
 */
export function folderStats(abs: string): FolderStats {
  let items = 0;
  let bytes = 0;
  let truncated = false;
  const stack: string[] = [abs];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (items >= MAX_STATS_ENTRIES) {
        truncated = true;
        return { items, bytes, truncated };
      }
      items += 1;
      const full = join(dir, e.name);
      const st = lstatPath(full);
      if (st === null) continue; // raced away between readdir and lstat
      if (st.isDir) stack.push(full);
      else bytes += st.size;
    }
  }
  return { items, bytes, truncated };
}

interface TrashLocation {
  base: string;
  /** Linux XDG trash keeps a parallel info/ tree with .trashinfo files. */
  needsInfo: boolean;
}

/**
 * The trash base for the REAL platform/env (deliberately not injectable:
 * trash always goes to the user's actual trash, never a test dir). win32
 * has no shell-free trash at all — null means "permanent delete only".
 */
function trashLocation(): TrashLocation | null {
  if (process.platform === 'win32') return null;
  if (process.platform === 'darwin') {
    return { base: join(homedir(), '.Trash'), needsInfo: false };
  }
  const xdg = process.env['XDG_DATA_HOME'];
  const base =
    xdg !== undefined && xdg !== '' && isAbsolute(xdg)
      ? join(xdg, 'Trash')
      : join(homedir(), '.local', 'share', 'Trash');
  return { base, needsInfo: true };
}

function uniqueTrashName(filesDir: string, name: string): string {
  let candidate = name;
  for (let i = 2; pathExists(join(filesDir, candidate)); i += 1) {
    candidate = `${name} ${i}`;
  }
  return candidate;
}

/**
 * Move abs into the user's trash (rename, with a copy+remove fallback when
 * the trash sits on another filesystem). Returns an honest error and
 * deletes NOTHING on failure.
 */
function moveToTrash(abs: string): { ok: true; note: string } | { ok: false; error: string } {
  const loc = trashLocation();
  if (loc === null) {
    // remove() routes win32 to the permanent branch before calling here;
    // this guard exists so the helper stays honest on its own.
    return { ok: false, error: 'no shell-free trash exists on Windows' };
  }
  const filesDir = join(loc.base, 'files');
  try {
    mkdirSync(filesDir, { recursive: true });
    if (loc.needsInfo) mkdirSync(join(loc.base, 'info'), { recursive: true });
  } catch (err) {
    return { ok: false, error: `cannot create the trash directory: ${errText(err)}` };
  }
  const name = basename(abs);
  const unique = uniqueTrashName(filesDir, name);
  const target = join(filesDir, unique);
  try {
    try {
      renameSync(abs, target);
    } catch (err) {
      if (!isErrnoException(err) || err.code !== 'EXDEV') throw err;
      cpSync(abs, target, { recursive: true });
      rmSync(abs, { recursive: true, force: true });
    }
    if (loc.needsInfo) {
      writeFileSync(
        join(loc.base, 'info', `${unique}.trashinfo`),
        `[Desktop Entry]\nPath=${abs}\nDeletionDate=${new Date().toISOString()}\n`,
        'utf8',
      );
    }
  } catch (err) {
    return { ok: false, error: `cannot move to trash: ${errText(err)}` };
  }
  return { ok: true, note: 'moved to trash' };
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

export const listDirTool: Tool = {
  name: 'list_dir',
  description:
    'List one directory level: subdirectories first (name/), then files ' +
    '(name (size)). Shows at most 500 entries with a count of the rest. ' +
    'Accepts ~, aliases, and absolute paths; paths outside the project ' +
    'root need session approval.',
  kind: 'read',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list (default: the project root)' },
    },
  },
  permissionLabel: (input) => `list_dir(${labelPath(input, 'path')})`,
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('list_dir: input must be an object');
    let p = '.';
    if (Object.hasOwn(r, 'path')) {
      if (typeof r['path'] !== 'string' || r['path'].trim() === '') {
        return badShape('list_dir: path must be a non-empty string');
      }
      p = r['path'];
    }
    const t = resolveTarget('list_dir', ctx, p);
    if ('handled' in t) return t.handled;

    const st = lstatPath(t.target.abs);
    if (st === null) return badShape(`list_dir: no such directory: ${t.target.display}`);
    if (!st.isDir) return badShape(`list_dir: not a directory: ${t.target.display}`);

    let entries: Dirent[];
    try {
      entries = readdirSync(t.target.abs, { withFileTypes: true });
    } catch (err) {
      return badShape(`list_dir: cannot read ${t.target.display}: ${errText(err)}`);
    }
    const total = entries.length;
    const shown = entries.slice(0, Math.min(MAX_LIST_ENTRIES, MAX_LIST_WALK));
    const dirs: string[] = [];
    const files: { name: string; line: string }[] = [];
    for (const e of shown) {
      if (e.isDirectory()) {
        dirs.push(e.name);
      } else {
        let line = e.name;
        if (e.isFile()) {
          const s = lstatPath(join(t.target.abs, e.name));
          line = s === null ? e.name : `${e.name} (${formatBytes(s.size)})`;
        }
        files.push({ name: e.name, line });
      }
    }
    dirs.sort(nameCmp);
    files.sort((a, b) => nameCmp(a.name, b.name));
    const lines = [...dirs.map((d) => `${d}/`), ...files.map((f) => f.line)];
    if (total > shown.length) lines.push(`… +${total - shown.length} more`);
    return {
      ok: true,
      summary: `listed ${total} entries in ${t.target.display}`,
      content: lines.length > 0 ? lines.join('\n') : '(empty directory)',
    };
  },
};

// ---------------------------------------------------------------------------
// create_dir
// ---------------------------------------------------------------------------

export const createDirTool: Tool = {
  name: 'create_dir',
  description:
    'Create a directory (recursive — missing parents are created, like ' +
    'mkdir -p). An existing directory is reported as such, not an error.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path to create' },
    },
    required: ['path'],
  },
  permissionLabel: (input) => `create_dir(${labelPath(input, 'path')})`,
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('create_dir: input must be an object');
    if (!Object.hasOwn(r, 'path')) return badShape('create_dir: missing required field "path"');
    if (typeof r['path'] !== 'string' || r['path'].trim() === '') {
      return badShape('create_dir: path must be a non-empty string');
    }
    const t = resolveTarget('create_dir', ctx, r['path']);
    if ('handled' in t) return t.handled;
    // write tools share removeGuard: no creating dirs over system folders
    const guard = removeGuard(t.target.abs);
    if (!guard.ok) return badShape(`create_dir: ${guard.error}`);

    const existing = lstatPath(t.target.abs);
    if (existing !== null) {
      if (existing.isDir) {
        return { ok: true, summary: `create_dir: ${t.target.display} already exists` };
      }
      return badShape(`create_dir: a file already exists at ${t.target.display}`);
    }
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would create directory ${t.target.display}`,
        preview: `${t.target.abs}\nrecursive — missing parent directories are created`,
      };
    }
    try {
      mkdirSync(t.target.abs, { recursive: true });
    } catch (err) {
      return badShape(`create_dir: cannot create ${t.target.display}: ${errText(err)}`);
    }
    return { ok: true, summary: `created ${t.target.display}` };
  },
};

// ---------------------------------------------------------------------------
// move / copy (shared destination resolution)
// ---------------------------------------------------------------------------

type MoveCopyResult =
  | { handled: ToolResult }
  | { from: ResolvedPath; fromSt: LStat; finalAbs: string; finalDisplay: string };

/**
 * Shared resolution for move/copy: validate both fields, resolve from/to
 * through the outside-access pattern, require the source to exist, and
 * apply the into-dir semantics (existing directory target receives the
 * source under its basename; anything else must be a fresh exact target).
 * Overwrites are refused, and a directory may never land inside itself.
 */
function resolveMoveCopy(
  tool: string,
  ctx: ToolContext & { dryRun: boolean },
  input: Record<string, unknown>,
): MoveCopyResult {
  for (const field of ['from', 'to'] as const) {
    if (!Object.hasOwn(input, field)) {
      return { handled: badShape(`${tool}: missing required field "${field}"`) };
    }
    if (typeof input[field] !== 'string' || (input[field] as string).trim() === '') {
      return { handled: badShape(`${tool}: ${field} must be a non-empty string`) };
    }
  }
  const tf = resolveTarget(tool, ctx, input['from']);
  if ('handled' in tf) return { handled: tf.handled };
  const tt = resolveTarget(tool, ctx, input['to']);
  if ('handled' in tt) return { handled: tt.handled };

  const fromSt = lstatPath(tf.target.abs);
  if (fromSt === null) {
    return { handled: badShape(`${tool}: no such file or directory: ${tf.target.display}`) };
  }
  const name = basename(tf.target.abs);
  let finalAbs: string;
  let finalDisplay: string;
  const toSt = lstatPath(tt.target.abs);
  if (toSt !== null && toSt.isDir) {
    finalAbs = join(tt.target.abs, name);
    finalDisplay = displayJoin(tt.target, name);
  } else {
    if (toSt !== null) {
      return {
        handled: badShape(`${tool}: target exists and is not a directory: ${tt.target.display}`),
      };
    }
    finalAbs = tt.target.abs;
    finalDisplay = tt.target.display;
  }
  if (finalAbs === tf.target.abs) {
    return {
      handled: badShape(`${tool}: source and destination are the same path: ${tf.target.display}`),
    };
  }
  if (pathExists(finalAbs)) {
    return { handled: badShape(`${tool}: target already exists: ${finalDisplay}`) };
  }
  if (fromSt.isDir && isWithin(tf.target.abs, finalAbs)) {
    return {
      handled: badShape(
        `${tool}: cannot ${tool === 'move' ? 'move' : 'copy'} a directory into itself: ${tf.target.display} → ${finalDisplay}`,
      ),
    };
  }
  // write targets share removeGuard (see module doc): the FINAL destination
  // is what gets written, so that is what gets guarded.
  const guard = removeGuard(finalAbs);
  if (!guard.ok) return { handled: badShape(`${tool}: ${guard.error}`) };
  return { from: tf.target, fromSt, finalAbs, finalDisplay };
}

export const moveTool: Tool = {
  name: 'move',
  description:
    'Move or rename a file or directory. An existing directory target ' +
    'receives the source under its own name (like mv); otherwise the target ' +
    'is exact and must not exist. Falls back to copy+remove across ' +
    'filesystems.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Path of the file or directory to move' },
      to: { type: 'string', description: 'Destination path (or an existing directory)' },
    },
    required: ['from', 'to'],
  },
  permissionLabel: (input) => `move(${labelPath(input, 'from')} → ${labelPath(input, 'to')})`,
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('move: input must be an object');
    const m = resolveMoveCopy('move', ctx, r);
    if ('handled' in m) return m.handled;
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would move ${m.from.display} → ${m.finalDisplay}`,
        preview: `move ${m.from.display} → ${m.finalDisplay}\ndestination: ${m.finalAbs}`,
      };
    }
    try {
      mkdirSync(dirname(m.finalAbs), { recursive: true });
      renameSync(m.from.abs, m.finalAbs);
    } catch (err) {
      if (isErrnoException(err) && err.code === 'EXDEV') {
        // cross-filesystem: copy the whole tree, then remove the source
        try {
          cpSync(m.from.abs, m.finalAbs, { recursive: true });
          rmSync(m.from.abs, { recursive: true, force: true });
        } catch (err2) {
          return badShape(`move: cannot move across filesystems: ${errText(err2)}`);
        }
      } else {
        return badShape(`move: cannot move ${m.from.display}: ${errText(err)}`);
      }
    }
    return { ok: true, summary: `moved ${m.from.display} → ${m.finalDisplay}` };
  },
};

export const copyTool: Tool = {
  name: 'copy',
  description:
    'Copy a file or a whole directory (recursive). An existing directory ' +
    'target receives the source under its own name (like cp); otherwise the ' +
    'target is exact and must not exist.',
  kind: 'write',
  parameters: {
    type: 'object',
    properties: {
      from: { type: 'string', description: 'Path of the file or directory to copy' },
      to: { type: 'string', description: 'Destination path (or an existing directory)' },
    },
    required: ['from', 'to'],
  },
  permissionLabel: (input) => `copy(${labelPath(input, 'from')} → ${labelPath(input, 'to')})`,
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('copy: input must be an object');
    const m = resolveMoveCopy('copy', ctx, r);
    if ('handled' in m) return m.handled;
    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would copy ${m.from.display} → ${m.finalDisplay}`,
        preview: `copy ${m.from.display} → ${m.finalDisplay}\ndestination: ${m.finalAbs}`,
      };
    }
    try {
      mkdirSync(dirname(m.finalAbs), { recursive: true });
      if (m.fromSt.isFile) copyFileSync(m.from.abs, m.finalAbs);
      else cpSync(m.from.abs, m.finalAbs, { recursive: true });
    } catch (err) {
      return badShape(`copy: cannot copy ${m.from.display}: ${errText(err)}`);
    }
    return { ok: true, summary: `copied ${m.from.display} → ${m.finalDisplay}` };
  },
};

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

export const removeTool: Tool = {
  name: 'remove',
  description:
    "Remove a file or directory (recursively). Default mode is 'trash' " +
    '(Linux XDG trash / macOS ~/.Trash; on Windows there is no shell-free ' +
    "trash so the delete is permanent). Mode 'permanent' deletes for real " +
    'on every platform — neither can be undone after the fact.',
  kind: 'write',
  neverAutoAllow: true,
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path of the file or directory to remove' },
      mode: {
        type: 'string',
        enum: ['trash', 'permanent'],
        description: "'trash' (default) or 'permanent'",
      },
    },
    required: ['path'],
  },
  permissionLabel: (input) => `remove(${labelPath(input, 'path')})`,
  run: async (input, ctx) => {
    const r = rec(input);
    if (r === null) return badShape('remove: input must be an object');
    if (!Object.hasOwn(r, 'path')) return badShape('remove: missing required field "path"');
    if (typeof r['path'] !== 'string' || r['path'].trim() === '') {
      return badShape('remove: path must be a non-empty string');
    }
    let mode: 'trash' | 'permanent' = 'trash';
    if (Object.hasOwn(r, 'mode')) {
      const v = r['mode'];
      if (v !== 'trash' && v !== 'permanent') {
        return badShape("remove: mode must be 'trash' or 'permanent'");
      }
      mode = v;
    }
    const t = resolveTarget('remove', ctx, r['path']);
    if ('handled' in t) return t.handled;
    // the guard runs BEFORE the dry-run preview: a guarded path fails
    // without prompting, so no dry run can claim success for it.
    const guard = removeGuard(t.target.abs);
    if (!guard.ok) return badShape(`remove: ${guard.error}`);

    const st = lstatPath(t.target.abs);
    if (st === null) return badShape(`remove: no such file or directory: ${t.target.display}`);
    const stats: FolderStats = st.isDir
      ? folderStats(t.target.abs)
      : { items: 1, bytes: st.size, truncated: false };
    const statsNote =
      `${stats.items} item${stats.items === 1 ? '' : 's'} · ${formatBytes(stats.bytes)}` +
      (stats.truncated ? ` (walk truncated at ${MAX_STATS_ENTRIES} entries — a lower bound)` : '');
    // win32 has no shell-free trash: every delete is permanent there.
    const permanent = mode === 'permanent' || process.platform === 'win32';

    if (ctx.dryRun) {
      return {
        ok: true,
        summary: `would remove ${t.target.display} (${statsNote}) — ${permanent ? 'PERMANENT — cannot be undone' : 'moves to trash'}`,
        preview: `${t.target.abs}\n${statsNote}\n${permanent ? 'PERMANENT — cannot be undone' : 'moves to trash'}`,
      };
    }
    if (permanent) {
      try {
        rmSync(t.target.abs, { recursive: true });
      } catch (err) {
        return badShape(`remove: cannot delete ${t.target.display}: ${errText(err)}`);
      }
      const why =
        process.platform === 'win32'
          ? ' — PERMANENTLY deleted — the Windows trash needs a shell, which this CLI never runs'
          : ' — PERMANENT (cannot be undone)';
      return { ok: true, summary: `removed ${t.target.display} (${statsNote})${why}` };
    }
    const trashed = moveToTrash(t.target.abs);
    if (!trashed.ok) {
      return badShape(`remove: ${trashed.error} (${t.target.display}) — nothing was deleted`);
    }
    return {
      ok: true,
      summary: `removed ${t.target.display} (${statsNote} — moved to trash)`,
    };
  },
};
