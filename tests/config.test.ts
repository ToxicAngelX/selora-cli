import { describe, expect, it } from 'vitest';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  configDir,
  configPath,
  loadConfig,
  resolveSettings,
  saveConfig,
  DEFAULT_API_URL,
} from '../src/config/index.js';

function tempEnv(): { dir: string; xdg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'selora-cfg-'));
  const xdg = join(dir, 'xdg');
  process.env['XDG_CONFIG_HOME'] = xdg;
  return { dir, xdg };
}

describe('config', () => {
  it('uses XDG_CONFIG_HOME/selora when set', () => {
    const { dir, xdg } = tempEnv();
    try {
      expect(configDir()).toBe(join(xdg, 'selora'));
      expect(configPath()).toBe(join(xdg, 'selora', 'config.json'));
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The ~/.config fallback is a POSIX convention; on Windows without XDG the
  // APPDATA path is used instead (covered by its own guard below).
  it.skipIf(process.platform === 'win32')('falls back to ~/.config/selora without XDG', () => {
    const dir = mkdtempSync(join(tmpdir(), 'selora-home-'));
    const prev = process.env['XDG_CONFIG_HOME'];
    const home = process.env['HOME'];
    try {
      delete process.env['XDG_CONFIG_HOME'];
      process.env['HOME'] = dir;
      // homedir() reads env.HOME on POSIX — assert against our temp home.
      expect(configPath()).toBe(join(dir, '.config', 'selora', 'config.json'));
    } finally {
      if (prev !== undefined) process.env['XDG_CONFIG_HOME'] = prev;
      if (home !== undefined) process.env['HOME'] = home;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig returns {} for a missing file', () => {
    const { dir } = tempEnv();
    try {
      expect(loadConfig()).toEqual({});
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig treats malformed JSON as empty (no crash)', () => {
    const { dir, xdg } = tempEnv();
    try {
      mkdirSync(join(xdg, 'selora'), { recursive: true });
      writeFileSync(configPath(), '{not json!!', 'utf8');
      expect(loadConfig()).toEqual({});
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig ignores non-string and unknown fields', () => {
    const { dir, xdg } = tempEnv();
    try {
      mkdirSync(join(xdg, 'selora'), { recursive: true });
      writeFileSync(configPath(), '{"apiUrl": 5, "apiKey": "k", "junk": true}', 'utf8');
      expect(loadConfig()).toEqual({ apiKey: 'k' });
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saveConfig writes 0600 atomically and round-trips', () => {
    const { dir, xdg } = tempEnv();
    try {
      saveConfig({ apiUrl: 'http://x.test', apiKey: 'sk-gw-TESTabc' });
      const st = statSync(configPath());
      // Windows fs.chmod can only toggle the read-only bit — 0600 is a POSIX
      // guarantee; on win32 the round-trip below still runs.
      if (process.platform !== 'win32') expect(st.mode & 0o777).toBe(0o600);
      expect(loadConfig()).toEqual({ apiUrl: 'http://x.test', apiKey: 'sk-gw-TESTabc' });
      // no leftover tmp files
      expect(readdirSync(join(xdg, 'selora'))).toEqual(['config.json']);
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolution precedence: env > file > default', () => {
    const { dir } = tempEnv();
    try {
      saveConfig({ apiUrl: 'http://from-file.test' });
      // file beats default
      expect(resolveSettings().apiUrl).toBe('http://from-file.test');
      // env beats file
      process.env['SELORA_API_URL'] = 'http://from-env.test';
      expect(resolveSettings().apiUrl).toBe('http://from-env.test');
      // default when nothing set
      delete process.env['SELORA_API_URL'];
      saveConfig({});
      expect(resolveSettings().apiUrl).toBe(DEFAULT_API_URL);
      // api key: env beats file
      saveConfig({ apiKey: 'sk-gw-TESTfile' });
      expect(resolveSettings().apiKey).toBe('sk-gw-TESTfile');
      process.env['SELORA_API_KEY'] = 'sk-gw-TESTenv';
      expect(resolveSettings().apiKey).toBe('sk-gw-TESTenv');
      expect(resolveSettings().apiKey).not.toBe('sk-gw-TESTfile');
    } finally {
      delete process.env['XDG_CONFIG_HOME'];
      delete process.env['SELORA_API_URL'];
      delete process.env['SELORA_API_KEY'];
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
