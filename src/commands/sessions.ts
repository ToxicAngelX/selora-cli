/**
 * `selora sessions [list|show|rm] [name]` — manage the agent's project-local
 * conversation sessions (.selora/sessions/<name>.json, written by
 * `selora run --session <name>`).
 *
 *  - list (default): name, model, message count, last update — newest first
 *  - show <name>: render the stored conversation. Each message is truncated
 *    to 400 chars for display (the full history stays in the file), and the
 *    rendered text passes through the redaction chokepoint — key material an
 *    agent may have read into the conversation never prints
 *  - rm <name>: delete, with a y/N confirm interactively; --yes is required
 *    when stdin is not a TTY
 *
 * --json prints machine shapes; show's JSON carries the FULL messages (like
 * chat/run content, unredacted — it is data the user's own key fetched).
 */

import type { CliContext } from '../context.js';
import { Renderer } from '../terminal/render.js';
import { redact } from '../api/redact.js';
import { createPrompter } from '../auth/prompts.js';
import {
  deleteSession,
  listSessions,
  loadSession,
  sessionNameOk,
  sessionsDir,
} from '../agent/session/store.js';

export interface SessionsFlags {
  yes?: boolean;
  /** Project root (defaults to process.cwd()). */
  cwd?: string | undefined;
}

const DISPLAY_TRUNCATE = 400;

export async function runSessions(
  ctx: CliContext,
  action: string | undefined,
  name: string | undefined,
  flags: SessionsFlags,
): Promise<void> {
  const r = new Renderer({
    out: ctx.io.out,
    err: ctx.io.err,
    rawOut: ctx.io.writeOut,
    rawErr: ctx.io.writeErr,
    json: ctx.json,
    debug: ctx.debug,
  });
  const cwd = flags.cwd ?? process.cwd();
  const what = action ?? 'list';

  if (what === 'list') {
    const sessions = listSessions(cwd);
    if (ctx.json) {
      r.jsonOut({
        ok: true,
        sessions: sessions.map((s) => ({
          name: s.name,
          model: s.model,
          updatedAt: s.updatedAt,
          messages: s.messageCount,
        })),
      });
      return;
    }
    if (sessions.length === 0) {
      r.bullet(`no sessions in this project — start one: selora run --session <name> "<prompt>"`);
      return;
    }
    r.line(`Sessions in ${sessionsDir(cwd)} (newest first):`);
    for (const s of sessions) {
      r.field(s.name, `${s.model} · ${s.messageCount} messages · updated ${s.updatedAt}`, 0);
    }
    return;
  }

  if (what === 'show' || what === 'rm') {
    if (name === undefined || name.trim() === '' || !sessionNameOk(name)) {
      process.exitCode = 1;
      const message = `Usage: selora sessions ${what} <name>`;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }
    const session = loadSession(cwd, name);
    if (session === null) {
      process.exitCode = 1;
      const message = `no session named "${name}" in this project`;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }

    if (what === 'show') {
      if (ctx.json) {
        r.jsonOut({ ok: true, ...session });
        return;
      }
      r.field('name', session.name, 12);
      r.field('model', session.model, 12);
      r.field('created', session.createdAt, 12);
      r.field('updated', session.updatedAt, 12);
      r.field('messages', String(session.messages.length), 12);
      r.divider();
      for (const m of session.messages) {
        renderMessage(r, m);
      }
      return;
    }

    // rm
    if (ctx.json) {
      if (flags.yes !== true) {
        process.exitCode = 1;
        r.jsonOut({
          ok: false,
          error: { kind: 'internal', message: 'confirmation required — pass --yes' },
        });
        return;
      }
      deleteSession(cwd, name);
      r.jsonOut({ ok: true, deleted: true, name });
      return;
    }
    let confirmed = flags.yes === true;
    if (!confirmed) {
      if (!ctx.io.isTTY) {
        process.exitCode = 1;
        r.fail('confirmation required — pass --yes');
        return;
      }
      const prompter = createPrompter({
        stdin: ctx.io.stdin,
        isTTY: ctx.io.isTTY,
        err: ctx.io.err,
      });
      try {
        confirmed = await prompter.confirm(`Delete session "${name}"?`);
      } finally {
        prompter.close();
      }
    }
    if (!confirmed) {
      r.bullet('not deleted');
      return;
    }
    deleteSession(cwd, name);
    r.ok(`Deleted session ${name}`);
    return;
  }

  process.exitCode = 1;
  const message = `unknown action "${what}" — use: list, show, or rm`;
  if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
  else r.fail(message);
}

/** One stored message as a role-labeled block, truncated + redacted. */
function renderMessage(r: Renderer, m: unknown): void {
  const rec = typeof m === 'object' && m !== null ? (m as Record<string, unknown>) : {};
  const role = typeof rec['role'] === 'string' ? rec['role'] : '?';
  let text: string;
  if (role === 'tool') {
    const id = typeof rec['tool_call_id'] === 'string' ? rec['tool_call_id'] : '?';
    text = `[${id}] ${contentText(rec['content'])}`;
  } else if (role === 'assistant' && Array.isArray(rec['tool_calls'])) {
    const rawCalls = rec['tool_calls'] as unknown[];
    const calls = rawCalls
      .map((c) => {
        const cr = typeof c === 'object' && c !== null ? (c as Record<string, unknown>) : {};
        const fn =
          typeof cr['function'] === 'object' && cr['function'] !== null
            ? (cr['function'] as Record<string, unknown>)
            : {};
        const fname = typeof fn['name'] === 'string' ? fn['name'] : '?';
        return `${fname}(${typeof fn['arguments'] === 'string' ? fn['arguments'] : ''})`;
      })
      .join(', ');
    text = `${contentText(rec['content'])} — tool calls: ${calls}`;
  } else {
    text = contentText(rec['content']);
  }
  const truncated =
    text.length > DISPLAY_TRUNCATE ? `${text.slice(0, DISPLAY_TRUNCATE)}… (truncated)` : text;
  const lines = redact(truncated).split('\n');
  r.field(role, lines[0] ?? '', 10);
  for (const line of lines.slice(1)) r.line(`${' '.repeat(10)}${line}`);
}

function contentText(v: unknown): string {
  return typeof v === 'string' ? v : v === null ? '(no content)' : String(v);
}
