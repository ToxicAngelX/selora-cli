/**
 * The agent loop (v0.2 — docs/agent.md). One `selora run` with tools:
 *
 *   stream a completion (tools attached) → if the model actually requested
 *   tools on the wire, decode the accumulated calls → resolve each against
 *   the tool registry → PERMISSION GATE (dry-run preview + y/n/a[/e]) →
 *   execute → append the tool results to the history → stream again —
 *   bounded by the turn cap (default 25), with a 3-consecutive-failure
 *   circuit breaker and a cumulative token/cost budget across turns.
 *
 * Honesty rules the loop enforces:
 *  - Tool execution is only ever triggered by REAL wire tool_calls — never
 *    by sniffing the prompt text.
 *  - Tool.run is never called without the permission gate (permissions.ts),
 *    and the first execution of an approved call is always the dry run.
 *  - A denied tool is not an error: "Permission denied by user" goes back to
 *    the model as the tool result and the conversation continues.
 *  - A failed tool feeds its error text back to the model (it may retry
 *    differently); 3 CONSECUTIVE failures abort the run honestly.
 *  - Usage/charge are summed across turns with the existing BigInt money
 *    helpers — displayed per turn AND cumulatively, real numbers only.
 */

import type { SeloraClient } from '../api/client.js';
import {
  streamChat,
  type ChatMessage,
  type ChatUsage,
  type WireToolCall,
  type WireToolDefinition,
} from '../api/endpoints/chat.js';
import { parseMoneyMicro, microToWireString } from '../money.js';
import type { Tool, ToolKind } from './tool.js';
import { grantDirFor } from './userPaths.js';
import {
  createAutoAsker,
  SessionAllows,
  type PermissionAsker,
  type PermissionAnswer,
  type PermissionRequest,
} from './permissions.js';

/** Hard default for the turn cap; overridable via selora.json agent.maxTurns. */
export const DEFAULT_MAX_TURNS = 25;
/** Circuit breaker: this many consecutive FAILED tool calls abort the run. */
export const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

export interface AgentUsageTotals {
  turn: number;
  /** This turn's usage — undefined when its stream sent no usage chunk. */
  usage: ChatUsage | undefined;
  /** This turn's raw charge string. */
  charge: string | undefined;
  /** Cumulative tokens across all turns so far (only counted turns). */
  totalTokens: number;
  /** Cumulative prompt/completion tokens. */
  totalPromptTokens: number;
  totalCompletionTokens: number;
  /** Cumulative cost in micro-units — undefined when no charge ever arrived. */
  totalChargeMicro: bigint | undefined;
}

export interface AgentLoopCallbacks {
  onDelta: (text: string) => void;
  onReasoning?: ((text: string) => void) | undefined;
  /** Gray activity line (stderr): "→ read_file(src/index.ts)" etc. */
  onActivity?: ((line: string) => void) | undefined;
  /**
   * v0.3 rich tool display (the Claude-Code-style UI): a tool call started.
   * When provided, the UI renders `● Name(arg)`; onActivity is for the plain
   * (non-TTY) renderer instead.
   */
  onToolStart?: ((name: string, label: string) => void) | undefined;
  /** v0.3: a tool call finished (executed, failed, or denied) with display data. */
  onToolResult?:
    | ((info: {
        name: string;
        label: string;
        kind: ToolKind;
        ok: boolean;
        summary: string;
        content?: string | undefined;
        /** Pre-rendered colored diff lines (via opts.renderDiff). */
        diff?: readonly string[] | undefined;
      }) => void)
    | undefined;
  /** After each stream turn: per-turn usage/charge AND the running totals. */
  onTurnComplete: (totals: AgentUsageTotals) => void;
  /**
   * v0.6 crash-safe sessions: fired with a COPY of the history every time it
   * reaches a resumable checkpoint — all of a turn's tool calls answered,
   * before the next stream starts. Never fired mid-turn: an assistant
   * tool_calls message without its tool results is invalid on the wire, and a
   * half-finished turn would corrupt a resumed conversation. The caller
   * (run --session) saves the latest snapshot if the run dies.
   */
  onHistorySnapshot?: ((messages: ChatMessage[]) => void) | undefined;
}

export interface AgentLoopOptions {
  client: SeloraClient;
  model: string;
  /** Initial history — a fresh [user] message, or a resumed session. */
  messages: ChatMessage[];
  /** The tool registry (already filtered for --safe by the caller). */
  tools: Tool[];
  maxTurns: number;
  /** The sandbox root: every tool path is contained inside this. */
  cwd: string;
  permissions: PermissionAsker;
  /** --yes: skip prompts AND dry-runs (tools execute directly). */
  autoApprove: boolean;
  /**
   * v0.3: renders a ToolResult diff {before, after} into styled lines for the
   * permission prompt and the rich tool display (theme + ui/diff). Absent →
   * diffs are simply not rendered (plain text paths unchanged).
   */
  renderDiff?: ((before: string, after: string) => readonly string[]) | undefined;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal | undefined;
  /**
   * v0.3: session-scoped permission memory SHARED across loop runs (the chat
   * REPL keeps one for the whole session). Absent → a fresh one for this run
   * (the v0.2 `run` behavior — nothing survives the process either way).
   */
  allows?: SessionAllows | undefined;
}

export interface AgentToolEvent {
  name: string;
  label: string;
  ok: boolean;
  summary: string;
}

export type AgentStopReason = 'completed' | 'max-turns' | 'tool-failures';

export interface AgentRunResult {
  /** The last assistant text that streamed (may be '' on a pure tool turn). */
  content: string;
  finishReason: string;
  turns: number;
  toolEvents: AgentToolEvent[];
  /** Final history — the caller saves it when a session is attached. */
  messages: ChatMessage[];
  stop: AgentStopReason;
  usageTotal: ChatUsage | undefined;
  /** Cumulative cost, micro-units — undefined when no turn sent a charge. */
  chargeTotalMicro: bigint | undefined;
  /** Cumulative cost as a scale-6 wire-style string (matches usageTotal). */
  chargeTotal: string | undefined;
}

function toolToWire(tool: Tool): WireToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters as unknown as Record<string, unknown>,
    },
  };
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentRunResult> {
  const history: ChatMessage[] = [...opts.messages];
  const toolEvents: AgentToolEvent[] = [];
  const allows = opts.allows ?? new SessionAllows();
  const permissions: PermissionAsker = opts.autoApprove ? createAutoAsker() : opts.permissions;

  let content = '';
  let finishReason = '';
  let consecutiveFailures = 0;
  let usageTotal: ChatUsage | undefined = undefined;
  let chargeTotalMicro: bigint | undefined = undefined;
  const cb = opts.callbacks;

  for (let turn = 1; turn <= opts.maxTurns; turn += 1) {
    let turnContent = '';
    const result = await streamChat(
      opts.client,
      {
        model: opts.model,
        messages: history,
        tools: opts.tools.map(toolToWire),
        signal: opts.signal,
      },
      {
        onDelta: (text) => {
          turnContent += text;
          cb.onDelta(text);
        },
        onReasoning: (text) => {
          cb.onReasoning?.(text);
        },
      },
    );

    if (result.usage !== undefined) {
      usageTotal =
        usageTotal === undefined
          ? { ...result.usage }
          : {
              promptTokens: usageTotal.promptTokens + result.usage.promptTokens,
              completionTokens: usageTotal.completionTokens + result.usage.completionTokens,
              totalTokens: usageTotal.totalTokens + result.usage.totalTokens,
            };
    }
    if (result.charge !== undefined && result.charge !== '') {
      const micro = parseMoneyMicro(result.charge);
      if (micro !== null) {
        chargeTotalMicro = (chargeTotalMicro ?? 0n) + micro;
      }
    }
    finishReason = result.finishReason;
    content = turnContent;

    cb.onTurnComplete({
      turn,
      usage: result.usage,
      charge: result.charge,
      totalTokens: usageTotal?.totalTokens ?? 0,
      totalPromptTokens: usageTotal?.promptTokens ?? 0,
      totalCompletionTokens: usageTotal?.completionTokens ?? 0,
      totalChargeMicro: chargeTotalMicro,
    });

    if (result.toolCalls.length === 0) {
      history.push({ role: 'assistant', content: turnContent });
      return finish('completed', turn);
    }

    // The model really asked for tools. Echo the assistant message exactly as
    // the wire wants it (content null when nothing streamed before the calls).
    const echo: WireToolCall[] = result.toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }));
    history.push({
      role: 'assistant',
      content: turnContent === '' ? null : turnContent,
      tool_calls: echo,
    });

    for (let callIndex = 0; callIndex < result.toolCalls.length; callIndex += 1) {
      const call = result.toolCalls[callIndex]!;
      const outcome = await executeToolCall(opts, permissions, allows, call, history, toolEvents);
      if (outcome === 'failed') {
        consecutiveFailures += 1;
      } else if (outcome === 'succeeded') {
        consecutiveFailures = 0;
      } // 'denied' leaves the failure counter untouched
      if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
        // Wire-valid stop: parallel calls the breaker skipped still need a
        // tool message each, or a saved session resumes into a 400.
        for (const rest of result.toolCalls.slice(callIndex + 1)) {
          history.push({
            role: 'tool',
            tool_call_id: rest.id,
            content: 'Not executed: the run stopped after 3 consecutive tool failures.',
          });
        }
        return finish('tool-failures', turn);
      }
    }

    if (turn === opts.maxTurns) {
      // No stream turns left to ANSWER the tool results — but every requested
      // call has its result in the history, so the shape stays wire-valid and
      // a saved session resumes cleanly (the model answers them next run).
      opts.callbacks.onHistorySnapshot?.([...history]);
      return finish('max-turns', turn);
    }

    // A resumable checkpoint: every requested tool of this turn has its result
    // in the history — the wire shape is valid from here.
    opts.callbacks.onHistorySnapshot?.([...history]);
  }
  return finish('max-turns', opts.maxTurns);

  function finish(stop: AgentStopReason, turns: number): AgentRunResult {
    const chargeTotal =
      chargeTotalMicro !== undefined ? microToWireString(chargeTotalMicro) : undefined;
    return {
      content,
      finishReason,
      turns,
      toolEvents,
      messages: history,
      stop,
      usageTotal,
      chargeTotalMicro,
      chargeTotal,
    };
  }
}

type CallOutcome = 'succeeded' | 'failed' | 'denied';

async function executeToolCall(
  opts: AgentLoopOptions,
  permissions: PermissionAsker,
  allows: SessionAllows,
  call: { id: string; name: string; arguments: string },
  history: ChatMessage[],
  toolEvents: AgentToolEvent[],
): Promise<CallOutcome> {
  const { cwd, callbacks: cb } = opts;
  const reply = (text: string): void => {
    history.push({ role: 'tool', tool_call_id: call.id, content: text });
  };

  const tool = opts.tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    const available = opts.tools.map((t) => t.name).join(', ');
    cb.onActivity?.(`→ ${call.name}() — no such tool`);
    const text = `Unknown tool "${call.name}". Available tools: ${available}.`;
    cb.onActivity?.(`✗ ${text}`);
    reply(text);
    toolEvents.push({ name: call.name, label: `${call.name}()`, ok: false, summary: text });
    return 'failed';
  }

  // Model-produced arguments JSON is untrusted: parse defensively.
  let parsed: Record<string, unknown> | null;
  const argsRaw = call.arguments.trim();
  if (argsRaw === '') {
    parsed = {};
  } else {
    try {
      parsed = rec(JSON.parse(argsRaw));
    } catch (err) {
      const text = `Invalid tool arguments for ${call.name}: not valid JSON (${errText(err)}).`;
      cb.onActivity?.(`→ ${tool.name}(…) — invalid arguments`);
      cb.onActivity?.(`✗ ${text}`);
      reply(text);
      toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
      return 'failed';
    }
  }
  if (parsed === null) {
    const text = `Invalid tool arguments for ${tool.name}: expected a JSON object.`;
    cb.onActivity?.(`✗ ${text}`);
    reply(text);
    toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
    return 'failed';
  }

  const input: Record<string, unknown> = parsed;
  const label = tool.permissionLabel(input);
  cb.onActivity?.(`→ ${label}`);
  cb.onToolStart?.(tool.name, label);

  // Session auto-allow from an earlier 'a' answer (memory-only). Tools that
  // must always ask (remove) are exempt even in always-allow mode.
  if (tool.neverAutoAllow !== true && allows.check(tool.kind, tool.name, label)) {
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts, allows.outsideDirs());
  }

  if (opts.autoApprove) {
    // --yes auto-approves everything the toolset allows — including outside
    // access: a quick dry run detects it, the dir is granted in-session, and
    // the real run proceeds (one dry run, no prompt, nothing persisted).
    const probe = await tool.run(input, { cwd, dryRun: true, outsideDirs: allows.outsideDirs() });
    if (probe.outside !== undefined) allows.rememberDir(grantDirFor(probe.outside.abs));
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts, allows.outsideDirs());
  }

  // Dry run first — its result is the permission prompt's preview, and an
  // {ok:false} dry run (bad path, missing file, …) never even prompts.
  let preview: string | undefined = undefined;
  let styledDiff: readonly string[] | undefined = undefined;
  const dry = await tool.run(input, { cwd, dryRun: true, outsideDirs: allows.outsideDirs() });
  if (!dry.ok) {
    cb.onActivity?.(`✗ ${dry.summary}`);
    cb.onToolResult?.({ name: tool.name, label, kind: tool.kind, ok: false, summary: dry.summary });
    reply(dry.summary);
    toolEvents.push({ name: tool.name, label, ok: false, summary: dry.summary });
    return 'failed';
  }
  preview = dry.preview ?? dry.summary;
  if (dry.diff !== undefined) styledDiff = opts.renderDiff?.(dry.diff.before, dry.diff.after);

  // OUTSIDE the project root and not granted this session: a dedicated
  // permission ask showing the absolute path. EVERY approved answer grants
  // exactly one DIRECTORY (the target's parent — or itself when it is an
  // existing dir) for the session BEFORE the real run: a manual 'y', an 'a',
  // and auto mode's auto-allow alike. (v0.7 granted only on 'allow-session' —
  // a plain 'allow' reached runApproved with outsideDirs unchanged and the
  // real run failed the boundary check. An approved call that then fails is
  // the bug class; auto mode hit it on every outside touch.) This branch is
  // only reached for not-yet-granted dirs — a granted dir never sets
  // dry.outside — so the grant line prints exactly once per directory: the
  // FIRST outside touch auto-grants in auto mode, mirroring --yes. For tools
  // that must always ask (remove), the grant covers the PATH only; the normal
  // tool prompt still follows.
  if (dry.outside !== undefined) {
    const grantDir = grantDirFor(dry.outside.abs);
    const req: PermissionRequest = {
      label,
      kind: tool.kind,
      preview,
      outsidePath: dry.outside.abs,
      diff: styledDiff,
    };
    const answer = await ask(permissions, req);
    // Only explicit approvals proceed — a stray 'edit' answer (the line-based
    // prompt maps 'e' even though outside asks never offer it) denies safely.
    if (answer.decision !== 'allow' && answer.decision !== 'allow-session') {
      return denied(tool, label, answer.reason, cb, reply, toolEvents);
    }
    allows.rememberDir(grantDir);
    cb.onActivity?.(`· outside access granted for this session: ${grantDir}`);
    const dirs = allows.outsideDirs();
    if (tool.neverAutoAllow === true) {
      // The tool itself still requires its own confirmation every time.
      return await promptLoop(tool, input, label, preview, styledDiff, dirs);
    }
    if (answer.decision === 'allow-session' && tool.kind !== 'read') {
      // One prompt per unique outside write: remember the exact label too.
      allows.remember(tool.kind, tool.name, label);
    }
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts, dirs);
  }

  return await promptLoop(tool, input, label, preview, styledDiff, allows.outsideDirs());

  /** The normal y/n/a[/e] prompt cycle (v0.2 flow, plus dirs + rich callbacks). */
  async function promptLoop(
    tool: Tool,
    input: Record<string, unknown>,
    label: string,
    preview: string | undefined,
    styledDiff: readonly string[] | undefined,
    outsideDirs: readonly string[],
  ): Promise<CallOutcome> {
    for (;;) {
      const req: PermissionRequest = {
        label,
        kind: tool.kind,
        preview,
        offerEdit: tool.kind === 'exec',
        diff: styledDiff,
        neverAlways: tool.neverAutoAllow === true,
      };
      const answer = await ask(permissions, req);
      if (answer.decision === 'deny') {
        return denied(tool, label, answer.reason, cb, reply, toolEvents);
      }
      if (answer.decision === 'allow' || answer.decision === 'allow-session') {
        if (answer.decision === 'allow-session' && tool.neverAutoAllow !== true) {
          allows.remember(tool.kind, tool.name, label);
          cb.onActivity?.('· allowed for this session');
        }
        return await runApproved(tool, input, label, reply, toolEvents, cb, opts, outsideDirs);
      }
      // 'edit' (exec tools only): replace the command, dry-run, ask again.
      const replacement = await permissions.replacement(String(input['command'] ?? ''));
      if (replacement === null) {
        cb.onActivity?.('· edit cancelled — treating as no');
        reply('Permission denied by user.');
        toolEvents.push({ name: tool.name, label, ok: false, summary: 'denied by user' });
        return 'denied';
      }
      input = { ...input, command: replacement };
      label = tool.permissionLabel(input);
      cb.onActivity?.(`→ ${label}`);
      const reDry = await tool.run(input, { cwd, dryRun: true, outsideDirs });
      if (!reDry.ok) {
        cb.onActivity?.(`✗ ${reDry.summary}`);
        reply(reDry.summary);
        toolEvents.push({ name: tool.name, label, ok: false, summary: reDry.summary });
        return 'failed';
      }
      preview = reDry.preview ?? reDry.summary;
      styledDiff =
        reDry.diff !== undefined
          ? opts.renderDiff?.(reDry.diff.before, reDry.diff.after)
          : undefined;
    }
  }
}

/** askDetailed when the asker offers it (reason on deny), else plain ask(). */
async function ask(
  permissions: PermissionAsker,
  req: PermissionRequest,
): Promise<PermissionAnswer> {
  if (permissions.askDetailed !== undefined) return await permissions.askDetailed(req);
  return { decision: await permissions.ask(req) };
}

/** A denial is not an error: it goes back to the model with the optional reason. */
function denied(
  tool: Tool,
  label: string,
  reason: string | undefined,
  cb: AgentLoopCallbacks,
  reply: (text: string) => void,
  toolEvents: AgentToolEvent[],
): CallOutcome {
  cb.onActivity?.('· denied by user');
  cb.onToolResult?.({
    name: tool.name,
    label,
    kind: tool.kind,
    ok: false,
    summary: 'denied by user',
  });
  reply(
    reason !== undefined && reason !== ''
      ? `Permission denied by user. Reason: ${reason}`
      : 'Permission denied by user.',
  );
  toolEvents.push({ name: tool.name, label, ok: false, summary: 'denied by user' });
  return 'denied';
}

async function runApproved(
  tool: Tool,
  input: Record<string, unknown>,
  label: string,
  reply: (text: string) => void,
  toolEvents: AgentToolEvent[],
  cb: AgentLoopCallbacks,
  opts: AgentLoopOptions,
  outsideDirs: readonly string[],
): Promise<CallOutcome> {
  const freshLabel = tool.permissionLabel(input);
  if (freshLabel !== label) cb.onActivity?.(`→ ${freshLabel}`);
  const result = await tool.run(input, { cwd: opts.cwd, dryRun: false, outsideDirs });
  cb.onActivity?.(result.ok ? `· ${result.summary}` : `✗ ${result.summary}`);
  const styledDiff =
    result.diff !== undefined
      ? opts.renderDiff?.(result.diff.before, result.diff.after)
      : undefined;
  cb.onToolResult?.({
    name: tool.name,
    label: freshLabel,
    kind: tool.kind,
    ok: result.ok,
    summary: result.summary,
    content: result.content,
    diff: styledDiff,
  });
  reply(result.content ?? result.summary);
  toolEvents.push({ name: tool.name, label: freshLabel, ok: result.ok, summary: result.summary });
  return result.ok ? 'succeeded' : 'failed';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
