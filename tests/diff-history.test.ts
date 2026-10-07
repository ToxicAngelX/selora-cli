/**
 * DiffHistory tests: checkpoints against REAL files in a temp root —
 * modify/create/delete round-trips through undo and redo, typed errors on
 * empty stacks, redo-future invalidation on record, restart persistence,
 * byte-cap pruning, persist:false purity, malformed-file honesty, mode
 * restoration, and failure-atomicity (a failed undo moves no stacks).
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiffHistory } from '../src/diff/history.js';

let roots: string[] = [];
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'selora-diffhist-'));
  roots.push(root);
});

afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
  roots = [];
});

function historyDir(r: string): string {
  return join(r, '.selora', 'history');
}

describe('DiffHistory', () => {
  it('modify: undo restores the old content, redo re-applies the new', () => {
    const file = join(root, 'a.txt');
    writeFileSync(file, 'old content\n', 'utf8');
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    const cp = h.record({
      absPath: file,
      displayPath: 'a.txt',
      changeKind: 'modified',
      beforeText: 'old content\n',
      afterText: 'new content\n',
      mode: undefined,
    });
    expect(cp.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(cp.at))).toBe(false);
    // the change itself is applied
    writeFileSync(file, 'new content\n', 'utf8');

    expect(h.canUndo()).toBe(true);
    expect(h.canRedo()).toBe(false);
    const u = h.undo();
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.value).toEqual({ displayPath: 'a.txt', action: 'restored' });
    expect(readFileSync(file, 'utf8')).toBe('old content\n');
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(true);

    const r = h.redo();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ displayPath: 'a.txt', action: 'restored' });
    expect(readFileSync(file, 'utf8')).toBe('new content\n');
    expect(h.canRedo()).toBe(false);
    expect(h.canUndo()).toBe(true);
  });

  it('created: undo removes the file, redo recreates it', () => {
    const file = join(root, 'new.txt');
    writeFileSync(file, 'hello\n', 'utf8');
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    h.record({
      absPath: file,
      displayPath: 'new.txt',
      changeKind: 'created',
      beforeText: undefined,
      afterText: 'hello\n',
      mode: undefined,
    });

    const u = h.undo();
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.value.action).toBe('removed');
    expect(existsSync(file)).toBe(false);

    const r = h.redo();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe('recreated');
    expect(readFileSync(file, 'utf8')).toBe('hello\n');
  });

  it('deleted: undo restores the content, redo removes the file again', () => {
    const file = join(root, 'gone.txt');
    writeFileSync(file, 'was here\n', 'utf8');
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    h.record({
      absPath: file,
      displayPath: 'gone.txt',
      changeKind: 'deleted',
      beforeText: 'was here\n',
      afterText: undefined,
      mode: undefined,
    });
    rmSync(file); // the delete itself

    const u = h.undo();
    expect(u.ok).toBe(true);
    if (u.ok) expect(u.value.action).toBe('restored');
    expect(readFileSync(file, 'utf8')).toBe('was here\n');

    const r = h.redo();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.action).toBe('removed');
    expect(existsSync(file)).toBe(false);
  });

  it('undo/redo on empty stacks are typed ENOENT errors, never throws', () => {
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    const u = h.undo();
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.error.code).toBe('ENOENT');
      expect(u.error.message).toBe('nothing to undo');
    }
    const r = h.redo();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('ENOENT');
      expect(r.error.message).toBe('nothing to redo');
    }
  });

  it('a new record invalidates the redo future', () => {
    const file = join(root, 'f.txt');
    writeFileSync(file, 'v1', 'utf8');
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    h.record({
      absPath: file,
      displayPath: 'f.txt',
      changeKind: 'modified',
      beforeText: 'v1',
      afterText: 'v2',
      mode: undefined,
    });
    writeFileSync(file, 'v2', 'utf8');
    expect(h.undo().ok).toBe(true);
    expect(h.canRedo()).toBe(true);

    h.record({
      absPath: file,
      displayPath: 'f.txt',
      changeKind: 'modified',
      beforeText: 'v1',
      afterText: 'v3',
      mode: undefined,
    });
    expect(h.canRedo()).toBe(false);
    const r = h.redo();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('ENOENT');
    // and the undone checkpoint's file is gone from the dir (dead future)
    expect(readdirSync(historyDir(root))).toHaveLength(1);
  });

  it('persistence: a second instance sees the checkpoints and undoes across the restart', () => {
    const file = join(root, 'persist.txt');
    writeFileSync(file, 'before\n', 'utf8');
    const h1 = new DiffHistory({ root, maxBytes: 1_000_000 });
    const cp1 = h1.record({
      absPath: file,
      displayPath: 'persist.txt',
      changeKind: 'modified',
      beforeText: 'before\n',
      afterText: 'after\n',
      mode: undefined,
    });
    writeFileSync(file, 'after\n', 'utf8');

    // "restart": a fresh instance over the same dir
    const h2 = new DiffHistory({ root, maxBytes: 1_000_000 });
    expect(h2.list().map((c) => c.id)).toEqual([cp1.id]);
    expect(h2.last()?.id).toBe(cp1.id);

    // the sequence survives: h2's record sorts after h1's
    const cp2 = h2.record({
      absPath: file,
      displayPath: 'persist.txt',
      changeKind: 'modified',
      beforeText: 'after\n',
      afterText: 'after2\n',
      mode: undefined,
    });
    expect(cp2.id).not.toBe(cp1.id);
    writeFileSync(file, 'after2\n', 'utf8');

    const h3 = new DiffHistory({ root, maxBytes: 1_000_000 });
    expect(h3.list().map((c) => c.id)).toEqual([cp1.id, cp2.id]);
    expect(h3.undo().ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('after\n');
    expect(h3.undo().ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('before\n');

    // undone checkpoints left no files: a fourth instance has nothing to undo
    const h4 = new DiffHistory({ root, maxBytes: 1_000_000 });
    expect(h4.canUndo()).toBe(false);
  });

  it('pruning: oldest checkpoints drop to fit maxBytes; the newest is always kept', () => {
    // Each envelope is ~900 bytes; the cap of 200 can never be honoured, so
    // every record prunes down to just itself — the kept-newest exception.
    const h = new DiffHistory({ root, maxBytes: 200 });
    const big = 'x'.repeat(400);
    const recorded: string[] = [];
    for (let i = 0; i < 4; i++) {
      recorded.push(
        h.record({
          absPath: join(root, `f${i}.txt`),
          displayPath: `f${i}.txt`,
          changeKind: 'modified',
          beforeText: big,
          afterText: big,
          mode: undefined,
        }).id,
      );
    }
    const newest = recorded[recorded.length - 1];
    expect(newest).toBeDefined();
    if (newest === undefined) return;

    expect(h.list().map((c) => c.id)).toEqual([newest]);
    expect(readdirSync(historyDir(root))).toEqual([`${newest}.json`]);
    const info = h.info();
    expect(info.pruned).toBe(true);
    expect(info.entries).toBe(1);
    // bytes exceed the cap: the single oversized entry is kept by design
    expect(info.bytes).toBeGreaterThan(200);
    expect(h.last()?.id).toBe(newest);
  });

  it('persist:false never touches the disk but still undoes in memory', () => {
    const file = join(root, 'x.txt');
    const h = new DiffHistory({ root, maxBytes: 1_000_000, persist: false });
    h.record({
      absPath: file,
      displayPath: 'x.txt',
      changeKind: 'created',
      beforeText: undefined,
      afterText: 'data',
      mode: undefined,
    });
    expect(existsSync(join(root, '.selora'))).toBe(false);
    expect(h.info()).toEqual({ entries: 1, bytes: 0, pruned: false });

    writeFileSync(file, 'data', 'utf8');
    expect(h.undo().ok).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(root, '.selora'))).toBe(false);
  });

  it('malformed checkpoint files are skipped, never fatal', () => {
    const dir = historyDir(root);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'garbage.json'), 'not json {{{', 'utf8');
    writeFileSync(join(dir, 'wrong-shape.json'), JSON.stringify({ version: 1, seq: 'x' }), 'utf8');
    writeFileSync(
      join(dir, 'future.json'),
      JSON.stringify({ version: 99, seq: 1, entry: {} }),
      'utf8',
    );

    const file = join(root, 'ok.txt');
    writeFileSync(file, 'v1', 'utf8');
    const h1 = new DiffHistory({ root, maxBytes: 1_000_000 });
    const cp = h1.record({
      absPath: file,
      displayPath: 'ok.txt',
      changeKind: 'modified',
      beforeText: 'v1',
      afterText: 'v2',
      mode: undefined,
    });

    const h2 = new DiffHistory({ root, maxBytes: 1_000_000 });
    expect(h2.list().map((c) => c.id)).toEqual([cp.id]);
    writeFileSync(file, 'v2', 'utf8');
    expect(h2.undo().ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('v1');
  });

  it('info() mirrors entries and on-disk bytes; clear() empties everything', () => {
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    expect(h.info()).toEqual({ entries: 0, bytes: 0, pruned: false });
    h.record({
      absPath: join(root, 'a'),
      displayPath: 'a',
      changeKind: 'created',
      beforeText: undefined,
      afterText: 'aaaa',
      mode: undefined,
    });
    h.record({
      absPath: join(root, 'b'),
      displayPath: 'b',
      changeKind: 'created',
      beforeText: undefined,
      afterText: 'bbbb',
      mode: undefined,
    });
    const info = h.info();
    expect(info.entries).toBe(2);
    expect(info.entries).toBe(h.list().length);
    const dir = historyDir(root);
    const diskBytes = readdirSync(dir).reduce((n, f) => n + statSync(join(dir, f)).size, 0);
    expect(info.bytes).toBe(diskBytes);

    h.clear();
    expect(h.info()).toEqual({ entries: 0, bytes: 0, pruned: false });
    expect(readdirSync(dir)).toEqual([]);
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });

  it('list() is oldest → newest and last() is the newest; ids are unique', () => {
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(
        h.record({
          absPath: join(root, `f${i}`),
          displayPath: `f${i}`,
          changeKind: 'modified',
          beforeText: 'a',
          afterText: 'b',
          mode: undefined,
        }).id,
      );
    }
    expect(h.list().map((c) => c.id)).toEqual(ids);
    expect(h.last()?.id).toBe(ids[ids.length - 1]);
    expect(new Set(ids).size).toBe(5);
  });

  it('undo restores the recorded permission bits when known', () => {
    const file = join(root, 'mode.txt');
    writeFileSync(file, 'locked\n', 'utf8');
    chmodSync(file, 0o600);
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    h.record({
      absPath: file,
      displayPath: 'mode.txt',
      changeKind: 'modified',
      beforeText: 'locked\n',
      afterText: 'changed\n',
      mode: 0o600,
    });
    writeFileSync(file, 'changed\n', 'utf8');
    chmodSync(file, 0o644); // the change clobbered the mode

    expect(h.undo().ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('locked\n');
    // POSIX mode bits are unrepresentable on Windows (only the read-only flag
    // maps) — the restore is still best-effort there; assert the mode only
    // where the filesystem honors it.
    if (process.platform !== 'win32') {
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it('failure-atomic: a failed undo moves no stacks and can be retried', () => {
    const blocked = join(root, 'blocked');
    mkdirSync(blocked); // a directory sits where the file must be restored
    const h = new DiffHistory({ root, maxBytes: 1_000_000 });
    h.record({
      absPath: blocked,
      displayPath: 'blocked',
      changeKind: 'modified',
      beforeText: 'content\n',
      afterText: 'other\n',
      mode: undefined,
    });

    const u = h.undo();
    expect(u.ok).toBe(false);
    if (!u.ok) {
      expect(u.error.path).toBe(blocked);
      expect(['EISDIR', 'OTHER', 'EPERM', 'EACCES']).toContain(u.error.code);
    }
    expect(h.canUndo()).toBe(true); // peek, not pop
    expect(h.canRedo()).toBe(false);

    rmSync(blocked, { recursive: true, force: true });
    const retry = h.undo();
    expect(retry.ok).toBe(true);
    expect(readFileSync(blocked, 'utf8')).toBe('content\n');
  });

  it('honours an explicit dir override', () => {
    const dir = join(root, 'custom-hist');
    const h = new DiffHistory({ root, maxBytes: 1_000_000, dir });
    const cp = h.record({
      absPath: join(root, 'y.txt'),
      displayPath: 'y.txt',
      changeKind: 'created',
      beforeText: undefined,
      afterText: 'y',
      mode: undefined,
    });
    expect(readdirSync(dir)).toEqual([`${cp.id}.json`]);
    expect(existsSync(historyDir(root))).toBe(false);
  });
});
