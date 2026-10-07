/**
 * Config layer: XDG-style config dir + config.json (mode 0600) + resolution
 * precedence. The v0.1 key storage lives in this file (no OS keyring — no
 * native deps allowed); that is a documented, deliberate trade-off, not a
 * hidden one. SELORA_API_KEY always wins over the file and is never written
 * to disk. v1.3 adds the diff / permissions / history sections — parsed with
 * per-field warn-and-ignore (a bad field warns on stderr and is skipped;
 * valid siblings are honored).
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface ConfigFile {
  apiUrl?: string;
  apiKey?: string;
  defaultModel?: string;
  /** UI theme: 'galaxy' (default), 'nebula', 'aurora', or 'mono' (no colors). */
  theme?: string;
  /** v0.3: opt-in for the web tools (web_search/web_fetch talk to non-gateway hosts). */
  webTools?: boolean;
  /** v1.3: diff system settings (the "diff" object in config.json). */
  diff?: {
    view?: string; // 'unified' | 'split' | 'auto'
    context?: number; // 0..20
    maxLines?: number; // 0..100000
    palette?: string; // 'classic' | 'colorblind' | 'mono'
    syntaxHighlight?: boolean;
    wordDiff?: boolean;
    showWhitespace?: boolean;
    collapseGenerated?: boolean;
    secretScan?: boolean;
  };
  /** v1.3: permissions.mode — 'ask' | 'auto' | 'dry-run'. */
  permissions?: { mode?: string };
  /** v1.3: history.maxSizeMB — 1..1024. */
  history?: { maxSizeMB?: number };
}

export interface Settings {
  apiUrl: string;
  apiKey: string | undefined;
}

export const DEFAULT_API_URL = 'https://api.selora.lol';

const CONFIG_FILENAME = 'config.json';

/** Resolve the config directory: XDG_CONFIG_HOME/selora, else ~/.config/selora. */
export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  // XDG_CONFIG_HOME wins on EVERY platform when set to an absolute path — it is
  // the most specific override (tests rely on it; power users may set it on
  // Windows too). A relative XDG value is ignored per spec.
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg !== undefined && xdg.trim() !== '' && isAbsolute(xdg)) {
    return join(xdg, 'selora');
  }
  // Windows native convention: %APPDATA%\selora.
  if (process.platform === 'win32' && env['APPDATA'] && env['APPDATA'].trim() !== '') {
    return join(env['APPDATA'], 'selora');
  }
  return join(homedir(), '.config', 'selora');
}

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(configDir(env), CONFIG_FILENAME);
}

function pickString(rec: Record<string, unknown>, key: string): string | undefined {
  const v = Object.hasOwn(rec, key) ? rec[key] : undefined;
  return typeof v === 'string' ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Integer within [min, max], else undefined (NaN / fractional / non-number → undefined). */
function intInRange(v: unknown, min: number, max: number): number | undefined {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

const DIFF_BOOLEAN_KEYS = [
  'syntaxHighlight',
  'wordDiff',
  'showWhitespace',
  'collapseGenerated',
  'secretScan',
] as const;

/**
 * Parse the v1.3 "diff" object: per-field warn-and-ignore (a bad field is
 * skipped, valid siblings are still honored), unknown keys ignored silently.
 * A non-object section is ignored wholesale (silently, like project.ts).
 * Undefined when no field survives, so an empty/bad section leaves no trace.
 */
function parseDiffSection(v: unknown): ConfigFile['diff'] {
  const d = rec(v);
  if (d === null) return undefined;
  const diff: NonNullable<ConfigFile['diff']> = {};
  if (Object.hasOwn(d, 'view')) {
    const val = d['view'];
    if (val === 'unified' || val === 'split' || val === 'auto') {
      diff.view = val;
    } else {
      console.error(`· Ignoring diff.view — must be 'unified', 'split' or 'auto'.`);
    }
  }
  if (Object.hasOwn(d, 'context')) {
    const val = intInRange(d['context'], 0, 20);
    if (val !== undefined) {
      diff.context = val;
    } else {
      console.error('· Ignoring diff.context — must be an integer between 0 and 20.');
    }
  }
  if (Object.hasOwn(d, 'maxLines')) {
    const val = intInRange(d['maxLines'], 0, 100_000);
    if (val !== undefined) {
      diff.maxLines = val;
    } else {
      console.error('· Ignoring diff.maxLines — must be an integer between 0 and 100000.');
    }
  }
  if (Object.hasOwn(d, 'palette')) {
    const val = d['palette'];
    if (val === 'classic' || val === 'colorblind' || val === 'mono') {
      diff.palette = val;
    } else {
      console.error(`· Ignoring diff.palette — must be 'classic', 'colorblind' or 'mono'.`);
    }
  }
  for (const key of DIFF_BOOLEAN_KEYS) {
    if (Object.hasOwn(d, key)) {
      const val = d[key];
      if (typeof val === 'boolean') {
        diff[key] = val;
      } else {
        console.error(`· Ignoring diff.${key} — must be a boolean.`);
      }
    }
  }
  return Object.keys(diff).length > 0 ? diff : undefined;
}

/** Parse the v1.3 "permissions" object (mode only; unknown keys ignored). */
function parsePermissionsSection(v: unknown): ConfigFile['permissions'] {
  const p = rec(v);
  if (p === null) return undefined;
  const permissions: NonNullable<ConfigFile['permissions']> = {};
  if (Object.hasOwn(p, 'mode')) {
    const val = p['mode'];
    if (val === 'ask' || val === 'auto' || val === 'dry-run') {
      permissions.mode = val;
    } else {
      console.error(`· Ignoring permissions.mode — must be 'ask', 'auto' or 'dry-run'.`);
    }
  }
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}

/** Parse the v1.3 "history" object (maxSizeMB only; unknown keys ignored). */
function parseHistorySection(v: unknown): ConfigFile['history'] {
  const h = rec(v);
  if (h === null) return undefined;
  const history: NonNullable<ConfigFile['history']> = {};
  if (Object.hasOwn(h, 'maxSizeMB')) {
    const val = intInRange(h['maxSizeMB'], 1, 1024);
    if (val !== undefined) {
      history.maxSizeMB = val;
    } else {
      console.error('· Ignoring history.maxSizeMB — must be an integer between 1 and 1024.');
    }
  }
  return Object.keys(history).length > 0 ? history : undefined;
}

/**
 * Read config.json. Malformed JSON (or a non-object) is treated as an empty
 * config plus a warning on stderr — never a crash. Known scalar fields are
 * honored; the v1.3 diff/permissions/history sections are validated per field
 * (bad fields warn + are skipped, valid siblings survive); anything else is
 * ignored.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ConfigFile {
  let text: string;
  try {
    text = readFileSync(configPath(env), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`· Ignoring malformed ${CONFIG_FILENAME} — treat it as empty.`);
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    console.error(`· Ignoring malformed ${CONFIG_FILENAME} — treat it as empty.`);
    return {};
  }
  const rec = parsed as Record<string, unknown>;
  const cfg: ConfigFile = {};
  const apiUrl = pickString(rec, 'apiUrl');
  if (apiUrl !== undefined) cfg.apiUrl = apiUrl;
  const apiKey = pickString(rec, 'apiKey');
  if (apiKey !== undefined) cfg.apiKey = apiKey;
  const defaultModel = pickString(rec, 'defaultModel');
  if (defaultModel !== undefined) cfg.defaultModel = defaultModel;
  const theme = pickString(rec, 'theme');
  if (theme !== undefined) cfg.theme = theme;
  if (Object.hasOwn(rec, 'webTools')) cfg.webTools = rec['webTools'] === true;
  const diff = parseDiffSection(Object.hasOwn(rec, 'diff') ? rec['diff'] : undefined);
  if (diff !== undefined) cfg.diff = diff;
  const permissions = parsePermissionsSection(
    Object.hasOwn(rec, 'permissions') ? rec['permissions'] : undefined,
  );
  if (permissions !== undefined) cfg.permissions = permissions;
  const history = parseHistorySection(Object.hasOwn(rec, 'history') ? rec['history'] : undefined);
  if (history !== undefined) cfg.history = history;
  return cfg;
}

/**
 * Write config.json atomically (tmp file + rename) with mode 0600
 * (best-effort on Windows). Parent dirs are created as needed.
 */
export function saveConfig(config: ConfigFile, env: NodeJS.ProcessEnv = process.env): void {
  const dir = configDir(env);
  mkdirSync(dir, { recursive: true });
  const target = join(dir, CONFIG_FILENAME);
  const tmp = join(dir, `.${CONFIG_FILENAME}.tmp-${randomUUID()}`);
  const text = `${JSON.stringify(config, null, 2)}\n`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Windows / unusual filesystems — best effort.
  }
  renameSync(tmp, target);
  // Existing file may predate this write with looser perms (rename replaces
  // it with the 0600 tmp, but be explicit if the target survived somehow).
  try {
    const st = statSync(target);
    if ((st.mode & 0o777) !== 0o600) chmodSync(target, 0o600);
  } catch {
    // best effort
  }
}

/** True when config.json exists on disk. */
export function configExists(env: NodeJS.ProcessEnv = process.env): boolean {
  return existsSync(configPath(env));
}

/**
 * Resolution precedence: SELORA_API_URL env > config.apiUrl > default.
 * SELORA_API_KEY env > config.apiKey.
 */
export function resolveSettings(
  env: NodeJS.ProcessEnv = process.env,
  config: ConfigFile = loadConfig(env),
): Settings {
  const envUrl = env['SELORA_API_URL'];
  const envKey = env['SELORA_API_KEY'];
  return {
    apiUrl:
      envUrl !== undefined && envUrl.trim() !== '' ? envUrl : (config.apiUrl ?? DEFAULT_API_URL),
    apiKey: envKey !== undefined && envKey.trim() !== '' ? envKey : config.apiKey,
  };
}
