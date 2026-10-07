/**
 * Permission modes (v0.5) — the chat REPL's answer to Claude Code's mode
 * line. Four modes, cycled with shift+tab at the prompt:
 *
 *   manual       — every tool call asks (the classic behavior).
 *   acceptEdits  — reads and file edits run without asking; exec (shell)
 *                  commands and anything OUTSIDE the project root still ask.
 *   auto         — every tool runs without asking… except tools flagged
 *                  neverAutoAllow (remove): deletions ALWAYS ask, in every
 *                  mode. That carve-out is deliberate: a mode is one
 *                  keystroke away, so it must be impossible to stumble into
 *                  an unattended delete. (--yes on `run` is the explicit,
 *                  stronger commitment and keeps its legacy semantics.)
 *                  Outside-root paths auto-answer with plain `allow` here;
 *                  the loop grants the touched directory for the session on
 *                  ANY approved outside answer (v0.8), so the real run
 *                  proceeds exactly like the --yes path.
 *   plan (v0.9)  — read/search tools run without asking; every MUTATING
 *                  tool (kind !== 'read') is never executed: the agent loop
 *                  denies it with PLAN_MODE_DENY_REASON and records the
 *                  tool's label in the session's plan list (the `/plan`
 *                  command shows it). The denial itself lives in the loop
 *                  (it owns the plan list) — the asker here only auto-allows
 *                  the reads, so a plan mode without a loop gate degrades to
 *                  "reads run, mutations ask" (asking is always safe).
 *
 * The mode is a REPL-layer concept: createModeAsker WRAPS the interactive
 * asker and answers auto-allowable requests itself, delegating everything
 * else. The agent loop and its --yes/--json paths are untouched.
 *
 * The status line (`⏸ manual mode on · ? for shortcuts`) is plain text —
 * the caller styles it (chat dims it).
 */

import type { ToolKind } from './tool.js';
import type { PermissionAnswer, PermissionAsker, PermissionRequest } from './permissions.js';

export type PermissionMode = 'manual' | 'acceptEdits' | 'auto' | 'plan';

/** shift+tab cycles in this order, wrapping. (v0.9: plan joined the cycle.) */
export const MODE_CYCLE: readonly PermissionMode[] = ['manual', 'acceptEdits', 'auto', 'plan'];

/**
 * The exact reason text a plan-mode denial carries back to the model (the
 * loop builds "Permission denied by user. Reason: <this>" like any other
 * reasoned denial) — and the chat UI shows the proposal in the plan list.
 */
export const PLAN_MODE_DENY_REASON =
  'plan mode: proposal recorded — switch modes (shift+tab) to execute';

export function nextMode(mode: PermissionMode): PermissionMode {
  const i = MODE_CYCLE.indexOf(mode);
  return MODE_CYCLE[(i + 1) % MODE_CYCLE.length]!;
}

/**
 * The one-line mode status for the prompt block. `safe` is display-only
 * (--safe restricts the toolset to read-only tools; there is nothing to
 * cycle because write/exec tools do not exist in the session).
 */
export function modeStatusLine(mode: PermissionMode | 'safe'): string {
  switch (mode) {
    case 'manual':
      return '⏸ manual mode on · ? for shortcuts';
    case 'acceptEdits':
      return '⏵⏵ accept edits on · ? for shortcuts';
    case 'auto':
      return '⏵⏵ auto mode on · ? for shortcuts';
    case 'plan':
      return '◈ plan mode on · ? for shortcuts';
    case 'safe':
      return '⏸ safe mode on (read-only tools) · ? for shortcuts';
  }
}

/**
 * May this request run WITHOUT asking in the given mode? Deletions
 * (neverAutoAllow) always ask; acceptEdits covers non-exec tools inside the
 * project root only; auto covers everything else; plan covers in-project
 * reads only (mutations are denied by the loop before they ever reach an
 * asker — see the module doc).
 */
export function modeAutoAllows(mode: PermissionMode, req: PermissionRequest): boolean {
  if (req.neverAlways === true) return false;
  if (mode === 'auto') return true;
  if (mode === 'acceptEdits') {
    const kind: ToolKind = req.kind;
    return kind !== 'exec' && req.outsidePath === undefined;
  }
  if (mode === 'plan') {
    return req.kind === 'read' && req.outsidePath === undefined;
  }
  return false;
}

/**
 * Wrap `base` (the interactive asker) with mode-aware auto-allow. The wrap
 * is re-evaluated PER REQUEST against getMode(), so shift+tab mid-session
 * takes effect on the very next tool call. askDetailed mirrors ask — the
 * loop prefers it when present.
 */
export function createModeAsker(
  base: PermissionAsker,
  getMode: () => PermissionMode,
): PermissionAsker {
  const autoAllows = (req: PermissionRequest): boolean => modeAutoAllows(getMode(), req);
  return {
    ask: async (req) => {
      if (autoAllows(req)) return 'allow';
      return base.ask(req);
    },
    askDetailed:
      base.askDetailed !== undefined
        ? async (req): Promise<PermissionAnswer> => {
            if (autoAllows(req)) return { decision: 'allow' };
            return base.askDetailed!(req);
          }
        : undefined,
    replacement: (current) => base.replacement(current),
  };
}
