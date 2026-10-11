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
 *  - Plan mode (v0.9, the planGate option): a mutating tool is denied BEFORE
 *    its dry run and recorded as a proposal instead — the conversation
 *    continues with read-only tools only.
 *  - A failed tool feeds its error text back to the model (it may retry
 *    differently); 3 CONSECUTIVE failures abort the run honestly.
 *  - Usage/charge are summed across turns with the existing BigInt money
 *    helpers — displayed per turn AND cumulatively, real numbers only.
 */

import { randomUUID } from 'node:crypto';
import type { SeloraClient } from '../api/client.js';
import { SeloraApiError } from '../api/errors.js';
import {
  streamChat,
  type ChatMessage,
  type ChatResult,
  type ChatUsage,
  type WireToolCall,
  type WireToolDefinition,
} from '../api/endpoints/chat.js';
import { parseMoneyMicro, microToWireString } from '../money.js';
import { throwIfCancelled, type Tool, type ToolKind, type ToolResult } from './tool.js';
import { grantDirFor } from './userPaths.js';
import { PLAN_MODE_DENY_REASON } from './modes.js';
import type { ReviewDecision } from '../diff/types.js';
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
/**
 * v2.2: how many times a turn whose stream DROPPED mid-body (network/timeout
 * after reply text streamed, before any tool-call fragment) is resumed —
 * "continue exactly where you stopped" — before the error surfaces with the
 * partial text preserved.
 */
export const STREAM_RESUME_MAX = 2;
/** The seam-overlap check is bounded to the partial's last this-many chars. */
const STREAM_RESUME_OVERLAP_CAP = 200;
/** The synthetic user message a resume appends after the partial assistant text. */
const STREAM_RESUME_INSTRUCTION =
  'Your previous reply was cut off by a connection drop. Continue EXACTLY where you stopped: output only the remaining text of that reply — no apology, no preamble, and do not repeat text you already wrote.';

/**
 * v2.2: join a dropped stream's partial text with its resume continuation. The
 * model is told to continue exactly where it stopped but may repeat a few
 * words at the seam — trim the LONGEST suffix of `partial` that equals a
 * prefix of `continuation` (checked only within partial's last
 * STREAM_RESUME_OVERLAP_CAP chars) exactly once. No clean overlap → joined
 * as-is: an honest seam beats lost text.
 */
export function stitchStreamParts(partial: string, continuation: string): string {
  if (partial === '' || continuation === '') return partial + continuation;
  const tail = partial.slice(Math.max(0, partial.length - STREAM_RESUME_OVERLAP_CAP));
  const maxOverlap = Math.min(tail.length, continuation.length);
  for (let k = maxOverlap; k > 0; k -= 1) {
    if (tail.endsWith(continuation.slice(0, k))) {
      return partial + continuation.slice(k);
    }
  }
  return partial + continuation;
}

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

export type AgentEvent =
  | { type: 'assistant-start'; id: string; turn: number }
  | { type: 'assistant-delta'; id: string; text: string; sequence: number }
  | { type: 'assistant-complete'; id: string; turn: number; content: string }
  | { type: 'tool-start'; id: string; callId: string; name: string; label: string }
  | {
      type: 'tool-result';
      id: string;
      callId: string;
      name: string;
      label: string;
      kind: ToolKind;
      ok: boolean;
      summary: string;
      content?: string | undefined;
      diff?: readonly string[] | undefined;
      /** Raw before/after of a file change — the UI renders the flat diff + result line from it. */
      diffPayload?: NonNullable<ToolResult['diff']> | undefined;
    }
  | { type: 'status'; id: string; text: string };

export interface AgentLoopCallbacks {
  onDelta: (text: string, eventId?: string) => void;
  onEvent?: ((event: AgentEvent) => void) | undefined;
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
        /** Raw before/after of a file change — the UI renders the flat diff + result line from it. */
        diffPayload?: NonNullable<ToolResult['diff']> | undefined;
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

/**
 * Plan mode (v0.9): when `isPlanMode()` is true, every MUTATING tool call
 * (kind !== 'read') is denied before any dry run — the label is recorded via
 * `onProposal` (chat's /plan list) and the model receives a reasoned denial.
 * Read/search tools never reach the gate (the mode asker auto-allows them).
 * Absent → nothing is gated (the `run` command never sets this).
 */
export interface PlanGate {
  isPlanMode: () => boolean;
  onProposal: (label: string) => void;
}

/**
 * v1.3 diff-review pipeline (the chat TTY path). When present, write tools
 * whose dry run carries a diff payload (write_file, edit_file) are approved
 * through the interactive review UI instead of the generic permission gate,
 * and applied through a guarded writer (path guard + conflict check + atomic
 * write + history checkpoint) instead of the tool's own real run. Both halves
 * are provided together by the caller — review without apply would strand the
 * write. Absent → the v0.2/v0.3 flow is byte-identical.
 */
export interface FileChangeHooks {
  /** Present the change; collect the user's decision. Never writes. */
  review: (change: {
    path: string;
    before: string;
    after: string;
    kind: 'created' | 'modified' | 'deleted';
    label: string;
  }) => Promise<ReviewDecision>;
  /**
   * Apply an approved change (guarded + atomic + checkpointed by the caller).
   * `acceptedHunks` set → apply only those hunks of the diff (partial apply).
   */
  apply: (
    change: {
      path: string;
      before: string;
      after: string;
      kind: 'created' | 'modified' | 'deleted';
    },
    acceptedHunks: readonly number[] | undefined,
  ) => Promise<{ ok: boolean; summary: string }>;
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
   * v1.3: the optional third argument is the diff's display path (renderer
   * picks the header title and syntax language from it).
   */
  renderDiff?: ((before: string, after: string, path?: string) => readonly string[]) | undefined;
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal | undefined;
  /**
   * v0.3: session-scoped permission memory SHARED across loop runs (the chat
   * REPL keeps one for the whole session). Absent → a fresh one for this run
   * (the v0.2 `run` behavior — nothing survives the process either way).
   */
  allows?: SessionAllows | undefined;
  /** v0.9: plan mode — mutating tool calls become recorded proposals. */
  planGate?: PlanGate | undefined;
  /**
   * v1.3: dry-run mode (permissions.mode 'dry-run') — write/exec tools run
   * their DRY RUN only: the proposed change (with its diff) is shown and the
   * model is told plainly that nothing was written. Read tools run normally.
   */
  dryRun?: boolean | undefined;
  /** v1.3: the interactive file-change review pipeline (see FileChangeHooks). */
  fileChange?: FileChangeHooks | undefined;
  /**
   * v1.3: fired after a successful REAL run that carried a diff payload — the
   * session-history checkpoint hook. Not fired for changes applied through
   * fileChange.apply (the applier checkpoints itself).
   */
  onFileChange?:
    | ((rec: {
        path: string;
        before: string;
        after: string;
        kind: 'created' | 'modified' | 'deleted';
      }) => void)
    | undefined;
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
  const runId = randomUUID();

  for (let turn = 1; turn <= opts.maxTurns; turn += 1) {
    throwIfCancelled(opts.signal);
    let sequence = 0;
    const assistantId = `${runId}:turn:${turn}`;
    cb.onEvent?.({ type: 'assistant-start', id: assistantId, turn });

    // v2.2 mid-stream drop resume: when streamChat throws a network/timeout
    // error (NEVER 'cancelled', never auth/4xx/billing kinds) after reply text
    // already streamed and BEFORE any tool-call fragment, the turn RESUMES
    // instead of dying — the partial goes back as an assistant message plus a
    // continue-exactly instruction, and the continuation is stitched onto it
    // (one overlap trim per seam). At most STREAM_RESUME_MAX resumes per turn;
    // a turn that streamed tool-call fragments is NEVER resumed, and a resume
    // never re-executes tools (the continuation is a fresh stream turn).
    const parts: string[] = [];
    let attemptContent = '';
    let resumesUsed = 0;
    let messagesForTurn: ChatMessage[] = history;
    let result: ChatResult;
    for (;;) {
      throwIfCancelled(opts.signal);
      attemptContent = '';
      try {
        result = await streamChat(
          opts.client,
          {
            model: opts.model,
            messages: messagesForTurn,
            tools: opts.tools.map(toolToWire),
            signal: opts.signal,
          },
          {
            onDelta: (text, eventId) => {
              attemptContent += text;
              cb.onEvent?.({ type: 'assistant-delta', id: assistantId, text, sequence: sequence++ });
              // Resume attempts re-namespace the gateway's SSE event ids: a
              // gateway numbering ids per request would otherwise collide with
              // the dropped attempt's ids in the caller's transcript dedup
              // (chat keys by assistantMessageId:eventId) and swallow the
              // continuation.
              cb.onDelta(
                text,
                eventId === undefined || resumesUsed === 0
                  ? eventId
                  : `resume${resumesUsed}:${eventId}`,
              );
            },
            onReasoning: (text) => {
              cb.onReasoning?.(text);
            },
          },
        );
        break;
      } catch (err) {
        const dropped =
          err instanceof SeloraApiError &&
          (err.kind === 'network' || err.kind === 'timeout') &&
          opts.signal?.aborted !== true;
        const partial = err instanceof SeloraApiError ? err.streamPartial : undefined;
        const streamedText = parts.join('') + attemptContent;
        const toolFragments = partial?.toolCallsSeen === true;
        if (dropped && partial !== undefined) {
          // The dropped attempt was CHARGED by the gateway: fold whatever
          // usage/charge chunks arrived before the drop into the totals now.
          // The resume is a new stream turn in the same logical turn — both
          // halves count.
          let counted = false;
          if (partial.usage !== undefined) {
            usageTotal =
              usageTotal === undefined
                ? { ...partial.usage }
                : {
                    promptTokens: usageTotal.promptTokens + partial.usage.promptTokens,
                    completionTokens: usageTotal.completionTokens + partial.usage.completionTokens,
                    totalTokens: usageTotal.totalTokens + partial.usage.totalTokens,
                  };
            counted = true;
          }
          if (partial.charge !== undefined && partial.charge !== '') {
            const micro = parseMoneyMicro(partial.charge);
            if (micro !== null) {
              chargeTotalMicro = (chargeTotalMicro ?? 0n) + micro;
              counted = true;
            }
          }
          if (counted) {
            cb.onTurnComplete({
              turn,
              usage: partial.usage,
              charge: partial.charge,
              totalTokens: usageTotal?.totalTokens ?? 0,
              totalPromptTokens: usageTotal?.promptTokens ?? 0,
              totalCompletionTokens: usageTotal?.completionTokens ?? 0,
              totalChargeMicro: chargeTotalMicro,
            });
          }
        }
        if (!dropped || streamedText === '' || toolFragments || resumesUsed >= STREAM_RESUME_MAX) {
          if (dropped && streamedText !== '' && !toolFragments) {
            // Giving up: the partial text the user watched stream stays on the
            // transcript (its deltas already flowed) — say so, then surface
            // the error exactly as today.
            const note = `· stream dropped — reply incomplete after ${resumesUsed} resume${resumesUsed === 1 ? '' : 's'}`;
            cb.onEvent?.({ type: 'status', id: `${assistantId}:status:drop`, text: note });
            cb.onActivity?.(note);
          }
          throw err;
        }
        resumesUsed += 1;
        parts.push(attemptContent);
        const note = `· stream dropped — resuming (${resumesUsed}/${STREAM_RESUME_MAX})`;
        cb.onEvent?.({ type: 'status', id: `${assistantId}:status:resume:${resumesUsed}`, text: note });
        cb.onActivity?.(note);
        messagesForTurn = [
          ...history,
          { role: 'assistant', content: parts.join('') },
          { role: 'user', content: STREAM_RESUME_INSTRUCTION },
        ];
      }
    }
    parts.push(attemptContent);
    // One overlap trim per resume seam; a never-resumed turn is parts[0] as-is.
    const turnContent =
      parts.length === 1 ? parts[0]! : parts.reduce((acc, part) => stitchStreamParts(acc, part));

    cb.onEvent?.({ type: 'assistant-complete', id: assistantId, turn, content: turnContent });

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
      cb.onHistorySnapshot?.([...history]);
      throwIfCancelled(opts.signal);
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

    const batchHistoryStart = history.length;
    const callCallbacks = result.toolCalls.map((call, index) =>
      toolCallbacks(cb, `${assistantId}:call:${index}:${call.id}`, call.id, call.name),
    );
    try {
      for (let callIndex = 0; callIndex < result.toolCalls.length; callIndex += 1) {
        throwIfCancelled(opts.signal);
        const call = result.toolCalls[callIndex]!;
        const outcome = await executeToolCall(
          { ...opts, callbacks: callCallbacks[callIndex]! },
          permissions,
          allows,
          call,
          history,
          toolEvents,
        );
        throwIfCancelled(opts.signal);
        if (outcome === 'failed') {
          consecutiveFailures += 1;
        } else if (outcome === 'succeeded') {
          consecutiveFailures = 0;
        } // 'denied' leaves the failure counter untouched
        if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          for (let index = callIndex + 1; index < result.toolCalls.length; index += 1) {
            recordSkipped(
              index,
              'Not executed: the run stopped after 3 consecutive tool failures.',
            );
          }
          cb.onHistorySnapshot?.([...history]);
          return finish('tool-failures', turn);
        }
      }
      throwIfCancelled(opts.signal);
    } catch (err) {
      if (
        opts.signal?.aborted !== true &&
        !(err instanceof SeloraApiError && err.kind === 'cancelled')
      ) {
        throw err;
      }
      // Every unanswered call gets an honest cancellation result. No pending
      // tool runs; already executed effects remain in a wire-valid checkpoint.
      const completed = history.length - batchHistoryStart;
      for (let index = completed; index < result.toolCalls.length; index += 1) {
        recordSkipped(
          index,
          'Cancelled: tool execution did not complete; no further tools were executed.',
        );
      }
      cb.onHistorySnapshot?.([...history]);
      throw new SeloraApiError({ kind: 'cancelled', message: 'Request cancelled.' });
    }

    function recordSkipped(index: number, summary: string): void {
      const call = result.toolCalls[index]!;
      const label = `${call.name}()`;
      const callbacks = callCallbacks[index]!;
      history.push({ role: 'tool', tool_call_id: call.id, content: summary });
      toolEvents.push({ name: call.name, label, ok: false, summary });
      callbacks.onToolStart?.(call.name, label);
      callbacks.onToolResult?.({
        name: call.name,
        label,
        kind: opts.tools.find((tool) => tool.name === call.name)?.kind ?? 'exec',
        ok: false,
        summary,
      });
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

/** One identity per wire call; compatibility callbacks adapt the event payload. */
function toolCallbacks(
  cb: AgentLoopCallbacks,
  id: string,
  callId: string,
  name: string,
): AgentLoopCallbacks {
  let started = false;
  let completed = false;
  let statusSequence = 0;
  return {
    ...cb,
    onActivity: (text) => {
      cb.onEvent?.({ type: 'status', id: `${id}:status:${statusSequence++}`, text });
      cb.onActivity?.(text);
    },
    onToolStart: (toolName, label) => {
      if (started) return;
      started = true;
      cb.onEvent?.({ type: 'tool-start', id, callId, name: toolName, label });
      if (cb.onToolStart !== undefined) cb.onToolStart(toolName, label);
      else cb.onActivity?.(`→ ${label}`);
    },
    onToolResult: (info) => {
      if (completed) return;
      completed = true;
      if (!started) {
        started = true;
        cb.onEvent?.({ type: 'tool-start', id, callId, name, label: info.label });
        if (cb.onToolStart !== undefined) cb.onToolStart(name, info.label);
        else cb.onActivity?.(`→ ${info.label}`);
      }
      cb.onEvent?.({ type: 'tool-result', id, callId, ...info });
      if (cb.onToolResult !== undefined) cb.onToolResult(info);
      else {
        const denied = info.summary === 'denied by user' || info.summary.startsWith('plan mode:');
        cb.onActivity?.(`${info.ok || denied ? '·' : '✗'} ${info.summary}`);
      }
    },
  };
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
  throwIfCancelled(opts.signal);
  const reply = (text: string): void => {
    history.push({ role: 'tool', tool_call_id: call.id, content: text });
  };

  const tool = opts.tools.find((t) => t.name === call.name);
  if (tool === undefined) {
    const available = opts.tools.map((t) => t.name).join(', ');
    cb.onToolStart?.(call.name, `${call.name}() — no such tool`);
    const text = `Unknown tool "${call.name}". Available tools: ${available}.`;
    cb.onToolResult?.({
      name: call.name,
      label: `${call.name}()`,
      kind: 'exec',
      ok: false,
      summary: text,
    });
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
      cb.onToolResult?.({
        name: tool.name,
        label: `${tool.name}()`,
        kind: tool.kind,
        ok: false,
        summary: text,
      });
      reply(text);
      toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
      return 'failed';
    }
  }
  if (parsed === null) {
    const text = `Invalid tool arguments for ${tool.name}: expected a JSON object.`;
    cb.onToolResult?.({
      name: tool.name,
      label: `${tool.name}()`,
      kind: tool.kind,
      ok: false,
      summary: text,
    });
    reply(text);
    toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
    return 'failed';
  }

  const input: Record<string, unknown> = parsed;
  const label = tool.permissionLabel(input);
  cb.onToolStart?.(tool.name, label);

  // Plan mode (v0.9): a mutating tool is NEVER executed — not even dry-run
  // here. The proposal is recorded (chat's /plan list, shown to the user) and
  // the model receives the standard reasoned denial, so the run continues as
  // a planning conversation. Read tools never reach this branch (the mode
  // asker auto-allowed them); 'denied' does not touch the failure breaker.
  if (opts.planGate !== undefined && opts.planGate.isPlanMode() && tool.kind !== 'read') {
    opts.planGate.onProposal(label);
    const summary = 'plan mode: proposal recorded — not executed';
    cb.onToolResult?.({ name: tool.name, label, kind: tool.kind, ok: false, summary });
    reply(`Permission denied by user. Reason: ${PLAN_MODE_DENY_REASON}`);
    toolEvents.push({ name: tool.name, label, ok: false, summary });
    return 'denied';
  }

  // v1.3 dry-run mode (permissions.mode 'dry-run'): write/exec tools run
  // their DRY RUN ONLY — before any auto-allow/auto-approve shortcut, so the
  // mode is honest even under --yes: the proposed change (preview + styled
  // diff) is shown and the model is told plainly that nothing was written.
  if (opts.dryRun === true && tool.kind !== 'read') {
    const dry = await previewTool(input, allows.outsideDirs());
    if (!dry.ok) {
      cb.onToolResult?.({
        name: tool.name,
        label,
        kind: tool.kind,
        ok: false,
        summary: dry.summary,
      });
      reply(dry.summary);
      toolEvents.push({ name: tool.name, label, ok: false, summary: dry.summary });
      return 'failed';
    }
    const styledDry =
      dry.diff !== undefined
        ? opts.renderDiff?.(dry.diff.before, dry.diff.after, dry.diff.path)
        : undefined;
    const summary = `[dry-run] ${dry.summary}`;
    cb.onToolResult?.({
      name: tool.name,
      label,
      kind: tool.kind,
      ok: true,
      summary,
      diff: styledDry,
    });
    reply(
      `${dry.summary}\nDRY-RUN MODE: the proposed change was shown to the user but NOTHING was written or executed. Do not assume the change exists; say what WOULD happen instead.`,
    );
    toolEvents.push({ name: tool.name, label, ok: true, summary });
    return 'denied'; // leaves the consecutive-failure breaker untouched
  }

  // Session auto-allow from an earlier 'a' answer (memory-only). Tools that
  // must always ask (remove) are exempt even in always-allow mode.
  if (tool.neverAutoAllow !== true && allows.check(tool.kind, tool.name, label)) {
    if (tool.kind === 'read') {
      // Reads carry no diff and cannot clobber anything — straight to the run.
      return await runApproved(tool, input, label, reply, toolEvents, cb, opts, allows.outsideDirs());
    }
    // Write/exec: probe first (a fresh dry run, exactly like the --yes path).
    // The probe supplies the display's diff payload, detects outside-root
    // targets, and its `before` is compared against the baseline recorded
    // when the user approved 'always': the file changing since (an editor
    // save between turns, a watcher) means the blanket approval no longer
    // matches reality — fall through to the normal gate and ask again with
    // the FRESH diff instead of silently clobbering the external change.
    const probe = await previewTool(input, allows.outsideDirs());
    if (probe.outside !== undefined) allows.rememberDir(grantDirFor(probe.outside.abs));
    const baseline = allows.baselineFor(tool.kind, tool.name, label);
    // baseline undefined → nothing verifiable was ever approved (e.g. a
    // >256 KB target carries no diff): proceed as before. Otherwise the
    // probe's `before` must match the baseline exactly — a probe that CANNOT
    // verify (no diff now, though one was approved) is treated as changed.
    if (baseline === undefined || (probe.diff !== undefined && probe.diff.before === baseline)) {
      const outcome = await runApproved(
        tool,
        input,
        label,
        reply,
        toolEvents,
        cb,
        opts,
        allows.outsideDirs(),
        probe.diff,
      );
      // Refresh the baseline: the agent's own write is the new known state.
      if (outcome === 'succeeded' && probe.diff !== undefined) {
        allows.rememberBaseline(tool.kind, tool.name, label, probe.diff.after);
      }
      return outcome;
    }
    cb.onActivity?.(
      `· ${label}: the file changed on disk since it was allowed for this session — asking again`,
    );
  }

  if (opts.autoApprove) {
    // --yes auto-approves everything the toolset allows — including outside
    // access: a quick dry run detects it, the dir is granted in-session, and
    // the real run proceeds (one dry run, no prompt, nothing persisted).
    const probe = await previewTool(input, allows.outsideDirs());
    if (probe.outside !== undefined) allows.rememberDir(grantDirFor(probe.outside.abs));
    return await runApproved(
      tool,
      input,
      label,
      reply,
      toolEvents,
      cb,
      opts,
      allows.outsideDirs(),
      probe.diff,
    );
  }

  // Dry run first — its result is the permission prompt's preview, and an
  // {ok:false} dry run (bad path, missing file, …) never even prompts.
  let preview: string | undefined = undefined;
  let styledDiff: readonly string[] | undefined = undefined;
  const dry = await previewTool(input, allows.outsideDirs());
  if (!dry.ok) {
    cb.onToolResult?.({ name: tool.name, label, kind: tool.kind, ok: false, summary: dry.summary });
    reply(dry.summary);
    toolEvents.push({ name: tool.name, label, ok: false, summary: dry.summary });
    return 'failed';
  }
  preview = dry.preview ?? dry.summary;
  if (dry.diff !== undefined) {
    styledDiff = opts.renderDiff?.(dry.diff.before, dry.diff.after, dry.diff.path);
  }

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
    throwIfCancelled(opts.signal);
    const answer = await ask(permissions, req);
    throwIfCancelled(opts.signal);
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
      return await promptLoop(tool, input, label, preview, styledDiff, dirs, dry.diff);
    }
    if (answer.decision === 'allow-session' && tool.kind !== 'read') {
      // One prompt per unique outside write: remember the exact label too.
      allows.remember(tool.kind, tool.name, label);
      if (dry.diff !== undefined) {
        allows.rememberBaseline(tool.kind, tool.name, label, dry.diff.after);
      }
    }
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts, dirs, dry.diff);
  }

  // v1.3: the interactive file-change review replaces the generic gate for
  // diff-carrying write tools (write_file/edit_file). neverAutoAllow tools
  // (remove) keep the classic gate no matter what. The review NEVER writes —
  // an apply decision is executed through hooks.apply (guarded, conflict-
  // checked, atomic, checkpointed).
  if (
    opts.fileChange !== undefined &&
    dry.diff !== undefined &&
    tool.kind === 'write' &&
    tool.neverAutoAllow !== true
  ) {
    const hooks = opts.fileChange;
    const change = {
      path: dry.diff.path ?? label,
      before: dry.diff.before,
      after: dry.diff.after,
      kind:
        dry.diff.kind ?? (dry.diff.before === '' ? ('created' as const) : ('modified' as const)),
      label,
    };
    throwIfCancelled(opts.signal);
    const decision = await hooks.review(change);
    throwIfCancelled(opts.signal);
    switch (decision.action) {
      case 'apply':
        return await applyReviewed(hooks, tool, label, change, undefined);
      case 'apply-all':
        // The hook auto-answers subsequent reviews itself; also record the
        // classic session allow for this exact label — with the baseline, so
        // an external edit between turns re-prompts instead of clobbering.
        allows.remember(tool.kind, tool.name, label);
        allows.rememberBaseline(tool.kind, tool.name, label, change.after);
        cb.onActivity?.('· applying all remaining file changes without asking');
        return await applyReviewed(hooks, tool, label, change, undefined);
      case 'apply-hunks':
        return await applyReviewed(hooks, tool, label, change, decision.accepted);
      case 'reject':
        return denied(tool, label, decision.reason, cb, reply, toolEvents);
      case 'cancel':
        return denied(tool, label, 'cancelled by user', cb, reply, toolEvents);
    }
  }

  return await promptLoop(tool, input, label, preview, styledDiff, allows.outsideDirs(), dry.diff);

  async function previewTool(input: Record<string, unknown>, outsideDirs: readonly string[]) {
    throwIfCancelled(opts.signal);
    const preview = await tool!.run(input, { cwd, dryRun: true, outsideDirs, signal: opts.signal });
    throwIfCancelled(opts.signal);
    return preview;
  }

  /** Execute an approved review decision through the guarded writer. */
  async function applyReviewed(
    hooks: FileChangeHooks,
    tool: Tool,
    label: string,
    change: {
      path: string;
      before: string;
      after: string;
      kind: 'created' | 'modified' | 'deleted';
      label: string;
    },
    acceptedHunks: readonly number[] | undefined,
  ): Promise<CallOutcome> {
    throwIfCancelled(opts.signal);
    const applied = await hooks.apply(change, acceptedHunks);
    cb.onToolResult?.({
      name: tool.name,
      label,
      kind: tool.kind,
      ok: applied.ok,
      summary: applied.summary,
      // Full applies carry the change payload so the transcript shows the flat
      // diff; a partial-hunk apply's result differs from the proposal, so it
      // keeps the plain summary line.
      ...(applied.ok && acceptedHunks === undefined
        ? {
            diffPayload: {
              before: change.before,
              after: change.after,
              path: change.path,
              kind: change.kind,
            },
          }
        : {}),
    });
    reply(applied.summary);
    toolEvents.push({ name: tool.name, label, ok: applied.ok, summary: applied.summary });
    throwIfCancelled(opts.signal);
    return applied.ok ? 'succeeded' : 'failed';
  }

  /** The normal y/n/a[/e] prompt cycle (v0.2 flow, plus dirs + rich callbacks). */
  async function promptLoop(
    tool: Tool,
    input: Record<string, unknown>,
    label: string,
    preview: string | undefined,
    styledDiff: readonly string[] | undefined,
    outsideDirs: readonly string[],
    dryDiff?: ToolResult['diff'],
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
      throwIfCancelled(opts.signal);
      const answer = await ask(permissions, req);
      throwIfCancelled(opts.signal);
      if (answer.decision === 'deny') {
        return denied(tool, label, answer.reason, cb, reply, toolEvents);
      }
      if (answer.decision === 'allow' || answer.decision === 'allow-session') {
        if (answer.decision === 'allow-session' && tool.neverAutoAllow !== true) {
          allows.remember(tool.kind, tool.name, label);
          // The content this approved change leaves on disk — the baseline a
          // later same-label call is checked against before it may skip the
          // prompt (an external edit since then re-asks instead of clobbering).
          if (dryDiff !== undefined && dryDiff !== null) {
            allows.rememberBaseline(tool.kind, tool.name, label, dryDiff.after);
          }
          cb.onActivity?.('· allowed for this session');
        }
        return await runApproved(
          tool,
          input,
          label,
          reply,
          toolEvents,
          cb,
          opts,
          outsideDirs,
          dryDiff,
        );
      }
      // 'edit' (exec tools only): replace the command, dry-run, ask again.
      throwIfCancelled(opts.signal);
      const replacement = await permissions.replacement(String(input['command'] ?? ''));
      throwIfCancelled(opts.signal);
      if (replacement === null) {
        cb.onActivity?.('· edit cancelled — treating as no');
        cb.onToolResult?.({
          name: tool.name,
          label,
          kind: tool.kind,
          ok: false,
          summary: 'denied by user',
        });
        reply('Permission denied by user.');
        toolEvents.push({ name: tool.name, label, ok: false, summary: 'denied by user' });
        return 'denied';
      }
      input = { ...input, command: replacement };
      label = tool.permissionLabel(input);
      const reDry = await previewTool(input, outsideDirs);
      if (!reDry.ok) {
        cb.onToolResult?.({
          name: tool.name,
          label,
          kind: tool.kind,
          ok: false,
          summary: reDry.summary,
        });
        reply(reDry.summary);
        toolEvents.push({ name: tool.name, label, ok: false, summary: reDry.summary });
        return 'failed';
      }
      preview = reDry.preview ?? reDry.summary;
      dryDiff = reDry.diff;
      styledDiff =
        reDry.diff !== undefined
          ? opts.renderDiff?.(reDry.diff.before, reDry.diff.after, reDry.diff.path)
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
  /**
   * The dry run's diff payload, when one happened (the remove tool's real run
   * carries no diff — its dry-run payload is the display's only source).
   */
  dryDiff?: ToolResult['diff'],
): Promise<CallOutcome> {
  const freshLabel = tool.permissionLabel(input);
  throwIfCancelled(opts.signal);
  const result = await tool.run(input, {
    cwd: opts.cwd,
    dryRun: false,
    outsideDirs,
    signal: opts.signal,
    // Stale-edit baseline (v2.1.1): the approved dry run's `before` — write
    // tools refuse the real write when the bytes on disk moved since the
    // preview. Undefined when no dry run carried a diff (a >256 KB target);
    // the write then proceeds without the check, as before.
    expectedBefore: dryDiff?.before,
  });
  // The real run's own payload wins; the dry run's is the display fallback.
  const payload = result.diff ?? dryDiff;
  const styledDiff =
    payload !== undefined
      ? opts.renderDiff?.(payload.before, payload.after, payload.path)
      : undefined;
  // v1.3: checkpoint successful file changes for /undo (the review-apply path
  // checkpoints itself — this covers the classic gate). Only the REAL run's
  // payload checkpoints: a dry-run fallback (remove) changes display only.
  if (result.ok && result.diff !== undefined && opts.onFileChange !== undefined) {
    opts.onFileChange({
      path: result.diff.path ?? freshLabel,
      before: result.diff.before,
      after: result.diff.after,
      kind: result.diff.kind ?? (result.diff.before === '' ? 'created' : 'modified'),
    });
  }
  cb.onToolResult?.({
    name: tool.name,
    label: freshLabel,
    kind: tool.kind,
    ok: result.ok,
    summary: result.summary,
    content: result.content,
    diff: styledDiff,
    diffPayload: payload,
  });
  reply(result.content ?? result.summary);
  toolEvents.push({ name: tool.name, label: freshLabel, ok: result.ok, summary: result.summary });
  throwIfCancelled(opts.signal);
  return result.ok ? 'succeeded' : 'failed';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
