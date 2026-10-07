/**
 * Plan mode (v0.9) at the agent-loop level: with the planGate active, every
 * MUTATING tool call (kind !== 'read') is denied BEFORE any dry run — the
 * label is recorded as a proposal, the model receives the standard reasoned
 * denial ("Permission denied by user. Reason: plan mode: proposal recorded —
 * switch modes (shift+tab) to execute"), and the run continues. Read tools
 * run normally (auto-allowed by the mode asker, never gated by the loop).
 * Plan denials are not failures: the 3-consecutive-failure breaker never
 * counts them. The gate is read live, so a mid-run mode switch bites on the
 * very next call.
 *
 * The loop is driven directly (mock gateway for the stream, real tools, real
 * filesystem) — the exact wiring chat uses.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, type MockServer } from './mock/server.js';
import { FAKE_KEY_USER, REVOKED_KEY_401 } from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { SeloraClient } from '../src/api/client.js';
import { runAgentLoop, type PlanGate } from '../src/agent/loop.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { createModeAsker, PLAN_MODE_DENY_REASON, type PermissionMode } from '../src/agent/modes.js';
import { SessionAllows, type PermissionAsker } from '../src/agent/permissions.js';
import type { ChatMessage } from '../src/api/endpoints/chat.js';

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';

const sseFrame = (o: unknown): string => `data: ${JSON.stringify(o)}\n\n`;

let server: MockServer;
let env: TempEnv;

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
  useApiUrl(server.url);
});

afterAll(async () => {
  cleanup(env.dir);
  await server.close();
});

/** One tool-call round per entry (in order), then the plain text answer. */
function routeRoundsThenAnswer(rounds: Array<{ name: string; args: Record<string, unknown> }>): {
  chatCalls: () => number;
} {
  let calls = 0;
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      const round = rounds[calls];
      calls += 1;
      if (round === undefined) {
        return {
          status: 200,
          sse: [
            sseFrame({
              choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }],
            }),
            'data: [DONE]\n\n',
          ],
        };
      }
      return {
        status: 200,
        sse: [
          sseFrame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
          sseFrame({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_P${calls}`,
                      type: 'function',
                      function: { name: round.name, arguments: JSON.stringify(round.args) },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
          sseFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
          sseFrame({
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
            gateway: { charge: '0.000100' },
          }),
          'data: [DONE]\n\n',
        ],
      };
    }
    return { status: 404, body: NOT_FOUND };
  });
  return { chatCalls: () => calls };
}

interface RunResult {
  stop: string;
  toolEvents: Array<{ name: string; label: string; ok: boolean; summary: string }>;
  messages: ChatMessage[];
  activities: string[];
  proposals: string[];
  asked: number;
}

/**
 * Run the loop exactly like chat wires it: the mode asker over a counting
 * base + the plan gate, both reading the SAME live mode holder.
 */
async function runWithMode(
  modeRef: { mode: PermissionMode },
  cwd: string,
  prompt: string,
): Promise<RunResult> {
  const client = new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER, debug: false });
  const allows = new SessionAllows();
  const activities: string[] = [];
  const proposals: string[] = [];
  let asked = 0;
  const base: PermissionAsker = {
    ask: async () => {
      asked += 1;
      return 'deny';
    },
    askDetailed: async () => {
      asked += 1;
      return { decision: 'deny' };
    },
    replacement: async () => null,
  };
  const permissions = createModeAsker(base, () => modeRef.mode);
  const planGate: PlanGate = {
    isPlanMode: () => modeRef.mode === 'plan',
    onProposal: (label) => {
      proposals.push(label);
    },
  };
  const result = await runAgentLoop({
    client,
    model: 'test-model',
    messages: [{ role: 'user', content: prompt }],
    tools: builtinTools(),
    maxTurns: 8,
    cwd,
    permissions,
    autoApprove: false,
    callbacks: {
      onDelta: () => {},
      onActivity: (line) => activities.push(line),
      onTurnComplete: () => {},
    },
    allows,
    planGate,
  });
  return { ...result, activities, proposals, asked };
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-plan-'));
}

describe('plan mode — the loop gate', () => {
  it('a write is proposed, NOT executed, recorded, and the model sees the spec reason', async () => {
    const cwd = tempProject();
    try {
      routeRoundsThenAnswer([{ name: 'write_file', args: { path: 'out.txt', content: 'nope\n' } }]);
      const run = await runWithMode({ mode: 'plan' }, cwd, 'write a file');

      // never executed — not even the dry-run path reached the real write
      expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
      // recorded as a proposal with the tool's label
      expect(run.proposals).toEqual(['write_file(out.txt)']);
      // the model received the standard reasoned denial, verbatim reason
      const toolMsg = run.messages.find((m) => m.role === 'tool');
      expect(toolMsg !== undefined && toolMsg.role === 'tool' ? toolMsg.content : '').toBe(
        `Permission denied by user. Reason: ${PLAN_MODE_DENY_REASON}`,
      );
      // the tool event is an honest denial, not a failure
      expect(run.toolEvents[0]?.ok).toBe(false);
      expect(run.toolEvents[0]?.summary).toBe('plan mode: proposal recorded — not executed');
      expect(run.activities).toContain('· plan mode: proposal recorded — not executed');
      // the run continued to a clean completion; no human was asked
      expect(run.stop).toBe('completed');
      expect(run.asked).toBe(0);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('exec (run_command) is proposed, not executed', async () => {
    const cwd = tempProject();
    try {
      routeRoundsThenAnswer([{ name: 'run_command', args: { command: 'touch marker.txt' } }]);
      const run = await runWithMode({ mode: 'plan' }, cwd, 'run something');
      expect(existsSync(join(cwd, 'marker.txt'))).toBe(false);
      expect(run.proposals).toEqual(['run_command(touch marker.txt)']);
      expect(run.stop).toBe('completed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('reads run normally in plan mode — auto-allowed, never gated, real content returned', async () => {
    const cwd = tempProject();
    writeFileSync(join(cwd, 'note.txt'), 'the real content\n', 'utf8');
    try {
      routeRoundsThenAnswer([{ name: 'read_file', args: { path: 'note.txt' } }]);
      const run = await runWithMode({ mode: 'plan' }, cwd, 'read the note');
      expect(run.proposals).toEqual([]);
      expect(run.toolEvents[0]?.ok).toBe(true);
      const toolMsg = run.messages.find((m) => m.role === 'tool');
      expect(toolMsg !== undefined && toolMsg.role === 'tool' ? toolMsg.content : '').toContain(
        'the real content',
      );
      expect(run.asked).toBe(0);
      expect(run.stop).toBe('completed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('three consecutive plan denials do NOT trip the failure breaker (denied ≠ failed)', async () => {
    const cwd = tempProject();
    try {
      routeRoundsThenAnswer([
        { name: 'write_file', args: { path: 'a.txt', content: 'x' } },
        { name: 'write_file', args: { path: 'b.txt', content: 'x' } },
        { name: 'write_file', args: { path: 'c.txt', content: 'x' } },
      ]);
      const run = await runWithMode({ mode: 'plan' }, cwd, 'write three files');
      expect(run.proposals).toEqual([
        'write_file(a.txt)',
        'write_file(b.txt)',
        'write_file(c.txt)',
      ]);
      expect(run.stop).toBe('completed'); // NOT 'tool-failures'
      expect(existsSync(join(cwd, 'a.txt'))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('the gate is read LIVE: switching plan → auto mid-run executes the very next write', async () => {
    const cwd = tempProject();
    try {
      routeRoundsThenAnswer([
        { name: 'write_file', args: { path: 'first.txt', content: 'planned\n' } },
        { name: 'write_file', args: { path: 'second.txt', content: 'executed\n' } },
      ]);
      const modeRef: { mode: PermissionMode } = { mode: 'plan' };
      const client = new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER, debug: false });
      const proposals: string[] = [];
      const result = await runAgentLoop({
        client,
        model: 'test-model',
        messages: [{ role: 'user', content: 'two writes' }],
        tools: builtinTools(),
        maxTurns: 8,
        cwd,
        permissions: createModeAsker(
          { ask: async () => 'deny', replacement: async () => null },
          () => modeRef.mode,
        ),
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
        },
        planGate: {
          isPlanMode: () => modeRef.mode === 'plan',
          onProposal: (label) => {
            proposals.push(label);
            // the first proposal was recorded — the user switches to auto
            modeRef.mode = 'auto';
          },
        },
      });
      expect(proposals).toEqual(['write_file(first.txt)']);
      expect(existsSync(join(cwd, 'first.txt'))).toBe(false); // proposed only
      expect(readFileSync(join(cwd, 'second.txt'), 'utf8')).toBe('executed\n'); // ran in auto
      expect(result.stop).toBe('completed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('no gate attached (the run command path): a write in "plan mode" still asks the human', async () => {
    const cwd = tempProject();
    try {
      routeRoundsThenAnswer([{ name: 'write_file', args: { path: 'out.txt', content: 'x\n' } }]);
      // planGate absent — createModeAsker alone must not silently execute:
      // the mode wrap delegates the write to the base asker (deny here).
      const client = new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER, debug: false });
      let asked = 0;
      const result = await runAgentLoop({
        client,
        model: 'test-model',
        messages: [{ role: 'user', content: 'write' }],
        tools: builtinTools(),
        maxTurns: 8,
        cwd,
        permissions: createModeAsker(
          {
            ask: async () => {
              asked += 1;
              return 'deny';
            },
            replacement: async () => null,
          },
          () => 'plan',
        ),
        autoApprove: false,
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      expect(asked).toBe(1); // delegated to the human, NOT executed
      expect(existsSync(join(cwd, 'out.txt'))).toBe(false);
      expect(result.toolEvents[0]?.summary).toBe('denied by user');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
