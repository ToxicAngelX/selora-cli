/**
 * Project-local selora.json — DISTINCT from the global XDG config.json. The
 * file stores the project's model choice, context globs, and (v0.2) agent
 * settings. `selora init` writes model + context; the optional "agent"
 * section is hand-edited — init does not write it.
 *
 * Reading is defensive (the /root defect class): malformed JSON or wrong
 * shapes degrade to a warning on stderr + an ignored file — never a crash.
 * Unknown fields are ignored.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_CONFIG_FILENAME = 'selora.json';

/** File-format version — bump only on a breaking shape change. */
export const PROJECT_CONFIG_VERSION = 1;

/** Context globs `selora init` writes for the agent. */
export const DEFAULT_CONTEXT_INCLUDE: readonly string[] = ['src/**/*', 'docs/**/*.md'];
export const DEFAULT_CONTEXT_EXCLUDE: readonly string[] = ['**/node_modules/**', '**/dist/**'];

export interface ProjectContextGlobs {
  include: string[];
  exclude: string[];
}

/** Agent settings from the optional selora.json "agent" object. */
export interface ProjectAgentConfig {
  /** Agent loop turn cap (1-200). Absent: the loop's default (25). */
  maxTurns?: number;
  /** Opt-in for run_command on Windows (default: refused). */
  allowWindowsCmd?: boolean;
}

export interface ProjectConfig {
  /** The project's model choice (non-empty string on disk). */
  model?: string;
  /** Present only when both include/exclude are well-formed string arrays. */
  context?: ProjectContextGlobs;
  /** Present only when at least one agent field is well-formed. */
  agent?: ProjectAgentConfig;
}

export function projectConfigPath(cwd: string): string {
  return join(cwd, PROJECT_CONFIG_FILENAME);
}

function warnMalformed(): void {
  console.error(`· Ignoring malformed ${PROJECT_CONFIG_FILENAME} — treat it as absent.`);
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** A string array with no non-string entries — else undefined (never invented). */
function stringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/**
 * Read + validate selora.json from `cwd`. Missing file → {}. Malformed JSON,
 * a non-object root, or wrong field shapes → a stderr warning and the file is
 * ignored (fields that ARE valid are still honored). Extra fields are ignored.
 */
export function loadProjectConfig(cwd: string): ProjectConfig {
  let text: string;
  try {
    text = readFileSync(projectConfigPath(cwd), 'utf8');
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnMalformed();
    return {};
  }
  const root = rec(parsed);
  if (root === null) {
    warnMalformed();
    return {};
  }
  const cfg: ProjectConfig = {};
  const model = Object.hasOwn(root, 'model') ? root['model'] : undefined;
  if (typeof model === 'string' && model !== '') cfg.model = model;
  const c = rec(Object.hasOwn(root, 'context') ? root['context'] : undefined);
  if (c !== null) {
    const include = stringArray(Object.hasOwn(c, 'include') ? c['include'] : undefined);
    const exclude = stringArray(Object.hasOwn(c, 'exclude') ? c['exclude'] : undefined);
    // Both sides must be well-formed string arrays — no invented empty halves.
    if (include !== undefined && exclude !== undefined) {
      cfg.context = { include, exclude };
    }
  }
  const a = rec(Object.hasOwn(root, 'agent') ? root['agent'] : undefined);
  if (a !== null) {
    const agent: ProjectAgentConfig = {};
    if (Object.hasOwn(a, 'maxTurns')) {
      const v = a['maxTurns'];
      if (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 200) {
        agent.maxTurns = v;
      } else {
        console.error('· Ignoring agent.maxTurns — must be an integer between 1 and 200.');
      }
    }
    if (Object.hasOwn(a, 'allowWindowsCmd')) {
      if (typeof a['allowWindowsCmd'] === 'boolean') {
        agent.allowWindowsCmd = a['allowWindowsCmd'];
      } else {
        console.error('· Ignoring agent.allowWindowsCmd — must be a boolean.');
      }
    }
    if (Object.keys(agent).length > 0) cfg.agent = agent;
  }
  return cfg;
}

/** The exact v0.1 file body `selora init` writes (2-space indent, trailing newline). */
export function projectConfigJson(model: string): string {
  const body = {
    version: PROJECT_CONFIG_VERSION,
    model,
    context: { include: DEFAULT_CONTEXT_INCLUDE, exclude: DEFAULT_CONTEXT_EXCLUDE },
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** Write selora.json into `cwd` (plain project file — not secret, no 0600). */
export function saveProjectConfig(cwd: string, model: string): string {
  const target = projectConfigPath(cwd);
  writeFileSync(target, projectConfigJson(model), 'utf8');
  return target;
}
