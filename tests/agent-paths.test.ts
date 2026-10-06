/**
 * Path sandbox tests: root containment (absolute, relative, `..` climbs),
 * symlink resolution (existing targets AND new files through symlinked
 * directories), the 256 KB cap constant, and exclude-glob resolution from
 * selora.json (including the shipped defaults and the include-is-advisory
 * behavior).
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * macOS note: tmpdir() may sit behind a symlink (/var → /private/var); the path
 * sandbox resolves the project root to its realpath, so tests hand it the real
 * path up front.
 */
function tempRealRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'selora-paths-')));
}
import {
  effectiveExcludeGlobs,
  isExcludedRel,
  MAX_TOOL_FILE_BYTES,
  pathExists,
  resolveToolPath,
  statPath,
} from '../src/agent/paths.js';
import { projectConfigPath } from '../src/config/project.js';

describe('resolveToolPath — containment', () => {
  it('relative paths resolve against the root; absolute paths must be inside it', () => {
    const dir = tempRealRoot();
    try {
      const rel = resolveToolPath(dir, 'src/a.ts');
      expect(rel.ok).toBe(true);
      if (rel.ok) {
        // rel is '/'-separated on every platform (see paths.ts)
        expect(rel.rel).toBe('src/a.ts');
        expect(pathExists(rel.abs)).toBe(false);
      }
      const absInside = resolveToolPath(dir, join(dir, 'b.ts'));
      expect(absInside.ok).toBe(true);
      const absOutside = resolveToolPath(dir, join(dir, '..', 'escape.ts'));
      expect(absOutside.ok).toBe(false);
      if (!absOutside.ok) expect(absOutside.error).toContain('escapes the project root');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('.. climbs are refused; NUL bytes and non-strings are refused honestly', () => {
    const dir = tempRealRoot();
    try {
      const climb = resolveToolPath(dir, 'a/../../escape');
      expect(climb.ok).toBe(false);
      const deep = resolveToolPath(dir, 'a/../b');
      expect(deep.ok).toBe(true); // a/.. cancels — still inside
      for (const bad of [undefined, 42, '', '   ', 'a\0b', { path: 'x' }]) {
        const res = resolveToolPath(dir, bad);
        expect(res.ok).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('symlinks are resolved and re-contained (POSIX)', () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges there
    const outer = mkdtempSync(join(tmpdir(), 'selora-paths-'));
    try {
      const root = join(outer, 'proj');
      const secret = join(outer, 'secret');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(secret, { recursive: true });
      writeFileSync(join(secret, 'outside.txt'), 'x', 'utf8');
      // a symlink to a FILE outside the root
      symlinkSync(join(secret, 'outside.txt'), join(root, 'link.txt'));
      // a symlinked DIRECTORY outside the root, with a not-yet-existing file
      symlinkSync(secret, join(root, 'linkdir'));

      const viaFile = resolveToolPath(root, 'link.txt');
      expect(viaFile.ok).toBe(false);
      if (!viaFile.ok) expect(viaFile.error).toContain('outside the project root');

      // the new-file-through-symlinked-directory case must ALSO be refused
      const viaDir = resolveToolPath(root, join('linkdir', 'new.txt'));
      expect(viaDir.ok).toBe(false);
      if (!viaDir.ok) expect(viaDir.error).toContain('outside the project root');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('statPath and the size cap constant', () => {
    expect(MAX_TOOL_FILE_BYTES).toBe(256 * 1024);
    const dir = tempRealRoot();
    try {
      writeFileSync(join(dir, 'f.txt'), 'hello', 'utf8');
      const st = statPath(join(dir, 'f.txt'));
      expect(st).toEqual({ size: 5, isFile: true });
      expect(statPath(join(dir, 'missing'))).toBeNull();
      expect(statPath(dir)!.isFile).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exclude globs', () => {
  it('uses the project selora.json context.exclude when present', () => {
    const dir = tempRealRoot();
    try {
      const exclude = ['**', 'node_modules', '**'].join('/');
      writeFileSync(
        projectConfigPath(dir),
        JSON.stringify({ version: 1, context: { include: ['src/**'], exclude: [exclude, 'secrets/**'] } }),
        'utf8',
      );
      expect(effectiveExcludeGlobs(dir)).toEqual([exclude, 'secrets/**']);
      expect(isExcludedRel('node_modules/a/b', [exclude])).toBe(true);
      expect(isExcludedRel('a/node_modules/b', [exclude])).toBe(true);
      expect(isExcludedRel('src/a.ts', [exclude])).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to the shipped defaults (node_modules + dist) with no selora.json', () => {
    const dir = tempRealRoot();
    try {
      const excl = effectiveExcludeGlobs(dir);
      expect(excl).toEqual([
        ['**', 'node_modules', '**'].join('/'),
        ['**', 'dist', '**'].join('/'),
      ]);
      expect(isExcludedRel('dist/index.js', excl)).toBe(true);
      expect(isExcludedRel('src/index.ts', excl)).toBe(false);
      // include globs are ADVISORY: package.json (outside src/**) is not excluded
      expect(isExcludedRel('package.json', excl)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
