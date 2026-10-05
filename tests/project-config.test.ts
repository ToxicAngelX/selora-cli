/**
 * loadProjectConfig unit tests: missing / malformed / valid / extra-fields
 * files, wrong shapes ignored, the exact init file round-trips. Pure temp
 * directories — no network, no mock server.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadProjectConfig,
  projectConfigJson,
  projectConfigPath,
  saveProjectConfig,
} from '../src/config/project.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'selora-proj-'));
}

function writeProject(dir: string, text: string): void {
  writeFileSync(projectConfigPath(dir), text, 'utf8');
}

describe('loadProjectConfig', () => {
  it('missing file → {} (no crash, no warning path hit)', () => {
    const dir = tempDir();
    try {
      expect(loadProjectConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('malformed JSON → warning + ignore (never crash)', () => {
    const dir = tempDir();
    try {
      writeProject(dir, '{not json');
      expect(loadProjectConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('non-object root (array / number) → ignored', () => {
    for (const bad of ['[]', '42', '"x"', 'null']) {
      const dir = tempDir();
      try {
        writeProject(dir, bad);
        expect(loadProjectConfig(dir)).toEqual({});
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it('valid file → model + context', () => {
    const dir = tempDir();
    try {
      writeProject(
        dir,
        JSON.stringify({
          version: 1,
          model: 'gpt-5.2-mini',
          context: { include: ['src/**/*'], exclude: ['**/dist/**'] },
        }),
      );
      expect(loadProjectConfig(dir)).toEqual({
        model: 'gpt-5.2-mini',
        context: { include: ['src/**/*'], exclude: ['**/dist/**'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('extra/unknown fields are ignored; version is not surfaced', () => {
    const dir = tempDir();
    try {
      writeProject(
        dir,
        JSON.stringify({
          version: 1,
          model: 'glm-5.3-flash',
          future: { agent: true },
          context: { include: ['a'], exclude: ['b'], extra: 1 },
        }),
      );
      expect(loadProjectConfig(dir)).toEqual({
        model: 'glm-5.3-flash',
        context: { include: ['a'], exclude: ['b'] },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wrong shapes degrade honestly: bad model ignored, half-shaped context dropped entirely', () => {
    const dir = tempDir();
    try {
      writeProject(
        dir,
        JSON.stringify({
          version: 1,
          model: 123,
          context: { include: ['src/**/*'] }, // exclude missing → whole context ignored
        }),
      );
      expect(loadProjectConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('empty-string model and non-string array entries are ignored', () => {
    const dir = tempDir();
    try {
      writeProject(
        dir,
        JSON.stringify({
          model: '',
          context: { include: ['a', 5], exclude: ['b'] },
        }),
      );
      expect(loadProjectConfig(dir)).toEqual({});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveProjectConfig writes the exact v0.1 shape and it round-trips', () => {
    const dir = tempDir();
    try {
      const path = saveProjectConfig(dir, 'glm-5.3-flash');
      expect(path).toBe(projectConfigPath(dir));
      // exact body: 2-space indent, trailing newline, spec-exact globs
      const text = readFileSync(path, 'utf8');
      expect(text).toBe(projectConfigJson('glm-5.3-flash'));
      expect(text.endsWith('\n')).toBe(true);
      expect(JSON.parse(text)).toEqual({
        version: 1,
        model: 'glm-5.3-flash',
        context: {
          include: ['src/**/*', 'docs/**/*.md'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      });
      // and it reads back
      expect(loadProjectConfig(dir)).toEqual({
        model: 'glm-5.3-flash',
        context: {
          include: ['src/**/*', 'docs/**/*.md'],
          exclude: ['**/node_modules/**', '**/dist/**'],
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
