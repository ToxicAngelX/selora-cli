/**
 * The trusted-workspace store (src/config/trust.ts): trusted.json in the
 * config dir — persistence, 0600 mode, realpath-canonical storage (a symlink
 * spelling stores/resolves the REAL path), missing/malformed file reads as
 * empty, add is idempotent, remove round-trips.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { cleanup, freshEnv, type TempEnv } from './helpers/env.js';
import {
  canonicalDir,
  homeAbbrev,
  isTrustedDir,
  loadTrustedDirs,
  saveTrustedDirs,
  trustDir,
  trustedPath,
  untrustDir,
} from '../src/config/trust.js';

// trusted.json ACCUMULATES (a list, not an overwrite) — every test gets its
// own temp config dir so entries never leak across tests.
let env: TempEnv;
const envDirs: string[] = [];

beforeEach(() => {
  env = freshEnv();
  envDirs.push(env.dir);
});

afterAll(() => {
  for (const d of envDirs) cleanup(d);
});

/** A real temp dir, canonicalized (macOS tmpdir is a symlink). */
function realTempDir(prefix: string): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), prefix))); // .native = product canonicalization (8.3 long-form on Windows)
}

describe('trust store', () => {
  it('missing file reads as an empty list (and nothing is trusted)', () => {
    expect(existsSync(trustedPath())).toBe(false);
    expect(loadTrustedDirs()).toEqual([]);
    expect(isTrustedDir('/definitely/not/trusted')).toBe(false);
  });

  it('trust → persists → loads; the file is mode 0600', () => {
    const dir = realTempDir('selora-trust-');
    try {
      const stored = trustDir(dir);
      expect(stored).toBe(dir);
      expect(loadTrustedDirs()).toEqual([dir]);
      expect(isTrustedDir(dir)).toBe(true);

      // on-disk shape + permissions
      const raw = JSON.parse(readFileSync(trustedPath(), 'utf8')) as { trusted: string[] };
      expect(raw.trusted).toEqual([dir]);
      if (process.platform !== 'win32') {
        expect(statSync(trustedPath()).mode & 0o777).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stores the REAL path: trusting through a symlink records the target', () => {
    if (process.platform === 'win32') return; // symlinks need privileges there
    const real = realTempDir('selora-trust-real-');
    const link = join(env.dir, 'selora-trust-link');
    try {
      symlinkSync(real, link);
      const stored = trustDir(link);
      expect(stored).toBe(real);
      // both spellings recognize the folder
      expect(isTrustedDir(link)).toBe(true);
      expect(isTrustedDir(real)).toBe(true);
      // the list holds the canonical form only
      expect(loadTrustedDirs()).toEqual([real]);
    } finally {
      rmSync(link, { force: true });
      rmSync(real, { recursive: true, force: true });
    }
  });

  it('add is idempotent — no duplicate entries', () => {
    const dir = realTempDir('selora-trust-idem-');
    try {
      trustDir(dir);
      trustDir(dir);
      expect(loadTrustedDirs()).toEqual([dir]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove round-trips; removing an absent dir is a friendly no-op (null)', () => {
    const dir = realTempDir('selora-trust-rm-');
    try {
      trustDir(dir);
      expect(untrustDir(dir)).toBe(dir);
      expect(loadTrustedDirs()).toEqual([]);
      expect(untrustDir(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('relative input resolves against the process cwd', () => {
    const dir = realTempDir('selora-trust-rel-');
    const prev = process.cwd();
    try {
      process.chdir(dir);
      expect(trustDir('.')).toBe(dir);
      expect(isTrustedDir('.')).toBe(true);
      untrustDir('.');
    } finally {
      process.chdir(prev);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-existent path cannot be trusted (null, nothing written)', () => {
    const gone = join(env.dir, 'no-such-dir');
    expect(trustDir(gone)).toBeNull();
    expect(loadTrustedDirs()).toEqual([]);
  });

  it('malformed JSON reads as empty with a stderr warning — never a crash', () => {
    mkdirSync(join(env.xdg, 'selora'), { recursive: true });
    writeFileSync(trustedPath(), 'not json{', 'utf8');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(loadTrustedDirs()).toEqual([]);
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      spy.mockRestore();
      rmSync(trustedPath(), { force: true });
    }
  });

  it('a wrong-shape file (array, or non-string entries) reads as empty', () => {
    mkdirSync(join(env.xdg, 'selora'), { recursive: true });
    writeFileSync(trustedPath(), '["/x"]', 'utf8');
    expect(loadTrustedDirs()).toEqual([]);
    writeFileSync(trustedPath(), '{"trusted":["/ok", 42, null]}', 'utf8');
    expect(loadTrustedDirs()).toEqual(['/ok']);
    rmSync(trustedPath(), { force: true });
  });

  it('saveTrustedDirs writes an empty list honestly', () => {
    saveTrustedDirs([]);
    expect(loadTrustedDirs()).toEqual([]);
    expect(readFileSync(trustedPath(), 'utf8')).toContain('"trusted": []');
    rmSync(trustedPath(), { force: true });
  });

  it('canonicalDir resolves, and returns null for missing paths', () => {
    const dir = realTempDir('selora-trust-canon-');
    try {
      expect(canonicalDir(join(dir, '.'))).toBe(dir);
      expect(canonicalDir(join(dir, 'missing'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('homeAbbrev: ~ for $HOME-prefixed paths, verbatim otherwise', () => {
    const home = env.dir; // freshEnv points HOME here
    // join uses the PLATFORM separator: '~\proj' on Windows, '~/proj' on POSIX.
    expect(homeAbbrev(join(home, 'proj'))).toBe(`~${sep}proj`);
    expect(homeAbbrev('/usr/local/bin')).toBe('/usr/local/bin');
    expect(homeAbbrev(home)).toBe('~');
  });
});
