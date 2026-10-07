/**
 * `selora trust [add <dir> | remove <dir>]` — list/add/remove against a fresh
 * temp config dir per test, with friendly errors (missing dir arg, missing
 * folder, unknown action) and --json shapes.
 */

import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, capturedIo, freshEnv, type TempEnv } from './helpers/env.js';
import { runTrust } from '../src/commands/trust.js';
import { isTrustedDir, loadTrustedDirs } from '../src/config/trust.js';
import type { CliContext, CliIo } from '../src/context.js';

let env: TempEnv;
const envDirs: string[] = [];

beforeEach(() => {
  env = freshEnv();
  envDirs.push(env.dir);
});

afterAll(() => {
  for (const d of envDirs) cleanup(d);
});

function ctx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: undefined, io };
}

function realTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

describe('selora trust', () => {
  it('no args: empty list is honest, with the add hint', async () => {
    const { io, cap } = capturedIo();
    await runTrust(ctx(io), {});
    expect(cap.out.join('\n')).toContain('No trusted workspaces');
    expect(cap.out.join('\n')).toContain('selora trust add .');
    expect(process.exitCode).toBeUndefined();
  });

  it('add trusts a directory (canonical form), list shows it, remove drops it', async () => {
    const dir = realTempDir('selora-trust-cmd-');
    try {
      const add = capturedIo();
      await runTrust(ctx(add.io), { action: 'add', dir });
      expect(add.cap.out.join('\n')).toContain(`✓ Trusted ${dir}`);
      expect(process.exitCode).toBeUndefined();
      expect(isTrustedDir(dir)).toBe(true);

      const list = capturedIo();
      await runTrust(ctx(list.io), {});
      expect(list.cap.out).toContain(dir);

      const rm = capturedIo();
      await runTrust(ctx(rm.io), { action: 'remove', dir });
      expect(rm.cap.out.join('\n')).toContain(`✓ Removed ${dir}`);
      expect(isTrustedDir(dir)).toBe(false);
      expect(loadTrustedDirs()).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('add resolves "." against the process cwd', async () => {
    const dir = realTempDir('selora-trust-dot-');
    const prev = process.cwd();
    try {
      process.chdir(dir);
      const { io, cap } = capturedIo();
      await runTrust(ctx(io), { action: 'add', dir: '.' });
      expect(cap.out.join('\n')).toContain(`✓ Trusted ${dir}`);
      expect(isTrustedDir(dir)).toBe(true);
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('add on a missing folder: friendly error, exit 1, nothing persisted', async () => {
    const { io, cap } = capturedIo();
    const gone = join(env.dir, 'no-such-dir');
    await runTrust(ctx(io), { action: 'add', dir: gone });
    expect(cap.err.join('\n')).toContain(`✗ cannot trust ${gone} — no such directory`);
    expect(process.exitCode).toBe(1);
    expect(loadTrustedDirs()).toEqual([]);
  });

  it('add/remove without a dir: usage error, exit 1', async () => {
    const { io, cap } = capturedIo();
    await runTrust(ctx(io), { action: 'add' });
    expect(cap.err.join('\n')).toContain('selora trust add needs a directory');
    expect(process.exitCode).toBe(1);
  });

  it('remove of a dir that was never trusted: a note, not an error', async () => {
    const dir = realTempDir('selora-trust-cmd-');
    try {
      const { io, cap } = capturedIo();
      await runTrust(ctx(io), { action: 'remove', dir });
      expect(cap.err.join('\n')).toContain('was not on the trusted list');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unknown action: usage error, exit 1', async () => {
    const { io, cap } = capturedIo();
    await runTrust(ctx(io), { action: 'frobnicate' });
    expect(cap.err.join('\n')).toContain('✗ unknown action "frobnicate"');
    expect(process.exitCode).toBe(1);
  });

  it('--json: list and add emit machine envelopes', async () => {
    const dir = realTempDir('selora-trust-cmd-');
    try {
      const add = capturedIo();
      await runTrust(ctx(add.io, true), { action: 'add', dir });
      const added = JSON.parse(add.cap.out.join('\n')) as { ok: boolean; trusted: string };
      expect(added).toEqual({ ok: true, trusted: dir });

      const list = capturedIo();
      await runTrust(ctx(list.io, true), {});
      const listed = JSON.parse(list.cap.out.join('\n')) as { ok: boolean; trusted: string[] };
      expect(listed).toEqual({ ok: true, trusted: [dir] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
