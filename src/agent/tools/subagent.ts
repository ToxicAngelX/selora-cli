/**
 * spawn_agent — the subagent tool (v1.0, batch mode v2.2). The model delegates
 * a self-contained task to a NESTED agent loop: fresh history [{role:user,
 * task}], a filtered toolset (never spawn_agent itself — recursion is refused,
 * one level of delegation), the same cwd, the same permission gate and session
 * memory as the parent.
 *
 * v2.2 batch mode: `tasks: string[]` (2–5) runs one helper per task under a
 * single approval. The batch runs CONCURRENTLY (at most 3 in flight, the rest
 * queue) ONLY when the effective toolset of every helper is read-only — the
 * kind:'read' tools minus the network fetchers (web_search/web_fetch): tools
 * that never mutate the tree and never fetch. Any write/exec/web tool in the
 * effective set runs the batch SEQUENTIALLY (one helper after another,
 * exactly like repeated single spawns): the line-based permission asker
 * cannot serve two prompts at once, and concurrent mutation of one working
 * tree is forbidden. --yes/auto mode does NOT relax that gate. Concurrent
 * helpers share a SERIALIZING permission wrapper, so even a prompt that does
 * fire (manual mode, outside-root read) is served one at a time.
 *
 * Failure isolation: batch helpers settle independently (Promise.allSettled
 * semantics) — one helper's failure never kills the others; the aggregated
 * result reports every task in ORDER with its own ok/fail, turns, and report.
 *
 * Why 'exec' + neverAutoAllow: a subagent can do ANYTHING its toolset allows
 * (writes, commands) under the same permission prompts, so spawning one is
 * at least as sensitive as a shell command. Every spawn asks — an 'a' answer
 * on one task must not blanket a different task later. A batch asks ONCE for
 * the whole batch.
 *
 * The nested loop is a real runAgentLoop: its turns stream through
 * `onSubEvent` (status/activity lines, the parent's UI shows them indented —
 * batch mode prefixes each line with its helper's index, `sub[2]: → …`), its
 * usage is folded into the parent's totals via `onSubUsage`, and its final
 * report (the last assistant text) is the tool's content back to the parent
 * model.
 *
 * Input is untrusted model JSON: fields are checked with Object.hasOwn +
 * typeof before use; a bad shape is an honest {ok:false} result, never a
 * crash. Dry runs describe the delegation (batch mode also names the mode —
 * parallel/sequential — and why) and never touch the network.
 */

import type { ChatMessage } from '../../api/endpoints/chat.js';
import type { PermissionAsker } from '../permissions.js';
import { SessionAllows } from '../permissions.js';
import { runAgentLoop, DEFAULT_MAX_TURNS } from '../loop.js';
import type { Tool, ToolResult } from '../tool.js';

const TASK_LABEL_CAP = 48;
const SUBAGENT_MAX_TURNS_CAP = 12;
/** v2.2: at most this many helpers of a batch run CONCURRENTLY; the rest queue. */
const SUBAGENT_PARALLEL_LIMIT = 3;
/** v2.2: batch size bounds — below 2 it is a single task; above 5 the fan-out is unreadable. */
const SUBAGENT_TASKS_MIN = 2;
const SUBAGENT_TASKS_MAX = 5;
/** v2.2: per-task report clip inside the aggregated batch result. */
const SUBAGENT_REPORT_CAP = 2000;

/**
 * v2.2 parallelism gate — the fetchers: kind 'read' by permission class, but
 * they hit the network, and a batch that can fetch runs sequentially like any
 * write-capable one. Everything ELSE with kind 'read' (read_file, list_dir,
 * glob, grep, git_status, git_diff, git_log — see tools/index.ts) neither
 * mutates the tree nor touches the network: safe to run concurrently.
 */
const NETWORK_TOOLS: ReadonlySet<string> = new Set(['web_search', 'web_fetch']);

/** Read-only AND offline — the only tools allowed to run concurrently. */
function isParallelSafe(tool: Tool): boolean {
  return tool.kind === 'read' && !NETWORK_TOOLS.has(tool.name);
}

/**
 * v2.2: serialize permission asks across concurrent helpers. The interactive
 * asker owns ONE stdin (a line queue or a raw-mode menu) — two prompts at
 * once would interleave beyond reading. Parallel batches share this wrapper;
 * asks queue in arrival order. (Sequential batches and single helpers use the
 * gate directly, exactly as before; in the chat modes reads auto-allow and
 * nothing ever hits the queue.)
 */
function serializeAsker(base: PermissionAsker): PermissionAsker {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>): Promise<T> => {
    const p = tail.then(fn);
    tail = p.catch(() => undefined);
    return p;
  };
  const wrapped: PermissionAsker = {
    ask: (req) => enqueue(() => base.ask(req)),
    replacement: (current) => enqueue(() => base.replacement(current)),
  };
  if (base.askDetailed !== undefined) {
    const detailed = base.askDetailed;
    wrapped.askDetailed = (req) => enqueue(() => detailed(req));
  }
  if (base.close !== undefined) wrapped.close = base.close;
  return wrapped;
}

/** Everything the nested loop needs — injected by the command layer. */
export interface SubagentDeps {
  client: Parameters<typeof runAgentLoop>[0]['client'];
  /** The model the sub runs as (a getter — /model can switch it mid-session). */
  model: () => string;
  /** The parent's permission gate (already mode-wrapped in chat). */
  permissions: PermissionAsker;
  /** The parent's session memory — grants carry into the sub. */
  allows: SessionAllows;
  renderDiff?: ((before: string, after: string) => readonly string[]) | undefined;
  /** Status lines for the parent's UI: '· sub: → read_file(x)' etc. */
  onSubEvent?: (line: string) => void;
  /** Per-turn usage of the sub loop, folded into the parent totals. */
  onSubUsage?: (usage: { totalTokens: number; charge: string | undefined }) => void;
  /** The CURRENT abort controller's signal (the turn's; a getter, it changes per turn). */
  signal?: (() => AbortSignal | undefined) | undefined;
  /** --yes at the loop level auto-approves the sub's tools too. */
  autoApprove: boolean;
  /** The parent's full tool list — the sub gets it minus spawn_agent. */
  parentTools: readonly Tool[];
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function badShape(message: string): ToolResult {
  return { ok: false, summary: message };
}

function clip(s: string, cap: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length <= cap ? one : `${one.slice(0, cap - 1)}…`;
}

/** Length cap that PRESERVES newlines (report bodies — clip() is for labels). */
function clipKeepLines(s: string, cap: number): string {
  return s.length <= cap ? s : `${s.slice(0, cap - 1)}…`;
}

export function makeSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: 'spawn_agent',
    description:
      'Delegate self-contained work to helper agents (nested agent loops) that run to completion with their own fresh context and return their final report as text. Use for independent, parallelizable subtasks (e.g. "find every TODO in src/", "draft release notes from git log") you do NOT need to interleave with this conversation. Pass "task" for ONE helper, or "tasks" (2–5) for a batch under a single approval: with a read-only "tools" list (read_file, list_dir, glob, grep, git_status, git_diff, git_log) the batch runs in PARALLEL (max 3 at a time); any write/exec/web tool makes it sequential. Helpers have the same tools (minus spawn_agent — no nested delegation), the same working directory, and ask the user for permission exactly like this conversation does. Every task string must be fully self-contained: a helper sees ONLY its task.',
    kind: 'exec',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete, self-contained instruction for the helper agent — it sees only this text, so include all paths, context, and the expected output format.',
        },
        tasks: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional batch: 2–5 self-contained tasks, one helper agent each, ONE approval covering the whole batch. Runs in parallel (max 3 concurrently) only when "tools" is read-only; otherwise sequential. Pass either "task" or "tasks", never both.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: restrict the helper(s) to these tool names (e.g. ["read_file","grep"]). Omit to give them the full built-in set (minus spawn_agent). A batch runs in parallel only when every named tool is read-only and offline (read_file, list_dir, glob, grep, git_status, git_diff, git_log).',
        },
      },
    },
    permissionLabel: (input: unknown) => {
      const o = rec(input);
      if (o !== null && Object.hasOwn(o, 'tasks') && Array.isArray(o['tasks'])) {
        const raw: unknown[] = o['tasks'];
        const labels = raw
          .filter((x): x is string => typeof x === 'string')
          .map((t) => clip(t, 24));
        if (labels.length > 0) {
          return clip(`spawn_agent(${raw.length} tasks: ${labels.join('; ')})`, 140);
        }
      }
      const task = o !== null && typeof o['task'] === 'string' ? o['task'] : '';
      return `spawn_agent(${clip(task, TASK_LABEL_CAP)})`;
    },
    neverAutoAllow: true,
    run: async (input: unknown, ctx): Promise<ToolResult> => {
      const o = rec(input);
      if (o === null) return badShape('spawn_agent: expected a JSON object.');
      const hasTask = Object.hasOwn(o, 'task');
      const hasTasks = Object.hasOwn(o, 'tasks');
      if (hasTask && hasTasks) {
        return badShape(
          'spawn_agent: pass either "task" (one helper) or "tasks" (a 2–5 helper batch) — not both.',
        );
      }

      let batchTasks: string[] | undefined;
      let task = '';
      if (hasTasks) {
        const rawTasks = o['tasks'];
        if (!Array.isArray(rawTasks)) {
          return badShape('spawn_agent: "tasks" must be an array of 2–5 task strings.');
        }
        if (rawTasks.length < SUBAGENT_TASKS_MIN || rawTasks.length > SUBAGENT_TASKS_MAX) {
          return badShape(
            `spawn_agent: "tasks" must contain ${SUBAGENT_TASKS_MIN}–${SUBAGENT_TASKS_MAX} entries (got ${rawTasks.length}).`,
          );
        }
        if (rawTasks.some((x) => typeof x !== 'string')) {
          return badShape('spawn_agent: every "tasks" entry must be a string.');
        }
        const strings = rawTasks as string[];
        if (strings.some((t) => t.trim() === '')) {
          return badShape('spawn_agent: "tasks" entries must not be empty.');
        }
        const seen = new Set<string>();
        let duplicate = false;
        for (const t of strings) {
          const key = t.replace(/\s+/g, ' ').trim();
          if (seen.has(key)) {
            duplicate = true;
            break;
          }
          seen.add(key);
        }
        if (duplicate) {
          return badShape(
            'spawn_agent: "tasks" contains a duplicate entry — each helper needs its own task.',
          );
        }
        batchTasks = strings;
      } else {
        if (!hasTask || typeof o['task'] !== 'string') {
          return badShape('spawn_agent: missing required string field "task".');
        }
        task = o['task'];
        if (task.trim() === '') return badShape('spawn_agent: "task" must not be empty.');
      }

      // The tool list the sub runs with — the parent's set minus spawn_agent.
      const parentTools = deps.parentTools;
      const subToolsAll = parentTools.filter((t) => t.name !== 'spawn_agent');
      if (subToolsAll.length === 0) {
        return badShape('spawn_agent: no tools available to delegate to.');
      }

      let toolNames: readonly string[] | undefined;
      if (Object.hasOwn(o, 'tools')) {
        const raw = o['tools'];
        if (!Array.isArray(raw) || raw.some((x) => typeof x !== 'string')) {
          return badShape('spawn_agent: "tools" must be an array of tool name strings.');
        }
        toolNames = raw as string[];
        const unknown = toolNames.filter((n) => !subToolsAll.some((t) => t.name === n));
        if (unknown.length > 0) {
          return badShape(`spawn_agent: unknown tool(s): ${unknown.join(', ')}.`);
        }
        if (toolNames.length === 0) {
          return badShape('spawn_agent: "tools" must name at least one tool.');
        }
      }
      const subTools =
        toolNames === undefined
          ? subToolsAll
          : subToolsAll.filter((t) => toolNames!.includes(t.name));

      if (batchTasks !== undefined) {
        return runBatch(batchTasks, subTools, ctx);
      }

      const label = clip(task, TASK_LABEL_CAP);
      if (ctx.dryRun) {
        const names = subTools.map((t) => t.name).join(', ');
        return {
          ok: true,
          summary: `would run a helper agent: ${label}`,
          preview: [
            'delegate to a helper agent (nested agent loop):',
            `task: ${clip(task, 400)}`,
            `tools: ${names}`,
            `model: ${deps.model()}`,
            'the helper asks for permission through the same prompts',
          ].join('\n'),
        };
      }

      // Real run: a nested agent loop with a fresh, task-only history.
      const messages: ChatMessage[] = [{ role: 'user', content: task }];
      const emit = (line: string): void => {
        deps.onSubEvent?.(line);
      };
      emit(`· sub started: ${label}`);
      try {
        const result = await runAgentLoop({
          client: deps.client,
          model: deps.model(),
          messages,
          tools: subTools,
          maxTurns: Math.min(SUBAGENT_MAX_TURNS_CAP, DEFAULT_MAX_TURNS),
          cwd: ctx.cwd,
          permissions: deps.permissions,
          autoApprove: deps.autoApprove,
          allows: deps.allows,
          renderDiff: deps.renderDiff,
          signal: ctx.signal ?? deps.signal?.(),
          callbacks: {
            onDelta: () => {
              // The sub's reply text streams only into its final report; the
              // parent UI shows activity lines, not a second live transcript.
            },
            onActivity: (line) => emit(`sub: ${line}`),
            onToolStart: (_name, label) => emit(`sub: → ${clip(label, 60)}`),
            onToolResult: (info) => {
              emit(`sub: ${info.ok ? '·' : '✗'} ${clip(info.summary, 90)}`);
            },
            onTurnComplete: (totals) => {
              deps.onSubUsage?.({
                totalTokens: totals.usage?.totalTokens ?? 0,
                charge: totals.charge,
              });
            },
          },
        });
        emit(
          `· sub finished (${result.turns} turns, stop: ${result.stop}): ${clip(result.content, 60)}`,
        );
        const report =
          result.content.trim() !== ''
            ? result.content.trim()
            : '(the helper produced no final text)';
        return {
          ok: true,
          summary: `helper agent finished (${result.turns} turns): ${clip(result.content, TASK_LABEL_CAP)}`,
          content: report,
        };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        emit(`· sub failed: ${clip(text, 90)}`);
        return { ok: false, summary: `helper agent failed: ${clip(text, 200)}` };
      }
    },
  };

  /**
   * v2.2 batch mode: one helper per task. CONCURRENT (max SUBAGENT_PARALLEL_
   * LIMIT in flight) only when every effective tool is read-only and offline;
   * SEQUENTIAL otherwise. Every slot settles independently; the aggregated
   * result lists every task in order with its own outcome.
   */
  async function runBatch(
    tasks: readonly string[],
    subTools: readonly Tool[],
    ctx: Parameters<Tool['run']>[1],
  ): Promise<ToolResult> {
    const parallel = subTools.every(isParallelSafe);
    const names = subTools.map((t) => t.name).join(', ');

    if (ctx.dryRun) {
      const modeLine = parallel
        ? 'mode: PARALLEL (max 3 at once — every tool is read-only and offline: no writes, no commands, no fetch)'
        : 'mode: SEQUENTIAL (the toolset can write, execute commands, or fetch — concurrent mutation of one working tree is forbidden)';
      return {
        ok: true,
        summary: `would run ${tasks.length} helper agents (${parallel ? 'parallel' : 'sequential'})`,
        preview: [
          `delegate a ${tasks.length}-task batch to helper agents (nested agent loops):`,
          modeLine,
          'tasks:',
          ...tasks.map((t, i) => `  ${i + 1}. ${clip(t, 120)}`),
          `tools: ${names}`,
          `model: ${deps.model()}`,
          'one approval covers the whole batch; helpers ask for permission through the same prompts',
        ].join('\n'),
      };
    }

    // Parallel helpers share a SERIALIZING permission wrapper: the asker owns
    // one stdin, so even a prompt that does fire (manual mode, an outside-root
    // read) is served one at a time. Sequential batches use the gate directly.
    const permissions = parallel ? serializeAsker(deps.permissions) : deps.permissions;
    const signal = ctx.signal ?? deps.signal?.();

    interface SlotResult {
      ok: boolean;
      turns: number;
      report: string;
      error?: string | undefined;
    }
    const slots: (SlotResult | undefined)[] = tasks.map(() => undefined);
    const emit = (line: string): void => {
      deps.onSubEvent?.(line);
    };

    const runOne = async (index: number, taskText: string): Promise<void> => {
      const tag = `sub[${index + 1}]`;
      if (signal?.aborted === true) {
        emit(`· ${tag} cancelled before start`);
        slots[index] = { ok: false, turns: 0, report: '', error: 'cancelled before start' };
        return;
      }
      emit(`· ${tag} started: ${clip(taskText, TASK_LABEL_CAP)}`);
      try {
        const messages: ChatMessage[] = [{ role: 'user', content: taskText }];
        const result = await runAgentLoop({
          client: deps.client,
          model: deps.model(),
          messages,
          tools: [...subTools],
          maxTurns: Math.min(SUBAGENT_MAX_TURNS_CAP, DEFAULT_MAX_TURNS),
          cwd: ctx.cwd,
          permissions,
          autoApprove: deps.autoApprove,
          allows: deps.allows,
          renderDiff: deps.renderDiff,
          signal,
          callbacks: {
            onDelta: () => {
              // Same as single mode: sub reply text streams only into its
              // final report; the parent UI shows activity lines.
            },
            onActivity: (line) => emit(`${tag}: ${line}`),
            onToolStart: (_name, toolLabel) => emit(`${tag}: → ${clip(toolLabel, 60)}`),
            onToolResult: (info) => {
              emit(`${tag}: ${info.ok ? '·' : '✗'} ${clip(info.summary, 90)}`);
            },
            onTurnComplete: (totals) => {
              deps.onSubUsage?.({
                totalTokens: totals.usage?.totalTokens ?? 0,
                charge: totals.charge,
              });
            },
          },
        });
        const stopNote = result.stop === 'completed' ? '' : `, stop: ${result.stop}`;
        emit(`· ${tag} finished (${result.turns} turns${stopNote}): ${clip(result.content, 60)}`);
        slots[index] = {
          ok: true,
          turns: result.turns,
          report:
            result.content.trim() !== ''
              ? result.content.trim()
              : '(the helper produced no final text)',
        };
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        emit(`· ${tag} failed: ${clip(text, 90)}`);
        slots[index] = { ok: false, turns: 0, report: '', error: clip(text, 200) };
      }
    };

    if (parallel) {
      // Worker pool: exactly min(LIMIT, tasks) loops pull task indices off one
      // counter — a queued task starts only when an in-flight one settles.
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = nextIndex;
          nextIndex += 1;
          if (i >= tasks.length) return;
          await runOne(i, tasks[i]!);
        }
      };
      const workers: Promise<void>[] = [];
      for (let w = 0; w < Math.min(SUBAGENT_PARALLEL_LIMIT, tasks.length); w += 1) {
        workers.push(worker());
      }
      await Promise.all(workers);
    } else {
      for (let i = 0; i < tasks.length; i += 1) {
        await runOne(i, tasks[i]!);
      }
    }

    // Aggregate in TASK order — one failure never killed the others.
    const settled = slots.map((s) => s ?? { ok: false, turns: 0, report: '', error: 'did not run' });
    const okCount = settled.filter((s) => s.ok).length;
    const blocks = settled.map((s, i) => {
      const head = s.ok
        ? `[${i + 1}] ok · ${s.turns} turn${s.turns === 1 ? '' : 's'} · ${clip(tasks[i]!, 80)}`
        : `[${i + 1}] FAILED · ${clip(tasks[i]!, 80)}`;
      const body = s.ok
        ? clipKeepLines(s.report, SUBAGENT_REPORT_CAP)
        : `error: ${s.error ?? 'unknown'}`;
      return `${head}\n${body}`;
    });
    return {
      ok: okCount === tasks.length,
      summary: `helper batch: ${okCount}/${tasks.length} finished ok (${parallel ? 'parallel' : 'sequential'})`,
      content: blocks.join('\n\n'),
    };
  }
}
