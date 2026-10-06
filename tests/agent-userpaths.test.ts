/**
 * User path resolution tests: env/~ expansion, the three aliases (with the
 * Windows OneDrive redirect), project-relative shadowing rules, root
 * containment with symlinks, outside-root resolution (the v0.3 permission
 * flow), isInsideAny/grantDirFor, and the honest refusals. Everything runs
 * hermetically on any host platform — env/home/exists/platform are injected
 * so POSIX tests simulate win32 exactly.
 */

import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  expandPathVars,
  grantDirFor,
  isInsideAny,
  PATH_ALIASES,
  resolveAliasDir,
  resolveUserPath,
} from '../src/agent/userPaths.js';

/** macOS note: the sandbox realpaths the root, so tests hand it the real path. */
function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'selora-userpaths-')));
}

describe('expandPathVars', () => {
  it('expands $VAR, ${VAR}, and %VAR%; unknown vars are left as written', () => {
    const env = { HOME: '/users/ada', PROJECT: 'nebula', APPDATA: 'C:\\Data' };
    expect(expandPathVars('$HOME/x', { env })).toBe('/users/ada/x');
    expect(expandPathVars('${PROJECT}/src', { env })).toBe('nebula/src');
    expect(expandPathVars('%APPDATA%\\selora', { env })).toBe('C:\\Data\\selora');
    expect(expandPathVars('$MISSING/x', { env })).toBe('$MISSING/x');
    expect(expandPathVars('plain/path.ts', { env })).toBe('plain/path.ts');
  });
});

describe('resolveAliasDir', () => {
  it('POSIX: $HOME/<Name> when it exists; null-ish fallback when nothing exists', () => {
    const dir = tempRoot();
    try {
      mkdirSync(join(dir, 'Desktop'), { recursive: true });
      expect(
        resolveAliasDir('desktop', { home: dir, exists: (p) => p === join(dir, 'Desktop') }),
      ).toBe(join(dir, 'Desktop'));
      // unknown alias → null
      expect(resolveAliasDir('pictures', { home: dir })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Windows: OneDrive redirect wins over USERPROFILE when it exists', () => {
    const env = { USERPROFILE: 'C:\\Users\\ada', OneDrive: 'C:\\Users\\ada\\OneDrive' };
    const exists = (p: string): boolean => p === 'C:\\Users\\ada\\OneDrive\\Desktop';
    expect(
      resolveAliasDir('desktop', { env, home: 'C:\\Users\\ada', exists, platform: 'win32' }),
    ).toBe('C:\\Users\\ada\\OneDrive\\Desktop');
    // without OneDrive existing, USERPROFILE\Desktop is the answer
    expect(
      resolveAliasDir('downloads', {
        env: { USERPROFILE: 'C:\\Users\\ada' },
        home: 'C:\\Users\\ada',
        exists: () => false,
        platform: 'win32',
      }),
    ).toBe('C:\\Users\\ada\\Downloads');
    expect(PATH_ALIASES).toEqual(['desktop', 'downloads', 'documents']);
  });
});

describe('resolveUserPath — inside the project root', () => {
  it('relative paths resolve against the root; rel is /-separated', () => {
    const dir = tempRoot();
    try {
      const res = resolveUserPath(dir, 'src/a.ts');
      expect(res.ok).toBe(true);
      if (res.ok && res.inside) {
        expect(res.rel).toBe('src/a.ts');
        expect(res.abs).toBe(join(dir, 'src', 'a.ts'));
      }
      const abs = resolveUserPath(dir, join(dir, 'b.ts'));
      expect(abs.ok && abs.inside).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bad input is refused honestly (non-string, empty, NUL)', () => {
    const dir = tempRoot();
    try {
      for (const bad of [undefined, 42, '', '   ', 'a\0b']) {
        const res = resolveUserPath(dir, bad);
        expect(res.ok).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('symlinks inside the root are real pathed — a link pointing OUT is outside, not followed', () => {
    if (process.platform === 'win32') return; // symlink creation needs privileges there
    const outer = mkdtempSync(join(tmpdir(), 'selora-userpaths-'));
    try {
      const root = join(outer, 'proj');
      const secret = join(outer, 'secret');
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(secret, { recursive: true });
      symlinkSync(secret, join(root, 'linkdir'));
      const viaDir = resolveUserPath(root, join('linkdir', 'x.txt'));
      expect(viaDir.ok && viaDir.inside === false).toBe(true);
      // an inside link still resolves inside
      symlinkSync(join(root, 'src'), join(root, 'src-link'));
      const res = resolveUserPath(root, 'src-link/a.ts');
      expect(res.ok && res.inside && res.abs).toBe(join(root, 'src', 'a.ts'));
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('a real project-relative folder shadows the alias of the same name', () => {
    const dir = tempRoot();
    try {
      mkdirSync(join(dir, 'desktop'), { recursive: true });
      writeFileSync(join(dir, 'desktop', 'a.txt'), 'x', 'utf8');
      const res = resolveUserPath(dir, 'desktop/a.txt');
      expect(res.ok && res.inside && res.rel).toBe('desktop/a.txt');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveUserPath — outside the project root', () => {
  it('~, aliases, absolute paths, and .. climbs all resolve to realpathed OUTSIDE paths', () => {
    const outer = mkdtempSync(join(tmpdir(), 'selora-userpaths-'));
    try {
      const root = join(outer, 'proj');
      mkdirSync(root, { recursive: true });
      const home = join(outer, 'home');
      const desktop = join(home, 'Desktop');
      mkdirSync(desktop, { recursive: true });
      const exists = (p: string): boolean => p === desktop;

      const viaAlias = resolveUserPath(root, 'desktop/Projects', { home, exists });
      expect(viaAlias.ok && viaAlias.inside === false && viaAlias.abs).toBe(
        join(desktop, 'Projects'),
      );
      const viaTilde = resolveUserPath(root, '~/Desktop/notes.txt', { home, exists });
      expect(viaTilde.ok && viaTilde.inside === false && viaTilde.abs).toBe(
        join(desktop, 'notes.txt'),
      );
      const viaAbs = resolveUserPath(root, join(desktop, 'x.txt'), { home, exists });
      expect(viaAbs.ok && viaAbs.inside === false && viaAbs.abs).toBe(join(desktop, 'x.txt'));
      const viaClimb = resolveUserPath(root, '../elsewhere/x.txt', { home, exists });
      expect(viaClimb.ok && viaClimb.inside === false && viaClimb.abs).toBe(
        join(outer, 'elsewhere', 'x.txt'),
      );
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('win32: drive paths and the OneDrive alias resolve outside (simulated on POSIX)', () => {
    const root = 'C:\\proj';
    const env = { USERPROFILE: 'C:\\Users\\ada', OneDrive: 'C:\\Users\\ada\\OneDrive' };
    const exists = (p: string): boolean => p === 'C:\\Users\\ada\\OneDrive\\Desktop';
    const viaAlias = resolveUserPath(root, 'desktop/Projects', {
      env,
      home: 'C:\\Users\\ada',
      exists,
      platform: 'win32',
    });
    expect(viaAlias.ok && viaAlias.inside === false && viaAlias.abs).toBe(
      'C:\\Users\\ada\\OneDrive\\Desktop\\Projects',
    );
    const viaDrive = resolveUserPath(root, 'D:\\data\\x.txt', {
      env,
      home: 'C:\\Users\\ada',
      exists,
      platform: 'win32',
    });
    expect(viaDrive.ok && viaDrive.inside === false && viaDrive.abs).toBe('D:\\data\\x.txt');
  });
});

describe('session allow helpers', () => {
  it('isInsideAny is prefix-exact (a sibling with a shared prefix is NOT inside)', () => {
    const dirs = ['C:\\Users\\ada\\Desktop'];
    expect(isInsideAny(dirs, 'C:\\Users\\ada\\Desktop\\Projects', 'win32')).toBe(true);
    expect(isInsideAny(dirs, 'C:\\Users\\ada\\Desktop', 'win32')).toBe(true);
    expect(isInsideAny(dirs, 'C:\\Users\\ada\\DesktopStuff\\x', 'win32')).toBe(false);
    expect(isInsideAny([], 'C:\\anything', 'win32')).toBe(false);
  });

  it('grantDirFor: an existing dir grants itself; a not-yet-existing target grants its parent', () => {
    const dir = tempRoot();
    try {
      mkdirSync(join(dir, 'Projects'), { recursive: true });
      expect(grantDirFor(join(dir, 'Projects'))).toBe(join(dir, 'Projects'));
      expect(grantDirFor(join(dir, 'Projects', 'deep'))).toBe(join(dir, 'Projects'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
