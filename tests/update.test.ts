/**
 * `selora update` tests — network and install fully injected, so nothing
 * here touches the real npm registry or spawns npm.
 */

import { describe, expect, it } from 'vitest';
import { capturedIo, cleanup, freshEnv, type TempEnv } from './helpers/env.js';
import { isNewer, runUpdate } from '../src/commands/update.js';
import type { CliContext } from '../src/context.js';

let env: TempEnv;

function ctx(io: ReturnType<typeof capturedIo>['io'], json = false): CliContext {
  return { debug: false, json, apiUrl: undefined, io };
}

describe('isNewer', () => {
  it('compares semver triples', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true);
    expect(isNewer('1.1.0', '1.0.9')).toBe(true);
    expect(isNewer('2.0.0', '1.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', '1.0.1')).toBe(false);
  });

  it('returns false for malformed input (never advises a "newer" garbage version)', () => {
    expect(isNewer('not.a.version', '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', 'banana')).toBe(false);
  });
});

describe('runUpdate', () => {
  it('up to date — prints "up to date", exit code untouched', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    await runUpdate(ctx(io), {
      fetchLatestVersion: async () => '1.0.0',
    });
    const text = cap.all();
    expect(text).toContain('Current');
    expect(text).toContain('✓ up to date');
    expect(text).not.toContain('update available');
    expect(process.exitCode).toBeUndefined();
    cleanup(env.dir);
  });

  it('update available, no flags — tells the user to pass --yes (no install)', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    let installed = 0;
    await runUpdate(ctx(io), {
      fetchLatestVersion: async () => '1.5.0',
      install: async () => {
        installed += 1;
        return { code: 0 };
      },
    });
    const text = cap.all();
    expect(text).toContain('update available');
    expect(text).toContain('selora update --yes');
    expect(installed).toBe(0); // never installs without --yes
    expect(process.exitCode).toBeUndefined();
    cleanup(env.dir);
  });

  it('--check — reports availability with the manual command, never installs', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    let installed = 0;
    await runUpdate(ctx(io), {
      check: true,
      fetchLatestVersion: async () => '1.5.0',
      install: async () => {
        installed += 1;
        return { code: 0 };
      },
    });
    const text = cap.all();
    expect(text).toContain('update available');
    expect(text).toContain('npm install -g selora@1.5.0');
    expect(installed).toBe(0);
    cleanup(env.dir);
  });

  it('--yes — installs and confirms', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    const versions: string[] = [];
    await runUpdate(ctx(io), {
      yes: true,
      fetchLatestVersion: async () => '1.5.0',
      install: async (v) => {
        versions.push(v);
        return { code: 0 };
      },
    });
    expect(versions).toEqual(['1.5.0']);
    expect(cap.all()).toContain('✓ updated to 1.5.0');
    expect(process.exitCode).toBeUndefined();
    cleanup(env.dir);
  });

  it('--yes, install fails — honest failure, exit 1', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    await runUpdate(ctx(io), {
      yes: true,
      fetchLatestVersion: async () => '1.5.0',
      install: async () => ({ code: 1 }),
    });
    const text = cap.all();
    expect(text).toContain('✗ install failed');
    expect(text).toContain('npm install -g selora@1.5.0');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    cleanup(env.dir);
  });

  it('registry unreachable — exit 1, honest message', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    await runUpdate(ctx(io), {
      fetchLatestVersion: async () => null,
    });
    expect(cap.all()).toContain('could not reach the npm registry');
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    cleanup(env.dir);
  });

  it('--json — machine envelope', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    await runUpdate(ctx(io, true), {
      fetchLatestVersion: async () => '1.5.0',
    });
    const parsed = JSON.parse(cap.out.join('\n').trim()) as {
      ok: boolean;
      current: string;
      latest: string;
      update_available: boolean;
    };
    expect(parsed).toEqual({
      ok: true,
      current: '1.4.0',
      latest: '1.5.0',
      update_available: true,
    });
    cleanup(env.dir);
  });

  it('older registry latest (rollback on the registry) is not an "update"', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    await runUpdate(ctx(io), {
      fetchLatestVersion: async () => '0.9.0',
    });
    expect(cap.all()).toContain('✓ up to date');
    cleanup(env.dir);
  });
});
