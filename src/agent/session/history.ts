/**
 * Prompt history for the chat REPL's Ctrl+R search (v0.9): the newest-first,
 * deduped list of what the user has actually SENT — the current session's
 * prompts first (they are the freshest), then every persisted session of this
 * project (the same `.selora/sessions/*.json` store `selora resume` reads,
 * newest update first; within a session the last user message is newest).
 *
 * Only single-line, non-empty user texts qualify: readline prompts are one
 * line by construction, and a stored multi-line text (possible from
 * `run --session` argv) could never be re-typed at the prompt, so it is
 * filtered out rather than inserted broken. Multimodal user messages yield
 * their text parts joined (image parts cannot be re-inserted by typing).
 *
 * Reads are defensive like the store itself: a malformed session file is
 * skipped, never a crash. The result is capped so opening the search stays
 * instant no matter how long the project has been used.
 */

import type { ChatMessage } from '../../api/endpoints/chat.js';
import { listSessions, loadSession } from './store.js';

/** Hard cap on the collected pool (the search menu caps its display anyway). */
export const HISTORY_POOL_CAP = 500;

/** Normalize a candidate: trimmed, non-empty, single-line — else null. */
function asSearchable(text: string): string | null {
  const t = text.trim();
  if (t === '' || t.includes('\n') || t.includes('\r')) return null;
  return t;
}

/** The searchable text of a message (user messages only), or null. */
export function promptTextFromMessage(msg: ChatMessage): string | null {
  if (msg.role !== 'user') return null;
  const content: unknown = msg.content;
  if (typeof content === 'string') return asSearchable(content);
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content as unknown[]) {
      const rec =
        typeof part === 'object' && part !== null ? (part as Record<string, unknown>) : null;
      if (rec !== null && rec['type'] === 'text' && typeof rec['text'] === 'string') {
        texts.push(rec['text']);
      }
    }
    return asSearchable(texts.join('\n'));
  }
  return null;
}

/**
 * Build the newest-first deduped prompt list. `sessionPrompts` is the live
 * session's sent prompts in send order (oldest first) — they lead the list.
 */
export function collectPromptHistory(
  root: string,
  sessionPrompts: readonly string[],
  cap: number = HISTORY_POOL_CAP,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (candidate: string | null): void => {
    if (candidate === null || seen.has(candidate)) return;
    seen.add(candidate);
    out.push(candidate);
  };
  for (let i = sessionPrompts.length - 1; i >= 0; i -= 1) {
    push(asSearchable(sessionPrompts[i]!));
  }
  for (const summary of listSessions(root)) {
    const session = loadSession(root, summary.name);
    if (session === null) continue;
    for (let i = session.messages.length - 1; i >= 0; i -= 1) {
      push(promptTextFromMessage(session.messages[i]!));
    }
  }
  return out.slice(0, cap);
}
