/**
 * Agent session persistence: conversation state (the wire-shaped message
 * history, including tool calls and results) saved under
 * `<project root>/.selora/sessions/<name>.json` — project-local, visible,
 * gitignore-able. Sessions advance ONLY on completed runs: a run that dies
 * mid-stream never writes (a half-finished turn would corrupt the history).
 *
 * Names are validated to a conservative slug set (letters, digits, dash,
 * underscore, dot; must start alphanumeric; 1-64 chars) so a session name can
 * never traverse out of the sessions directory. Parsing is defensive like
 * every config reader: a malformed file is reported and ignored, never a
 * crash.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ChatMessage } from '../../api/endpoints/chat.js';

export const SESSIONS_DIR = '.selora/sessions';
export const SESSION_VERSION = 1;

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface StoredSession {
  version: 1;
  name: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  /** The wire-shaped conversation (user / assistant / tool messages). */
  messages: ChatMessage[];
}

export interface SessionSummary {
  name: string;
  model: string;
  updatedAt: string;
  messageCount: number;
}

export function sessionNameOk(name: string): boolean {
  return NAME_RE.test(name);
}

export function sessionsDir(root: string): string {
  return join(root, SESSIONS_DIR);
}

export function sessionPath(root: string, name: string): string {
  return join(sessionsDir(root), `${name}.json`);
}

/** A fresh session object for a first run. */
export function newSession(name: string, model: string): StoredSession {
  const now = new Date().toISOString();
  return { version: SESSION_VERSION, name, model, createdAt: now, updatedAt: now, messages: [] };
}

/** Parse a session file's contents; null (with a stderr note) when malformed. */
function parseSession(text: string, path: string): StoredSession | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`· Ignoring malformed session file ${path}`);
    return null;
  }
  const rec =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  if (rec === null) {
    console.error(`· Ignoring malformed session file ${path}`);
    return null;
  }
  const name = typeof rec['name'] === 'string' ? rec['name'] : '';
  const model = typeof rec['model'] === 'string' ? rec['model'] : '';
  const createdAt = typeof rec['createdAt'] === 'string' ? rec['createdAt'] : '';
  const updatedAt = typeof rec['updatedAt'] === 'string' ? rec['updatedAt'] : '';
  const messages = Array.isArray(rec['messages']) ? rec['messages'] : null;
  if (name === '' || model === '' || createdAt === '' || updatedAt === '' || messages === null) {
    console.error(`· Ignoring malformed session file ${path}`);
    return null;
  }
  return {
    version: SESSION_VERSION,
    name,
    model,
    createdAt,
    updatedAt,
    messages: messages as ChatMessage[],
  };
}

/** Load a session by name; null when it does not exist (or is unreadable). */
export function loadSession(root: string, name: string): StoredSession | null {
  const path = sessionPath(root, name);
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  return parseSession(text, path);
}

/**
 * Save a session atomically (tmp + rename). `updatedAt` is refreshed. Returns
 * the written path.
 */
export function saveSession(root: string, session: StoredSession): string {
  const dir = sessionsDir(root);
  mkdirSync(dir, { recursive: true });
  const body: StoredSession = { ...session, updatedAt: new Date().toISOString() };
  const target = sessionPath(root, body.name);
  const tmp = join(dir, `.${body.name}.tmp-${randomUUID()}`);
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  renameSync(tmp, target);
  return target;
}

/** Delete a session; false when it did not exist. */
export function deleteSession(root: string, name: string): boolean {
  const path = sessionPath(root, name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/** List the project's sessions, newest update first. */
export function listSessions(root: string): SessionSummary[] {
  const dir = sessionsDir(root);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json') && !n.startsWith('.'));
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const file of names) {
    const name = file.slice(0, -'.json'.length);
    const s = loadSession(root, name);
    if (s !== null)
      out.push({ name, model: s.model, updatedAt: s.updatedAt, messageCount: s.messages.length });
  }
  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return out;
}
