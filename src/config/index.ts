/**
 * Config layer: XDG-style config dir + config.json (mode 0600) + resolution
 * precedence. The v0.1 key storage lives in this file (no OS keyring — no
 * native deps allowed); that is a documented, deliberate trade-off, not a
 * hidden one. SELORA_API_KEY always wins over the file and is never written
 * to disk.
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

/**
 * Read config.json. Malformed JSON (or a non-object) is treated as an empty
 * config plus a warning on stderr — never a crash. Only known string fields
 * are honored; anything else is ignored.
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
