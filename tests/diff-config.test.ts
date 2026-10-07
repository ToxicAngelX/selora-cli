/**
 * diff-config tests — the CONFIG layer of the diff subsystem.
 *
 * resolveDiffConfig: precedence defaults ← file ← flags, defensive silent
 * revalidation of in-memory ConfigFile values, dry-run override, fresh object
 * per call. loadConfig (v1.3 sections): real config.json files in a temp
 * XDG_CONFIG_HOME — valid sections parsed, per-field warn-and-ignore with
 * valid siblings honored, wrong-typed sections ignored wholesale, unknown
 * keys silent. Pure temp dirs — no network, no mock server.
 */

import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configPath, loadConfig } from '../src/config/index.js';
import type { ConfigFile } from '../src/config/index.js';
import { resolveDiffConfig } from '../src/config/diff.js';
import type { DiffCliFlags } from '../src/config/diff.js';
import { DEFAULT_DIFF_CONFIG } from '../src/diff/types.js';

// --- temp-XDG harness (same env-injection pattern as tests/config.test.ts) ---

function tempEnv(): { dir: string; xdg: string } {
  const dir = mkdtempSync(join(tmpdir(), 'selora-diffcfg-'));
  const xdg = join(dir, 'xdg');
  process.env['XDG_CONFIG_HOME'] = xdg;
  return { dir, xdg };
}

function writeConfig(xdg: string, text: string): void {
  mkdirSync(join(xdg, 'selora'), { recursive: true });
  writeFileSync(configPath(), text, 'utf8');
}

function cleanupEnv(dir: string): void {
  delete process.env['XDG_CONFIG_HOME'];
  rmSync(dir, { recursive: true, force: true });
}

/** Capture console.error lines for the duration of a test (restore in finally). */
function spyErrors(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    messages.push(args.map(String).join(' '));
  });
  return {
    messages,
    restore: () => {
      spy.mockRestore();
    },
  };
}

// ---------------------------------------------------------------------------
// resolveDiffConfig
// ---------------------------------------------------------------------------

describe('resolveDiffConfig', () => {
  it('empty file → the defaults (deep equal, fresh object, defaults unmutated)', () => {
    const resolved = resolveDiffConfig({});
    expect(resolved).toEqual(DEFAULT_DIFF_CONFIG);
    expect(resolved).not.toBe(DEFAULT_DIFF_CONFIG);
    // Overriding through the resolver must never leak into the shared defaults.
    resolveDiffConfig({ diff: { view: 'split', context: 9 }, permissions: { mode: 'auto' } });
    expect(DEFAULT_DIFF_CONFIG).toEqual({
      view: 'auto',
      context: 3,
      maxLines: 300,
      palette: 'classic',
      syntaxHighlight: true,
      wordDiff: true,
      showWhitespace: false,
      collapseGenerated: true,
      secretScan: true,
      reviewMode: 'ask',
      historyMaxSizeMB: 50,
    });
  });

  it('merges a full file section (every field overridden)', () => {
    const file: ConfigFile = {
      diff: {
        view: 'split',
        context: 7,
        maxLines: 500,
        palette: 'colorblind',
        syntaxHighlight: false,
        wordDiff: false,
        showWhitespace: true,
        collapseGenerated: false,
        secretScan: false,
      },
      permissions: { mode: 'auto' },
      history: { maxSizeMB: 128 },
    };
    expect(resolveDiffConfig(file)).toEqual({
      view: 'split',
      context: 7,
      maxLines: 500,
      palette: 'colorblind',
      syntaxHighlight: false,
      wordDiff: false,
      showWhitespace: true,
      collapseGenerated: false,
      secretScan: false,
      reviewMode: 'auto',
      historyMaxSizeMB: 128,
    });
  });

  it('precedence: flags beat file beat default', () => {
    const file: ConfigFile = { diff: { view: 'split', context: 9, maxLines: 42 } };
    // file beats default
    expect(resolveDiffConfig(file).view).toBe('split');
    // flag beats file; untouched file fields still win over the default
    const flags: DiffCliFlags = { diffView: 'unified' };
    const resolved = resolveDiffConfig(file, flags);
    expect(resolved.view).toBe('unified');
    expect(resolved.context).toBe(9);
    expect(resolved.maxLines).toBe(42);
    expect(resolved.palette).toBe('classic');
    // explicit false from --no-syntax-highlight is a real override, not "absent"
    const noSyn = resolveDiffConfig({}, { syntaxHighlight: false, showWhitespace: true });
    expect(noSyn.syntaxHighlight).toBe(false);
    expect(noSyn.showWhitespace).toBe(true);
  });

  it('dryRun flag → reviewMode dry-run, beating file permissions.mode', () => {
    const file: ConfigFile = { permissions: { mode: 'auto' } };
    expect(resolveDiffConfig(file, { dryRun: true }).reviewMode).toBe('dry-run');
    // without the flag the file mode stands
    expect(resolveDiffConfig(file).reviewMode).toBe('auto');
    // dryRun: false does not force anything
    expect(resolveDiffConfig(file, { dryRun: false }).reviewMode).toBe('auto');
  });

  it('file permissions.mode dry-run is honored without flags', () => {
    expect(resolveDiffConfig({ permissions: { mode: 'dry-run' } }).reviewMode).toBe('dry-run');
    expect(resolveDiffConfig({ permissions: { mode: 'ask' } }).reviewMode).toBe('ask');
  });

  it('defensive: out-of-range / wrong-typed file fields fall back, valid siblings honored', () => {
    const file = {
      diff: {
        view: 'bogus' as never,
        context: 99 as never,
        maxLines: -1 as never,
        palette: 'neon' as never,
        syntaxHighlight: 'yes' as never,
        wordDiff: false,
        showWhitespace: true,
      },
      permissions: { mode: 'yolo' as never },
      history: { maxSizeMB: 0 as never },
    } satisfies ConfigFile;
    const resolved = resolveDiffConfig(file);
    // bad fields → defaults
    expect(resolved.view).toBe(DEFAULT_DIFF_CONFIG.view);
    expect(resolved.context).toBe(DEFAULT_DIFF_CONFIG.context);
    expect(resolved.maxLines).toBe(DEFAULT_DIFF_CONFIG.maxLines);
    expect(resolved.palette).toBe(DEFAULT_DIFF_CONFIG.palette);
    expect(resolved.syntaxHighlight).toBe(DEFAULT_DIFF_CONFIG.syntaxHighlight);
    expect(resolved.reviewMode).toBe(DEFAULT_DIFF_CONFIG.reviewMode);
    expect(resolved.historyMaxSizeMB).toBe(DEFAULT_DIFF_CONFIG.historyMaxSizeMB);
    // valid siblings still honored
    expect(resolved.wordDiff).toBe(false);
    expect(resolved.showWhitespace).toBe(true);
  });

  it('defensive: non-integer numbers fall back to defaults', () => {
    const file = {
      diff: { context: 2.5 as never, maxLines: Number.NaN as never },
      history: { maxSizeMB: 1.5 as never },
    } satisfies ConfigFile;
    const resolved = resolveDiffConfig(file);
    expect(resolved.context).toBe(DEFAULT_DIFF_CONFIG.context);
    expect(resolved.maxLines).toBe(DEFAULT_DIFF_CONFIG.maxLines);
    expect(resolved.historyMaxSizeMB).toBe(DEFAULT_DIFF_CONFIG.historyMaxSizeMB);
  });

  it('boundary values honored; just outside falls back', () => {
    expect(
      resolveDiffConfig({
        diff: { context: 0, maxLines: 0 },
        history: { maxSizeMB: 1 },
      }),
    ).toMatchObject({ context: 0, maxLines: 0, historyMaxSizeMB: 1 });
    expect(
      resolveDiffConfig({
        diff: { context: 20, maxLines: 100_000 },
        history: { maxSizeMB: 1024 },
      }),
    ).toMatchObject({ context: 20, maxLines: 100_000, historyMaxSizeMB: 1024 });
    expect(
      resolveDiffConfig({
        diff: { context: 21, maxLines: 100_001 },
        history: { maxSizeMB: 1025 },
      }),
    ).toMatchObject({ context: 3, maxLines: 300, historyMaxSizeMB: 50 });
  });

  it('invalid flag values fall back silently (no warning from the resolver)', () => {
    const spy = spyErrors();
    try {
      const resolved = resolveDiffConfig(
        {},
        { diffView: 'bogus', diffPalette: 'neon', diffMaxLines: -5, diffContext: 21 },
      );
      expect(resolved).toEqual(DEFAULT_DIFF_CONFIG);
      expect(spy.messages).toEqual([]);
    } finally {
      spy.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — v1.3 diff / permissions / history sections
// ---------------------------------------------------------------------------

describe('loadConfig diff sections', () => {
  it('parses a full valid config.json and resolves end-to-end', () => {
    const { dir, xdg } = tempEnv();
    try {
      writeConfig(
        xdg,
        JSON.stringify({
          apiKey: 'sk-gw-TESTabc',
          diff: {
            view: 'split',
            context: 5,
            maxLines: 1000,
            palette: 'mono',
            syntaxHighlight: false,
            wordDiff: false,
            showWhitespace: true,
            collapseGenerated: false,
            secretScan: false,
          },
          permissions: { mode: 'dry-run' },
          history: { maxSizeMB: 256 },
        }),
      );
      const cfg = loadConfig();
      expect(cfg).toEqual({
        apiKey: 'sk-gw-TESTabc',
        diff: {
          view: 'split',
          context: 5,
          maxLines: 1000,
          palette: 'mono',
          syntaxHighlight: false,
          wordDiff: false,
          showWhitespace: true,
          collapseGenerated: false,
          secretScan: false,
        },
        permissions: { mode: 'dry-run' },
        history: { maxSizeMB: 256 },
      });
      // integration: the parsed file flows straight into the resolver
      expect(resolveDiffConfig(cfg)).toEqual({
        view: 'split',
        context: 5,
        maxLines: 1000,
        palette: 'mono',
        syntaxHighlight: false,
        wordDiff: false,
        showWhitespace: true,
        collapseGenerated: false,
        secretScan: false,
        reviewMode: 'dry-run',
        historyMaxSizeMB: 256,
      });
    } finally {
      cleanupEnv(dir);
    }
  });

  it('malformed JSON → unchanged behavior (empty config + warning)', () => {
    const { dir, xdg } = tempEnv();
    const spy = spyErrors();
    try {
      writeConfig(xdg, '{not json!!');
      expect(loadConfig()).toEqual({});
      expect(spy.messages).toEqual(['· Ignoring malformed config.json — treat it as empty.']);
    } finally {
      spy.restore();
      cleanupEnv(dir);
    }
  });

  it('per-field warnings: bad fields skipped, valid siblings honored', () => {
    const { dir, xdg } = tempEnv();
    const spy = spyErrors();
    try {
      writeConfig(
        xdg,
        JSON.stringify({
          diff: {
            view: 'bogus',
            context: 99,
            maxLines: 100,
            palette: 'neon',
            syntaxHighlight: 'yes',
            wordDiff: false,
          },
          permissions: { mode: 'yolo' },
          history: { maxSizeMB: 0 },
        }),
      );
      const cfg = loadConfig();
      // valid siblings survive; sections with no surviving field leave no trace
      expect(cfg.diff).toEqual({ maxLines: 100, wordDiff: false });
      expect(cfg.permissions).toBeUndefined();
      expect(cfg.history).toBeUndefined();
      expect(spy.messages).toContain(
        `· Ignoring diff.view — must be 'unified', 'split' or 'auto'.`,
      );
      expect(spy.messages).toContain(
        '· Ignoring diff.context — must be an integer between 0 and 20.',
      );
      expect(spy.messages).toContain(
        `· Ignoring diff.palette — must be 'classic', 'colorblind' or 'mono'.`,
      );
      expect(spy.messages).toContain('· Ignoring diff.syntaxHighlight — must be a boolean.');
      expect(spy.messages).toContain(
        `· Ignoring permissions.mode — must be 'ask', 'auto' or 'dry-run'.`,
      );
      expect(spy.messages).toContain(
        '· Ignoring history.maxSizeMB — must be an integer between 1 and 1024.',
      );
      expect(spy.messages).toHaveLength(6);
    } finally {
      spy.restore();
      cleanupEnv(dir);
    }
  });

  it('wrong-typed sections (diff: "nope") are ignored wholesale and silently', () => {
    const { dir, xdg } = tempEnv();
    const spy = spyErrors();
    try {
      writeConfig(
        xdg,
        '{"diff": "nope", "permissions": 42, "history": [1], "theme": "mono", "apiKey": "k"}',
      );
      expect(loadConfig()).toEqual({ theme: 'mono', apiKey: 'k' });
      expect(spy.messages).toEqual([]);
    } finally {
      spy.restore();
      cleanupEnv(dir);
    }
  });

  it('unknown keys inside sections are ignored silently; empty sections leave no trace', () => {
    const { dir, xdg } = tempEnv();
    const spy = spyErrors();
    try {
      writeConfig(
        xdg,
        JSON.stringify({
          diff: { view: 'split', futureKnob: true, another: { nested: 1 } },
          permissions: { mode: 'ask', extra: 1 },
          history: {},
        }),
      );
      const cfg = loadConfig();
      expect(cfg.diff).toEqual({ view: 'split' });
      expect(cfg.permissions).toEqual({ mode: 'ask' });
      expect(cfg.history).toBeUndefined();
      expect(spy.messages).toEqual([]);
    } finally {
      spy.restore();
      cleanupEnv(dir);
    }
  });

  it('a file without the v1.3 sections parses exactly as before', () => {
    const { dir, xdg } = tempEnv();
    const spy = spyErrors();
    try {
      writeConfig(xdg, '{"apiUrl": "http://x.test", "apiKey": "k", "webTools": true}');
      expect(loadConfig()).toEqual({ apiUrl: 'http://x.test', apiKey: 'k', webTools: true });
      expect(spy.messages).toEqual([]);
    } finally {
      spy.restore();
      cleanupEnv(dir);
    }
  });
});
