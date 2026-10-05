/**
 * Stored-key access on top of the config file. v0.1 has NO OS keyring (native
 * deps are not allowed), so the key lives in the 0600 config.json — a
 * documented trade-off, surfaced to the user at login time.
 * SELORA_API_KEY always wins and is never written to disk.
 */

import { loadConfig, saveConfig, configPath } from '../config/index.js';

export type KeySource = 'env' | 'file' | 'none';

export function getStoredKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const envKey = env['SELORA_API_KEY'];
  if (envKey !== undefined && envKey.trim() !== '') return envKey;
  const cfg = loadConfig(env);
  return cfg.apiKey !== undefined && cfg.apiKey !== '' ? cfg.apiKey : undefined;
}

/** Where the effective key came from — used for honest logout messaging. */
export function storedKeySource(env: NodeJS.ProcessEnv = process.env): KeySource {
  const envKey = env['SELORA_API_KEY'];
  if (envKey !== undefined && envKey.trim() !== '') return 'env';
  const cfg = loadConfig(env);
  return cfg.apiKey !== undefined && cfg.apiKey !== '' ? 'file' : 'none';
}

export function storeKey(key: string, env: NodeJS.ProcessEnv = process.env): void {
  const cfg = loadConfig(env);
  saveConfig({ ...cfg, apiKey: key }, env);
}

export function clearStoredKey(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = loadConfig(env);
  if (cfg.apiKey === undefined) return false;
  const next = { ...cfg };
  delete next.apiKey;
  saveConfig(next, env);
  return true;
}

/** Human-facing path of the key store (for the "where is it stored" note). */
export function keyStorePath(env: NodeJS.ProcessEnv = process.env): string {
  return configPath(env);
}
