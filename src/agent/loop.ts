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
import type { Tool } from './tool.js';
import {
  createAutoAsker,
  SessionAllows,
  type PermissionAsker,
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
  onActivity: (line: string) => void;
  /** After each stream turn: per-turn usage/charge AND the running totals. */
  onTurnComplete: (totals: AgentUsageTotals) => void;
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
  callbacks: AgentLoopCallbacks;
  signal?: AbortSignal | undefined;
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
  const allows = new SessionAllows();
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

    for (const call of result.toolCalls) {
      const outcome = await executeToolCall(opts, permissions, allows, call, history, toolEvents);
      if (outcome === 'failed') {
        consecutiveFailures += 1;
      } else if (outcome === 'succeeded') {
        consecutiveFailures = 0;
      } // 'denied' leaves the failure counter untouched
      if (consecutiveFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
        return finish('tool-failures', turn);
      }
    }

    if (turn === opts.maxTurns) {
      // No stream turns left — the requested tools cannot be answered. The
      // dangling tool_calls are dropped (content-only message kept).
      history[history.length - 1] = { role: 'assistant', content: turnContent };
      return finish('max-turns', turn);
    }
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
    cb.onActivity(`→ ${call.name}() — no such tool`);
    const text = `Unknown tool "${call.name}". Available tools: ${available}.`;
    cb.onActivity(`✗ ${text}`);
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
      cb.onActivity(`→ ${tool.name}(…) — invalid arguments`);
      cb.onActivity(`✗ ${text}`);
      reply(text);
      toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
      return 'failed';
    }
  }
  if (parsed === null) {
    const text = `Invalid tool arguments for ${tool.name}: expected a JSON object.`;
    cb.onActivity(`✗ ${text}`);
    reply(text);
    toolEvents.push({ name: tool.name, label: `${tool.name}()`, ok: false, summary: text });
    return 'failed';
  }

  let input: Record<string, unknown> = parsed;
  let label = tool.permissionLabel(input);
  cb.onActivity(`→ ${label}`);

  // Session auto-allow from an earlier 'a' answer (memory-only).
  if (allows.check(tool.kind, tool.name, label)) {
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts);
  }

  if (opts.autoApprove) {
    return await runApproved(tool, input, label, reply, toolEvents, cb, opts);
  }

  // Dry run first — its result is the permission prompt's preview, and an
  // {ok:false} dry run (bad path, missing file, …) never even prompts.
  let preview: string | undefined = undefined;
  const dry = await tool.run(input, { cwd, dryRun: true });
  if (!dry.ok) {
    cb.onActivity(`✗ ${dry.summary}`);
    reply(dry.summary);
    toolEvents.push({ name: tool.name, label, ok: false, summary: dry.summary });
    return 'failed';
  }
  preview = dry.preview ?? dry.summary;

  for (;;) {
    const req: PermissionRequest = {
      label,
      kind: tool.kind,
      preview,
      offerEdit: tool.kind === 'exec',
    };
    const decision = await permissions.ask(req);
    if (decision === 'deny') {
      cb.onActivity('· denied by user');
      reply('Permission denied by user.');
      toolEvents.push({ name: tool.name, label, ok: false, summary: 'denied by user' });
      return 'denied';
    }
    if (decision === 'allow' || decision === 'allow-session') {
      if (decision === 'allow-session') {
        allows.remember(tool.kind, tool.name, label);
        cb.onActivity('· allowed for this session');
      }
      return await runApproved(tool, input, label, reply, toolEvents, cb, opts);
    }
    // 'edit' (exec tools only): replace the command, dry-run, ask again.
    const replacement = await permissions.replacement(String(input['command'] ?? ''));
    if (replacement === null) {
      cb.onActivity('· edit cancelled — treating as no');
      reply('Permission denied by user.');
      toolEvents.push({ name: tool.name, label, ok: false, summary: 'denied by user' });
      return 'denied';
    }
    input = { ...input, command: replacement };
    label = tool.permissionLabel(input);
    cb.onActivity(`→ ${label}`);
    const reDry = await tool.run(input, { cwd, dryRun: true });
    if (!reDry.ok) {
      cb.onActivity(`✗ ${reDry.summary}`);
      reply(reDry.summary);
      toolEvents.push({ name: tool.name, label, ok: false, summary: reDry.summary });
      return 'failed';
    }
    preview = reDry.preview ?? reDry.summary;
  }
}

async function runApproved(
  tool: Tool,
  input: Record<string, unknown>,
  label: string,
  reply: (text: string) => void,
  toolEvents: AgentToolEvent[],
  cb: AgentLoopCallbacks,
  opts: AgentLoopOptions,
): Promise<CallOutcome> {
  const freshLabel = tool.permissionLabel(input);
  if (freshLabel !== label) cb.onActivity(`→ ${freshLabel}`);
  const result = await tool.run(input, { cwd: opts.cwd, dryRun: false });
  cb.onActivity(result.ok ? `· ${result.summary}` : `✗ ${result.summary}`);
  reply(result.content ?? result.summary);
  toolEvents.push({ name: tool.name, label: freshLabel, ok: result.ok, summary: result.summary });
  return result.ok ? 'succeeded' : 'failed';
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
