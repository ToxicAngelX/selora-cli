/**
 * Glob matcher + walk unit tests: fnmatch-style `*`, `**`, `?`, `[...]`
 * semantics, the zero-or-more-segments behavior of `**` before a separator,
 * trailing `**`, class ranges/negation, degraded-literal behavior on bad
 * patterns, and the capped walk with exclude pruning.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { globToRegExp, MAX_WALK_ENTRIES, walkTree } from '../src/agent/tools/glob.js';

function matches(pattern: string, path: string): boolean {
  return globToRegExp(pattern).test(path);
}

describe('glob matcher — * and ? (within a segment)', () => {
  it('* matches any chars except the separator', () => {
    expect(matches('*.ts', 'a.ts')).toBe(true);
    expect(matches('*.ts', 'src/a.ts')).toBe(false);
    expect(matches('*', 'src')).toBe(true);
    expect(matches('a*c', 'abc')).toBe(true);
    expect(matches('a*c', 'ac')).toBe(true);
    expect(matches('a*c', 'a/c')).toBe(false);
  });

  it('? matches exactly one non-separator char', () => {
    expect(matches('a?c', 'abc')).toBe(true);
    expect(matches('a?c', 'ac')).toBe(false);
    expect(matches('a?c', 'a/c')).toBe(false);
  });

  it('literals match exactly; leading ./ and trailing / are tolerated', () => {
    expect(matches('package.json', 'package.json')).toBe(true);
    expect(matches('package.json', 'package-lock.json')).toBe(false);
    expect(matches('./src', 'src')).toBe(true);
    expect(matches('src/', 'src')).toBe(true);
  });
});

describe('glob matcher — ** across segments', () => {
  it('a trailing ** matches everything below', () => {
    expect(matches('src/**', 'src/a.ts')).toBe(true);
    expect(matches('src/**', 'src/sub/b.ts')).toBe(true);
    expect(matches('src/**', 'src')).toBe(false);
    expect(matches('src/**', 'other/a.ts')).toBe(false);
  });

  it('** before a separator matches zero or more whole directories', () => {
    expect(matches('src/**/*.ts', 'src/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'src/sub/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'src/sub/deep/a.ts')).toBe(true);
    expect(matches('src/**/*.ts', 'other/a.ts')).toBe(false);
  });

  it('a leading ** + segment matches at any depth including zero', () => {
    const p = ['**', 'node_modules', '**'].join('/');
    expect(matches(p, 'node_modules/x')).toBe(true);
    expect(matches(p, 'node_modules/x/y')).toBe(true);
    expect(matches(p, 'a/node_modules/b')).toBe(true);
    expect(matches(p, 'a/b/node_modules/c/d')).toBe(true);
    expect(matches(p, 'not_node_modules/x')).toBe(false);
  });

  it('a bare ** matches everything', () => {
    expect(matches('**', 'a')).toBe(true);
    expect(matches('**', 'a/b/c')).toBe(true);
  });
});

describe('glob matcher — character classes', () => {
  it('classes, ranges, and negation', () => {
    expect(matches('[abc].ts', 'a.ts')).toBe(true);
    expect(matches('[abc].ts', 'd.ts')).toBe(false);
    expect(matches('[a-z][0-9].txt', 'x7.txt')).toBe(true);
    expect(matches('[a-z][0-9].txt', 'X7.txt')).toBe(false); // case-sensitive
    expect(matches('[!a].ts', 'b.ts')).toBe(true);
    expect(matches('[!a].ts', 'a.ts')).toBe(false);
    expect(matches('[^a].ts', 'b.ts')).toBe(true);
  });

  it('a leading ] inside a class is literal', () => {
    expect(matches('[]x].ts', '].ts')).toBe(true);
    expect(matches('[]x].ts', 'x.ts')).toBe(true);
    expect(matches('[]x].ts', 'y.ts')).toBe(false);
  });

  it('unclosed or regex-invalid classes degrade to literal matching, never throw', () => {
    expect(matches('a[.ts', 'a[.ts')).toBe(true);
    expect(matches('a[.ts', 'ab.ts')).toBe(false);
    expect(globToRegExp('a[z-a]')).toBeInstanceOf(RegExp); // invalid range: flattens
    expect(matches('[]', '[]')).toBe(true);
  });
});

describe('walkTree', () => {
  it('walks depth-first in sorted order, prunes excluded directories, flags truncation', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'selora-glob-'));
    try {
      // src/{a.ts,b.ts,sub/{c.ts}} + node_modules/x/y.js + dist/o.js + out.txt
      mkdirSync(join(dir, 'src', 'sub'), { recursive: true });
      mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
      mkdirSync(join(dir, 'dist'), { recursive: true });
      writeFileSync(join(dir, 'src', 'a.ts'), 'a', 'utf8');
      writeFileSync(join(dir, 'src', 'b.ts'), 'b', 'utf8');
      writeFileSync(join(dir, 'src', 'sub', 'c.ts'), 'c', 'utf8');
      writeFileSync(join(dir, 'node_modules', 'x', 'y.js'), 'y', 'utf8');
      writeFileSync(join(dir, 'dist', 'o.js'), 'o', 'utf8');
      writeFileSync(join(dir, 'out.txt'), 'out', 'utf8');

      const excl = [['**', 'node_modules', '**'].join('/'), ['**', 'dist', '**'].join('/')];
      const walk = await walkTree({ root: dir, exclude: excl });
      expect(walk.truncated).toBe(false);
      expect(walk.entries.map((e) => e.rel)).toEqual(['out.txt', 'src/a.ts', 'src/b.ts', 'src/sub/c.ts']);

      // no excludes: everything is visible
      const all = await walkTree({ root: dir, exclude: [] });
      expect(all.entries.map((e) => e.rel)).toEqual([
        'dist/o.js',
        'node_modules/x/y.js',
        'out.txt',
        'src/a.ts',
        'src/b.ts',
        'src/sub/c.ts',
      ]);

      // maxEntries stops the walk honestly
      const capped = await walkTree({ root: dir, exclude: [], maxEntries: 2 });
      expect(capped.truncated).toBe(true);
      expect(capped.entries).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the entry cap constant is the documented 5000', () => {
    expect(MAX_WALK_ENTRIES).toBe(5000);
  });
});
