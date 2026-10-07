/**
 * `selora resume [name]` — reopen a saved conversation in the chat REPL.
 *
 * With no name, the most recently updated session in the project's
 * `.selora/sessions/` (that is usually the auto-saved `chat` session a crash
 * or /exit left behind). With a name, exactly that one — the same files
 * `selora run --session <name>` writes. The REPL opens with the full history
 * restored (wire-shaped: user/assistant/tool messages, images included) and
 * keeps auto-saving under the SAME name; the session's model is used unless
 * --model overrides it.
 *
 * There is deliberately no picker and no silent magic: bare `selora chat`
 * offers the one-line resume question, `selora resume` is the explicit form.
 * Non-interactive stdin can't host a REPL, so it gets chat's honest
 * needs-a-terminal error; `--json` only covers the pre-REPL failures.
 */

import type { CliContext } from '../context.js';
import { Renderer } from '../terminal/render.js';
import { listSessions, loadSession, sessionNameOk } from '../agent/session/store.js';
import { runChat } from './chat.js';

export interface ResumeFlags {
  model?: string | undefined;
  /** Restrict the agent to read-only tools. */
  safe?: boolean;
  /** Auto-approve tool execution (non-interactive; still filtered by --safe). */
  yes?: boolean;
  /** Project root (defaults to process.cwd()). */
  cwd?: string | undefined;
  /** v1.3: show proposed changes without writing. */
  dryRun?: boolean;
  /** v1.3: diff layout override (unified|split|auto). */
  diffView?: string | undefined;
  /** v1.3: diff palette override (classic|colorblind|mono). */
  diffPalette?: string | undefined;
}

const NAME_RULE =
  'session name must be 1-64 chars: letters, digits, dash, underscore, dot (alphanumeric first)';

export async function runResume(
  ctx: CliContext,
  name: string | undefined,
  flags: ResumeFlags,
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

  let target: string;
  if (name !== undefined && name.trim() !== '') {
    if (!sessionNameOk(name)) {
      process.exitCode = 1;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message: NAME_RULE } });
      else r.fail(NAME_RULE);
      return;
    }
    if (loadSession(cwd, name) === null) {
      process.exitCode = 1;
      const message = `no session named "${name}" in this project`;
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.fail(message);
      return;
    }
    target = name;
  } else {
    // listSessions is newest-first — the most recent conversation with actual
    // content wins (a /cleared session is not worth resuming).
    const sessions = listSessions(cwd).filter((s) => s.messageCount > 0);
    if (sessions.length === 0) {
      process.exitCode = 1;
      const message =
        'no sessions in this project — start one: selora chat, or selora run --session <name> "<prompt>"';
      if (ctx.json) r.jsonOut({ ok: false, error: { kind: 'internal', message } });
      else r.bullet(message);
      return;
    }
    target = sessions[0]!.name;
  }

  await runChat(ctx, {
    model: flags.model,
    safe: flags.safe === true,
    yes: flags.yes === true,
    cwd,
    resumeName: target,
    dryRun: flags.dryRun === true,
    diffView: flags.diffView,
    diffPalette: flags.diffPalette,
  });
}
