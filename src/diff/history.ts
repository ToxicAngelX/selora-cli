/**
 * src/diff/history.ts — checkpoint history for the diff subsystem: every
 * applied file change leaves a Checkpoint (before/after text, change kind,
 * mode) so the session can undo and redo REAL files on disk, and so a later
 * session can keep undoing where this one stopped.
 *
 * On disk: one JSON file per checkpoint under `<root>/.selora/history/`
 * (or an explicit `dir`), named `<id>.json`, written atomically (tmp +
 * rename — the session-store pattern) so a crash mid-write can never
 * corrupt a sibling checkpoint. Each file is versioned and carries its
 * monotonic `seq`; loading sorts by (seq, name), so restart order never
 * depends on filename lexicographics ("…-10" sorts before "…-9") or on
 * clock resolution. Malformed files are reported and skipped, never a
 * crash — the house rule for every config reader.
 *
 * In memory: two stacks. The undo stack is the history, oldest → newest;
 * undo pops it onto the redo stack, redo pops it back. A new record is a
 * new future: the redo stack (and its on-disk files) dies on the spot.
 * Stacks and disk stay in lockstep — undo deletes the checkpoint file,
 * redo rewrites it — so what a fresh instance loads is exactly what is
 * still undoable, never something already undone.
 *
 * Failure rules, pinned: nothing here throws. undo/redo are failure-atomic
 * — the target file is written first (tmp + rename, recorded mode
 * re-applied best-effort), the stacks move only after success, and errors
 * come back as typed SafeResults (ENOENT/EACCES/EPERM/ENOSPC/…/OTHER).
 * record() cannot fail in memory; a checkpoint that cannot reach the disk
 * simply lives without persistence. A broken history dir (EACCES &
 * friends) degrades the whole instance to memory-only. persist:false
 * (tests, dry-run) skips all checkpoint I/O — the dir is never created.
 *
 * Pruning: after each record, while the dir's bytes exceed maxBytes the
 * oldest checkpoints are dropped (stack + file together) — but never the
 * one just written, so a single oversized entry is kept and info().pruned
 * (a sticky latch) still reports that the cap could not be honoured.
 * Loading caps at 500 checkpoints; older overflow is pruned the same way.
 * Single CLI process, all methods synchronous; re-entrancy cannot corrupt
 * because every mutation is a single statement after the fallible work.
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { Checkpoint, DiffErrorCode, HistoryInfo, SafeResult } from './types.js';

/** Default on-disk home of the checkpoint files, relative to the project root. */
export const HISTORY_DIR = '.selora/history';

/** Envelope version — anything else is a future format: skipped, never mangled. */
const HISTORY_VERSION = 1;

/** Restart load cap — older overflow is pruned (and reported via info().pruned). */
const LOAD_CAP = 500;

/** What undo() did to the target file. */
export type UndoAction = 'restored' | 'removed';

/**
 * What redo() did: re-applied content of a modify ('restored'), re-applied
 * a create ('recreated'), or re-applied a delete ('removed').
 */
export type RedoAction = 'restored' | 'recreated' | 'removed';

/** The versioned on-disk envelope of one checkpoint file. */
interface StoredCheckpoint {
  version: number;
  /** Monotonic creation order — the sort key filenames cannot provide. */
  seq: number;
  entry: Checkpoint;
}

/** A checkpoint plus its order token; the stacks hold these internally. */
interface StackEntry {
  seq: number;
  entry: Checkpoint;
}

const CHANGE_KINDS: ReadonlySet<string> = new Set(['created', 'modified', 'deleted', 'renamed']);

/** Map a caught fs error onto the shared DiffErrorCode set. */
function errorCode(err: unknown): DiffErrorCode {
  const code = (err as { code?: unknown } | null)?.code;
  switch (code) {
    case 'ENOENT':
    case 'EACCES':
    case 'EPERM':
    case 'ENOSPC':
    case 'EROFS':
    case 'EBUSY':
    case 'EISDIR':
      return code;
    default:
      return 'OTHER';
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail<T>(err: unknown, path: string): SafeResult<T> {
  return { ok: false, error: { code: errorCode(err), message: errorMessage(err), path } };
}

/**
 * Write text to absPath atomically (tmp + rename, utf8), creating the parent
 * dir first — undoing a delete can land where the change's own bookkeeping
 * already removed the directory. The recorded mode is re-applied
 * best-effort: content is the cargo, mode the nicety.
 */
function writeFileAtomic(absPath: string, text: string, mode: number | undefined): void {
  const parent = dirname(absPath);
  mkdirSync(parent, { recursive: true });
  const tmp = join(parent, `.${basename(absPath)}.tmp-${randomUUID()}`);
  try {
    writeFileSync(tmp, text, 'utf8');
    renameSync(tmp, absPath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // tmp already gone — nothing to clean
    }
    throw err;
  }
  if (mode !== undefined) {
    try {
      chmodSync(absPath, mode);
    } catch {
      // best-effort (see docstring): the content restore already succeeded
    }
  }
}

/** Parse one checkpoint file; null when unreadable or malformed (reported). */
function readCheckpoint(path: string): { seq: number; entry: Checkpoint } | null {
  const bad = (): null => {
    console.error(`· Ignoring malformed checkpoint file ${path}`);
    return null;
  };
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null; // unreadable ≠ malformed (e.g. a mid-rename race) — nothing to report
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad();
  }
  const rec =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (rec === null) return bad();
  if (rec['version'] !== HISTORY_VERSION) return bad();
  const seq = rec['seq'];
  if (typeof seq !== 'number' || !Number.isFinite(seq) || seq < 0) return bad();
  const raw = rec['entry'];
  const e =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : null;
  if (e === null) return bad();
  const id = e['id'];
  const at = e['at'];
  const absPath = e['absPath'];
  const displayPath = e['displayPath'];
  const changeKind = e['changeKind'];
  if (
    typeof id !== 'string' ||
    id === '' ||
    typeof at !== 'string' ||
    typeof absPath !== 'string' ||
    absPath === '' ||
    typeof displayPath !== 'string' ||
    typeof changeKind !== 'string' ||
    !CHANGE_KINDS.has(changeKind)
  ) {
    return bad();
  }
  const beforeText = typeof e['beforeText'] === 'string' ? e['beforeText'] : undefined;
  const afterText = typeof e['afterText'] === 'string' ? e['afterText'] : undefined;
  const mode = e['mode'];
  return {
    seq,
    entry: {
      id,
      at,
      absPath,
      displayPath,
      changeKind: changeKind as Checkpoint['changeKind'],
      beforeText,
      afterText,
      mode: typeof mode === 'number' && Number.isFinite(mode) ? mode : undefined,
    },
  };
}

/**
 * The checkpoint ledger. Construct with the project root and a byte cap;
 * everything else is optional (dir override, persist:false for memory-only).
 */
export class DiffHistory {
  private readonly dir: string;
  private readonly maxBytes: number;
  /** Flips false when the dir proves unusable — memory-only, never fatal. */
  private persist: boolean;
  /** Oldest → newest; undo pops the end. */
  private undoStack: StackEntry[] = [];
  /** Undone checkpoints, most-recently-undone on top; redo pops the end. */
  private redoStack: StackEntry[] = [];
  /** Monotonic id counter — survives restarts via the loaded max seq. */
  private seq = 0;
  /** Sticky: set once pruning (or the load cap) has dropped checkpoints. */
  private prunedFlag = false;

  constructor(opts: {
    root: string;
    maxBytes: number;
    dir?: string | undefined;
    persist?: boolean | undefined;
  }) {
    this.dir = opts.dir ?? join(opts.root, HISTORY_DIR);
    this.maxBytes = Math.max(0, opts.maxBytes);
    this.persist = opts.persist ?? true;
    if (!this.persist) return;
    // Lazy disk (v1.3): the history dir is created on the FIRST checkpoint,
    // never at construction — a session that changed nothing leaves no
    // .selora trace in the project. An existing dir is scanned for undoable
    // checkpoints; a missing/unreadable one is just "no history yet".
    if (existsSync(this.dir)) this.loadFromDisk();
  }

  /**
   * Append a checkpoint: the undo stack grows, the redo future dies (stack
   * and files), the envelope hits the disk atomically, then the oldest
   * checkpoints are pruned to fit maxBytes. Infallible — disk trouble only
   * costs persistence.
   */
  record(entry: Omit<Checkpoint, 'id' | 'at'>): Checkpoint {
    this.seq += 1;
    const item: StackEntry = {
      seq: this.seq,
      entry: {
        ...entry,
        id: `${Date.now().toString(36)}-${this.seq}`,
        at: new Date().toISOString(),
      },
    };
    this.undoStack.push(item);
    if (this.redoStack.length > 0) {
      if (this.persist) {
        for (const dead of this.redoStack) this.deleteFile(this.fileFor(dead.entry.id));
      }
      this.redoStack = [];
    }
    if (this.persist) {
      this.writeCheckpoint(item);
      this.pruneToFit(item.entry.id);
    }
    return item.entry;
  }

  /**
   * Revert the newest checkpoint on the real file: a create's file is
   * removed ('removed'), anything else gets its beforeText back atomically
   * with the recorded mode when known ('restored'). Failure-atomic: the
   * stacks move only after the write succeeds, and the checkpoint file is
   * deleted so a restart never re-undoes it.
   */
  undo(): SafeResult<{ displayPath: string; action: UndoAction }> {
    const top = this.undoStack.at(-1);
    if (top === undefined) {
      return { ok: false, error: { code: 'ENOENT', message: 'nothing to undo' } };
    }
    const { entry } = top;
    let action: UndoAction;
    try {
      if (entry.beforeText === undefined) {
        // The change created this file — undo removes it (missing is fine).
        rmSync(entry.absPath, { force: true });
        action = 'removed';
      } else {
        writeFileAtomic(entry.absPath, entry.beforeText, entry.mode);
        action = 'restored';
      }
    } catch (err) {
      return fail(err, entry.absPath);
    }
    this.undoStack.pop();
    this.redoStack.push(top);
    if (this.persist) this.deleteFile(this.fileFor(entry.id));
    return { ok: true, value: { displayPath: entry.displayPath, action } };
  }

  /**
   * Re-apply the most recently undone checkpoint: afterText back (a create
   * is 'recreated', a modify 'restored'), or the file removed again for a
   * delete ('removed'). The checkpoint is re-persisted so a restart can
   * undo it. Same failure-atomicity as undo.
   */
  redo(): SafeResult<{ displayPath: string; action: RedoAction }> {
    const top = this.redoStack.at(-1);
    if (top === undefined) {
      return { ok: false, error: { code: 'ENOENT', message: 'nothing to redo' } };
    }
    const { entry } = top;
    let action: RedoAction;
    try {
      if (entry.afterText === undefined) {
        // Redoing a delete removes the file again (missing is fine).
        rmSync(entry.absPath, { force: true });
        action = 'removed';
      } else {
        // Checkpoint stores only the BEFORE mode, so redo cannot restore the
        // after-mode — the write keeps the filesystem default.
        writeFileAtomic(entry.absPath, entry.afterText, undefined);
        action = entry.changeKind === 'created' ? 'recreated' : 'restored';
      }
    } catch (err) {
      return fail(err, entry.absPath);
    }
    this.redoStack.pop();
    this.undoStack.push(top);
    if (this.persist) this.writeCheckpoint(top);
    return { ok: true, value: { displayPath: entry.displayPath, action } };
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** The newest undoable checkpoint; undefined when the history is empty. */
  last(): Checkpoint | undefined {
    return this.undoStack.at(-1)?.entry;
  }

  /** The undoable history, oldest → newest. */
  list(): readonly Checkpoint[] {
    return this.undoStack.map((item) => item.entry);
  }

  /** entries = list().length; bytes = the dir's checkpoint files (0 memory-only). */
  info(): HistoryInfo {
    return {
      entries: this.undoStack.length,
      bytes: this.persist ? this.dirBytes() : 0,
      pruned: this.prunedFlag,
    };
  }

  /** Forget everything — both stacks and every checkpoint file (best-effort). */
  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.prunedFlag = false;
    if (!this.persist) return;
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.endsWith('.json') && !name.startsWith('.')) this.deleteFile(join(this.dir, name));
    }
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  private fileFor(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Atomic tmp+rename write of one checkpoint envelope; best-effort. */
  private writeCheckpoint(item: StackEntry): void {
    const body: StoredCheckpoint = { version: HISTORY_VERSION, seq: item.seq, entry: item.entry };
    const tmp = join(this.dir, `.${item.entry.id}.tmp-${randomUUID()}`);
    try {
      mkdirSync(this.dir, { recursive: true }); // lazy disk — first write creates it
      writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
      renameSync(tmp, this.fileFor(item.entry.id));
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // tmp already gone — nothing to clean
      }
      // Persistence lost — the in-memory checkpoint still undoes fine.
    }
  }

  private deleteFile(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      // best-effort: a stray file is noise, not a failure
    }
  }

  /** Sum of the checkpoint files' sizes; 0 when the dir is unreadable. */
  private dirBytes(): number {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return 0;
    }
    let total = 0;
    for (const name of names) {
      if (!name.endsWith('.json') || name.startsWith('.')) continue;
      try {
        total += statSync(join(this.dir, name)).size;
      } catch {
        // vanished mid-scan — skip
      }
    }
    return total;
  }

  /**
   * Drop oldest checkpoints (stack + file together) while the dir exceeds
   * maxBytes — but never `protectedId`, the checkpoint record() just wrote:
   * a single oversized entry stays, and the pruned latch still reports the
   * breach.
   */
  private pruneToFit(protectedId: string): void {
    let bytes = this.dirBytes();
    while (bytes > this.maxBytes) {
      const oldest = this.undoStack[0];
      if (oldest === undefined || oldest.entry.id === protectedId) break;
      this.undoStack.shift();
      this.deleteFile(this.fileFor(oldest.entry.id));
      this.prunedFlag = true;
      bytes = this.dirBytes();
    }
    if (bytes > this.maxBytes) this.prunedFlag = true;
  }

  /**
   * Load every well-formed checkpoint into the undo stack, ordered by the
   * stored (seq, name) — restart order never trusts filename lexicographics.
   * Overflow beyond LOAD_CAP is pruned oldest-first.
   */
  private loadFromDisk(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
    } catch {
      this.persist = false; // unreadable dir — memory-only
      return;
    }
    const loaded: { seq: number; name: string; entry: Checkpoint }[] = [];
    for (const name of names) {
      const parsed = readCheckpoint(join(this.dir, name));
      if (parsed !== null) loaded.push({ seq: parsed.seq, name, entry: parsed.entry });
    }
    loaded.sort((a, b) =>
      a.seq !== b.seq ? a.seq - b.seq : a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const item of loaded) this.seq = Math.max(this.seq, item.seq);
    if (loaded.length > LOAD_CAP) {
      this.prunedFlag = true;
      for (const drop of loaded.splice(0, loaded.length - LOAD_CAP)) {
        this.deleteFile(join(this.dir, drop.name));
      }
    }
    this.undoStack = loaded.map((item) => ({ seq: item.seq, entry: item.entry }));
  }
}
