/**
 * spawn_agent — the subagent tool (v1.0). The model delegates a self-contained
 * task to a NESTED agent loop: fresh history [{role:user, task}], a filtered
 * toolset (never spawn_agent itself — recursion is refused, one level of
 * delegation), the same cwd, the same permission gate and session memory as
 * the parent.
 *
 * Why 'exec' + neverAutoAllow: a subagent can do ANYTHING its toolset allows
 * (writes, commands) under the same permission prompts, so spawning one is
 * at least as sensitive as a shell command. Every spawn asks — an 'a' answer
 * on one task must not blanket a different task later.
 *
 * The nested loop is a real runAgentLoop: its turns stream through
 * `onSubEvent` (status/activity lines, the parent's UI shows them indented),
 * its usage is folded into the parent's totals via `onSubUsage`, and its
 * final report (the last assistant text) is the tool's content back to the
 * parent model.
 *
 * Input is untrusted model JSON: fields are checked with Object.hasOwn +
 * typeof before use; a bad shape is an honest {ok:false} result, never a
 * crash. Dry runs describe the delegation and never touch the network.
 */

import type { ChatMessage } from '../../api/endpoints/chat.js';
import type { PermissionAsker } from '../permissions.js';
import { SessionAllows } from '../permissions.js';
import { runAgentLoop, DEFAULT_MAX_TURNS } from '../loop.js';
import type { Tool, ToolResult } from '../tool.js';

const TASK_LABEL_CAP = 48;
const SUBAGENT_MAX_TURNS_CAP = 12;

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

export function makeSubagentTool(deps: SubagentDeps): Tool {
  return {
    name: 'spawn_agent',
    description:
      'Delegate a self-contained task to a helper agent (a nested agent loop) that runs to completion with its own fresh context and returns its final report as text. Use for independent, parallelizable subtasks (e.g. "find every TODO in src/", "draft release notes from git log") you do NOT need to interleave with this conversation. The helper has the same tools (minus spawn_agent — no nested delegation), the same working directory, and asks the user for permission exactly like this conversation does. The task string must be fully self-contained: the helper sees ONLY it.',
    kind: 'exec',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description:
            'The complete, self-contained instruction for the helper agent — it sees only this text, so include all paths, context, and the expected output format.',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional: restrict the helper to these tool names (e.g. ["read_file","grep"]). Omit to give it the full built-in set (minus spawn_agent).',
        },
      },
      required: ['task'],
    },
    permissionLabel: (input: unknown) => {
      const o = rec(input);
      const task = o !== null && typeof o['task'] === 'string' ? o['task'] : '';
      return `spawn_agent(${clip(task, TASK_LABEL_CAP)})`;
    },
    neverAutoAllow: true,
    run: async (input: unknown, ctx): Promise<ToolResult> => {
      const o = rec(input);
      if (o === null) return badShape('spawn_agent: expected a JSON object.');
      if (!Object.hasOwn(o, 'task') || typeof o['task'] !== 'string') {
        return badShape('spawn_agent: missing required string field "task".');
      }
      const task = o['task'];
      if (task.trim() === '') return badShape('spawn_agent: "task" must not be empty.');

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
      const subTools = toolNames === undefined
        ? subToolsAll
        : subToolsAll.filter((t) => toolNames!.includes(t.name));

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
          signal: deps.signal?.(),
          callbacks: {
            onDelta: () => {
              // The sub's reply text streams only into its final report; the
              // parent UI shows activity lines, not a second live transcript.
            },
            onActivity: (line) => emit(`sub: ${line}`),
            onToolStart: (name, l) => emit(`sub: → ${name}(${clip(l, 60)})`),
            onToolResult: (info) => {
              emit(`sub: ${info.ok ? '·' : '✗'} ${clip(info.summary, 90)}`);
              deps.onSubUsage?.({ totalTokens: 0, charge: undefined });
            },
            onTurnComplete: (totals) => {
              deps.onSubUsage?.({
                totalTokens: totals.totalTokens,
                charge:
                  totals.totalChargeMicro !== undefined
                    ? (totals.totalChargeMicro / 1_000_000n).toString()
                    : undefined,
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
}
