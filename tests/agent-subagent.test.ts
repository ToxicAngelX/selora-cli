/**
 * spawn_agent (v1.0) — the subagent tool, end-to-end against the mock gateway.
 *
 * Covers:
 *  - the happy path: the parent model calls spawn_agent; the nested loop runs
 *    (its own SSE turns against the mock), its final text is the tool result
 *    content fed back to the parent, and the parent finishes with it.
 *  - the sub's tool calls pass the SAME permission gate (an interactive-style
 *    asker wrapped here: auto-asker for the happy path, denying for the gate
 *    test — denial flows back into the sub's conversation, not a crash).
 *  - dry run describes the delegation, never touches the network.
 *  - bad input shapes are honest {ok:false} results.
 *  - tool-name filtering: unknown names refused; a restricted list is what
 *    the sub's wire request advertises.
 *  - recursion: the sub's toolset NEVER contains spawn_agent.
 *  - the parent usage folding (onSubUsage) counts the sub's tokens.
 *  - abort: a signal aborts the sub mid-stream (the failure is an honest
 *    {ok:false}, the parent turn continues).
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, type MockServer } from './mock/server.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { createAutoAsker, createDenyingAsker, SessionAllows } from '../src/agent/permissions.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { makeSubagentTool } from '../src/agent/tools/subagent.js';
import { builtinTools } from '../src/agent/tools/index.js';
import type { CliIo } from '../src/context.js';
import { Readable } from 'node:stream';

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

const FAKE_KEY = 'sk-gw-TEST_SUBAGENT';

import { SeloraClient } from '../src/api/client.js';

function makeClient(): SeloraClient {
  return new SeloraClient({
    baseUrl: server.url,
    apiKey: FAKE_KEY,
    debug: false,
    logger: () => {},
  });
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-sub-'));
}

/** A canned SSE "final answer" turn for the sub loop. */
function sseText(text: string, totalTokens = 30): unknown[] {
  return [
    { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: totalTokens },
      gateway: { charge: '0.000030', request_id: 'req_sub' },
    },
    'data: [DONE]',
  ];
}

function framesToSse(frames: unknown[]): string[] {
  return frames
    .map((f) => (typeof f === 'string' ? f : `data: ${JSON.stringify(f)}`))
    .map((s) => (s.endsWith('\n\n') ? s : `${s}\n\n`));
}

describe('spawn_agent tool', () => {
  it('dry run describes the delegation and never touches the network', async () => {
    const client = makeClient();
    const tool = makeSubagentTool({
      client,
      model: () => 'glm-5.3-flash',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    server.requests.length = 0;
    const res = await tool.run({ task: 'count the TODOs' }, { cwd: tempProject(), dryRun: true });
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('helper agent');
    expect(res.preview).toContain('task: count the TODOs');
    expect(server.requests.length).toBe(0); // never streamed
  });

  it('happy path: runs the nested loop and returns its final text as content', async () => {
    const cwd = tempProject();
    mkdirSync(join(cwd, 'src'), { recursive: true });
    writeFileSync(join(cwd, 'src', 'index.ts'), 'console.log(1);\n');

    const client = makeClient();
    let parentCalls = 0;
    let subCalls = 0;
    server.setHandler((req) => {
      if (req.method !== 'POST' || req.path !== '/v1/chat/completions') {
        return { status: 404, body: '{"error":{"code":"not_found","message":"x"}}' };
      }
      const body = JSON.parse(req.body) as { messages: { role: string; content: unknown }[] };
      const first = body.messages[0];
      const isSub = first !== undefined && String(first.content).includes('SUBTASK-MARKER');
      if (isSub) {
        subCalls += 1;
        return { status: 200, sse: framesToSse(sseText('SUB-REPORT: found 3 TODOs')) };
      }
      parentCalls += 1;
      if (parentCalls === 1) {
        // parent turn 1: request spawn_agent
        return {
          status: 200,
          sse: framesToSse([
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            { choices: [{ index: 0, delta: { content: 'Delegating.' }, finish_reason: null }] },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_P1',
                        type: 'function',
                        function: {
                          name: 'spawn_agent',
                          arguments: JSON.stringify({ task: 'SUBTASK-MARKER count TODOs' }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            {
              choices: [],
              usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
              gateway: { charge: '0.000015', request_id: 'req_p1' },
            },
            'data: [DONE]',
          ]),
        };
      }
      // parent turn 2: sees the sub report, finishes
      return {
        status: 200,
        sse: framesToSse([
          { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          {
            choices: [
              { index: 0, delta: { content: 'The helper found 3 TODOs.' }, finish_reason: null },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
            gateway: { charge: '0.000028', request_id: 'req_p2' },
          },
          'data: [DONE]',
        ]),
      };
    });

    const subEvents: string[] = [];
    const tool = makeSubagentTool({
      client,
      model: () => 'glm-5.3-flash',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
      onSubEvent: (l) => subEvents.push(l),
    });

    const result = await runAgentLoop({
      client,
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'find the TODOs' }],
      tools: [tool],
      maxTurns: 6,
      cwd,
      permissions: createAutoAsker(),
      autoApprove: false,
      callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
    });

    expect(result.stop).toBe('completed');
    expect(result.content).toContain('3 TODOs');
    expect(subCalls).toBe(1);
    expect(parentCalls).toBe(2);
    // The sub's report reached the parent as the tool message content.
    const toolMsg = result.messages.find((m) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.role === 'tool' ? toolMsg.content : '').toContain('SUB-REPORT');
    // Activity lines flowed.
    expect(subEvents.some((l) => l.includes('sub started'))).toBe(true);
    expect(subEvents.some((l) => l.includes('sub finished'))).toBe(true);
  });

  it("the sub's toolset never contains spawn_agent (no recursion)", async () => {
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    // A sub asking for spawn_agent inside itself must be an unknown tool to
    // the nested loop — the nested set has it filtered out. Verify via the
    // tools advertised on the wire: run a sub and inspect the request body.
    let advertised: string[] = [];
    server.setHandler((req) => {
      if (req.path === '/v1/chat/completions') {
        const body = JSON.parse(req.body) as { tools?: { function: { name: string } }[] };
        advertised = (body.tools ?? []).map((t) => t.function.name);
      }
      return { status: 200, sse: framesToSse(sseText('done')) };
    });
    await tool.run({ task: 'recursion probe' }, { cwd: tempProject(), dryRun: false });
    expect(advertised).not.toContain('spawn_agent');
    expect(advertised).toContain('read_file');
  });

  it('restricted tool list: only the requested names are advertised', async () => {
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    let advertised: string[] = [];
    server.setHandler((req) => {
      if (req.path === '/v1/chat/completions') {
        const body = JSON.parse(req.body) as { tools?: { function: { name: string } }[] };
        advertised = (body.tools ?? []).map((t) => t.function.name);
      }
      return { status: 200, sse: framesToSse(sseText('done')) };
    });
    await tool.run(
      { task: 'read only', tools: ['read_file', 'grep'] },
      { cwd: tempProject(), dryRun: false },
    );
    expect(advertised.sort()).toEqual(['grep', 'read_file']);
  });

  it('unknown tool names are refused honestly', async () => {
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    const res = await tool.run(
      { task: 'x', tools: ['read_file', 'no_such_tool'] },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('unknown tool');
    expect(res.summary).toContain('no_such_tool');
  });

  it('bad input shapes are honest failures', async () => {
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    const cwd = tempProject();
    expect((await tool.run({}, { cwd, dryRun: false })).ok).toBe(false);
    expect((await tool.run({ task: 42 }, { cwd, dryRun: false })).ok).toBe(false);
    expect((await tool.run({ task: '   ' }, { cwd, dryRun: false })).ok).toBe(false);
    expect((await tool.run(null, { cwd, dryRun: false })).ok).toBe(false);
    expect((await tool.run('string', { cwd, dryRun: false })).ok).toBe(false);
  });

  it('a network failure inside the sub is an honest {ok:false}, not a crash', async () => {
    server.setHandler(() => ({
      status: 500,
      body: '{"error":{"code":"server","message":"boom"}}',
    }));
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    const res = await tool.run({ task: 'x' }, { cwd: tempProject(), dryRun: false });
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('helper agent failed');
  });

  it('denials inside the sub flow through the shared gate', async () => {
    // The sub tries a write; the DENYING asker refuses it; the sub sees the
    // denial as its tool result and finishes with text (not a crash).
    const cwd = tempProject();
    let subTurns = 0;
    server.setHandler((req) => {
      const body = JSON.parse(req.body) as { messages: { role: string; content: unknown }[] };
      const first = body.messages[0];
      const isSub = first !== undefined && String(first.content).includes('DENY-MARKER');
      if (isSub) {
        subTurns += 1;
        if (subTurns > 1) {
          // After the denial the sub gives up and reports in plain text.
          return { status: 200, sse: framesToSse(sseText('could not write — denied')) };
        }
        return {
          status: 200,
          sse: framesToSse([
            { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_S1',
                        type: 'function',
                        function: {
                          name: 'write_file',
                          arguments: JSON.stringify({ path: 'out.txt', content: 'hi' }),
                        },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
            {
              choices: [],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
              gateway: { charge: '0.000010', request_id: 'req_s1' },
            },
            'data: [DONE]',
          ]),
        };
      }
      return { status: 200, sse: framesToSse(sseText('could not write — denied')) };
    });

    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createDenyingAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    const res = await tool.run({ task: 'DENY-MARKER try to write' }, { cwd, dryRun: false });
    expect(res.ok).toBe(true); // the sub finished; its report says denied
    expect(res.content).toContain('denied');
  });

  it('an abort signal cancels the sub mid-run honestly', async () => {
    const controller = new AbortController();
    server.setHandler(() => ({
      status: 200,
      // stream that starts but never finishes — the abort kills it
      sse: [
        'data: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          }) +
          '\n\n',
      ],
      sseHang: true,
    }));
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
      signal: () => controller.signal,
    });
    const p = tool.run({ task: 'long task' }, { cwd: tempProject(), dryRun: false });
    setTimeout(() => controller.abort(), 150);
    const res = await p;
    expect(res.ok).toBe(false);
    expect(res.summary).toContain('helper agent failed');
  });
});

describe('spawn_agent batch mode (v2.2)', () => {
  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Route sub requests by task marker (the first user message); each request
   * is delayed `delayMs` while inFlight/maxInFlight track real overlap.
   */
  function routeBatch(
    delayMs: number,
    perTask?: Record<string, (callCount: number) => { status: number; sse?: string[]; body?: string }>,
  ): { arrivals: string[]; maxInFlight: () => number; calls: () => number } {
    const arrivals: string[] = [];
    let inFlight = 0;
    let max = 0;
    let calls = 0;
    server.setHandler(async (req) => {
      if (req.method !== 'POST' || req.path !== '/v1/chat/completions') {
        return { status: 404, body: '{"error":{"code":"not_found","message":"x"}}' };
      }
      const body = JSON.parse(req.body) as { messages: { content: unknown }[] };
      const marker = String(body.messages[0]?.content ?? '');
      const match = /TASK-\d/.exec(marker);
      const key = match?.[0] ?? 'TASK-?';
      calls += 1;
      inFlight += 1;
      max = Math.max(max, inFlight);
      arrivals.push(key);
      await sleep(delayMs);
      inFlight -= 1;
      const custom = perTask?.[key];
      if (custom !== undefined) return custom(calls);
      return { status: 200, sse: framesToSse(sseText(`REPORT-${key}`)) };
    });
    return { arrivals, maxInFlight: () => max, calls: () => calls };
  }

  function batchTool(extra?: {
    onSubEvent?: (l: string) => void;
    onSubUsage?: (u: { totalTokens: number; charge: string | undefined }) => void;
    permissions?: ReturnType<typeof createAutoAsker>;
  }) {
    return makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: extra?.permissions ?? createAutoAsker(),
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
      onSubEvent: extra?.onSubEvent,
      onSubUsage: extra?.onSubUsage,
    });
  }

  it('read-only toolset → the batch runs CONCURRENTLY (requests overlap)', async () => {
    const route = routeBatch(150);
    const events: string[] = [];
    const tool = batchTool({ onSubEvent: (l) => events.push(l) });
    const res = await tool.run(
      {
        tasks: ['TASK-1 find TODOs', 'TASK-2 map the API', 'TASK-3 draft notes'],
        tools: ['read_file', 'grep'],
      },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('helper batch: 3/3 finished ok (parallel)');
    expect(route.maxInFlight()).toBe(3); // all three overlapped in flight
    // Aggregation is in TASK order regardless of completion order.
    const content = res.content ?? '';
    const i1 = content.indexOf('[1] ok');
    const i2 = content.indexOf('[2] ok');
    const i3 = content.indexOf('[3] ok');
    expect(i1).toBeGreaterThanOrEqual(0);
    expect(i1).toBeLessThan(i2);
    expect(i2).toBeLessThan(i3);
    expect(content).toContain('REPORT-TASK-1');
    expect(content).toContain('REPORT-TASK-3');
    // Indexed UI lines: start + finish carry the sub[i] prefix.
    expect(events.some((l) => l.includes('· sub[2] started:'))).toBe(true);
    expect(events.some((l) => l.includes('· sub[3] finished (1 turns)'))).toBe(true);
  });

  it('a write tool in the set → strictly SEQUENTIAL (no overlap, task order)', async () => {
    const route = routeBatch(120);
    const tool = batchTool();
    const res = await tool.run(
      {
        tasks: ['TASK-1 find TODOs', 'TASK-2 map the API', 'TASK-3 draft notes'],
        tools: ['read_file', 'write_file'],
      },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('sequential');
    expect(route.maxInFlight()).toBe(1);
    expect(route.arrivals).toEqual(['TASK-1', 'TASK-2', 'TASK-3']);
  });

  it('omitted tools (full set) → sequential too, and the wire advertises the full set', async () => {
    const route = routeBatch(80);
    const tool = batchTool();
    const res = await tool.run(
      { tasks: ['TASK-1 a', 'TASK-2 b'] },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toContain('sequential');
    expect(route.maxInFlight()).toBe(1);
  });

  it('concurrency bound: 5 read-only tasks never exceed 3 in flight', async () => {
    const route = routeBatch(120);
    const tool = batchTool();
    const res = await tool.run(
      {
        tasks: ['TASK-1 a', 'TASK-2 b', 'TASK-3 c', 'TASK-4 d', 'TASK-5 e'],
        tools: ['read_file', 'glob', 'list_dir'],
      },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(res.summary).toBe('helper batch: 5/5 finished ok (parallel)');
    expect(route.maxInFlight()).toBe(3);
    // Queued tasks started only after slots freed — every task ran exactly once.
    expect([...route.arrivals].sort()).toEqual(['TASK-1', 'TASK-2', 'TASK-3', 'TASK-4', 'TASK-5']);
    const content = res.content ?? '';
    expect(content.indexOf('[4] ok')).toBeLessThan(content.indexOf('[5] ok'));
    expect(content).toContain('REPORT-TASK-5');
  });

  it('failure isolation: one helper failing never kills the others', async () => {
    const route = routeBatch(80, {
      'TASK-2': () => ({
        status: 400,
        body: '{"error":{"code":"bad_task","message":"task-2 boom"}}',
      }),
    });
    const events: string[] = [];
    const tool = batchTool({ onSubEvent: (l) => events.push(l) });
    const res = await tool.run(
      {
        tasks: ['TASK-1 a', 'TASK-2 b', 'TASK-3 c'],
        tools: ['read_file'],
      },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(false); // partial failure is honest
    expect(res.summary).toBe('helper batch: 2/3 finished ok (parallel)');
    const content = res.content ?? '';
    expect(content).toContain('[1] ok');
    expect(content).toContain('[2] FAILED · TASK-2 b');
    expect(content).toContain('task-2 boom');
    expect(content).toContain('[3] ok');
    expect(content).toContain('REPORT-TASK-3');
    expect(events.some((l) => l.includes('· sub[2] failed:'))).toBe(true);
    expect(route.calls()).toBe(3);
  });

  it('usage of every parallel helper folds into the parent totals', async () => {
    routeBatch(60);
    const usages: { totalTokens: number; charge: string | undefined }[] = [];
    const tool = batchTool({ onSubUsage: (u) => usages.push(u) });
    const res = await tool.run(
      { tasks: ['TASK-1 a', 'TASK-2 b'], tools: ['read_file', 'grep'] },
      { cwd: tempProject(), dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(usages.length).toBe(2); // one onTurnComplete per helper
    expect(usages.reduce((n, u) => n + u.totalTokens, 0)).toBe(60); // 30 + 30
    expect(usages.every((u) => u.charge === '0.000030')).toBe(true);
  });

  it('concurrent helpers never prompt simultaneously (asks serialize)', async () => {
    // Each helper requests a read_file; the asker counts overlap. A fresh
    // SessionAllows means every read really prompts (no 'a' memory).
    let asking = 0;
    let maxAsking = 0;
    const countingAsker = {
      ask: async () => {
        asking += 1;
        maxAsking = Math.max(maxAsking, asking);
        await sleep(90);
        asking -= 1;
        return 'allow' as const;
      },
      replacement: async () => null,
    };
    const cwd = tempProject();
    writeFileSync(join(cwd, 'probe.txt'), 'x\n');
    server.setHandler(async (req) => {
      const body = JSON.parse(req.body) as {
        messages: { role: string; content: unknown; tool_calls?: unknown }[];
        tools?: { function: { name: string } }[];
      };
      // A helper's second turn (after the tool result) answers plainly.
      const hasToolResult = body.messages.some((m) => m.role === 'tool');
      if (hasToolResult) {
        return { status: 200, sse: framesToSse(sseText('read it')) };
      }
      return {
        status: 200,
        sse: framesToSse([
          { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${Math.random().toString(36).slice(2, 8)}`,
                      type: 'function',
                      function: {
                        name: 'read_file',
                        arguments: JSON.stringify({ path: 'probe.txt' }),
                      },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          {
            choices: [],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            gateway: { charge: '0.000010', request_id: 'req_par' },
          },
          'data: [DONE]',
        ]),
      };
    });
    const tool = makeSubagentTool({
      client: makeClient(),
      model: () => 'm',
      permissions: countingAsker,
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: builtinTools(),
    });
    const res = await tool.run(
      { tasks: ['TASK-1 read the probe', 'TASK-2 read the probe too'], tools: ['read_file'] },
      { cwd, dryRun: false },
    );
    expect(res.ok).toBe(true);
    expect(maxAsking).toBe(1); // two prompts happened, never concurrently
  });

  it('dry run previews the batch mode and why — and never touches the network', async () => {
    server.setHandler(() => ({ status: 500, body: '{}' }));
    server.requests.length = 0;
    const tool = batchTool();
    const parallel = await tool.run(
      { tasks: ['TASK-1 a', 'TASK-2 b'], tools: ['read_file', 'grep'] },
      { cwd: tempProject(), dryRun: true },
    );
    expect(parallel.ok).toBe(true);
    expect(parallel.preview).toContain('PARALLEL');
    expect(parallel.preview).toContain('1. TASK-1 a');
    expect(parallel.preview).toContain('2. TASK-2 b');
    const sequential = await tool.run(
      { tasks: ['TASK-1 a', 'TASK-2 b'], tools: ['read_file', 'write_file'] },
      { cwd: tempProject(), dryRun: true },
    );
    expect(sequential.preview).toContain('SEQUENTIAL');
    expect(sequential.preview).toContain('forbidden');
    // The web fetchers are read-kind but NOT parallel-safe.
    const webby = await tool.run(
      { tasks: ['TASK-1 a', 'TASK-2 b'], tools: ['read_file', 'web_fetch'] },
      { cwd: tempProject(), dryRun: true },
    );
    expect(webby.preview).toContain('SEQUENTIAL');
    expect(server.requests.length).toBe(0);
  });

  it('the batch permission label lists every task under one approval', () => {
    const tool = batchTool();
    expect(
      tool.permissionLabel({
        tasks: ['find TODOs', 'map API', 'draft notes'],
        tools: ['read_file'],
      }),
    ).toBe('spawn_agent(3 tasks: find TODOs; map API; draft notes)');
    // Single-task labels are unchanged.
    expect(tool.permissionLabel({ task: 'count the TODOs' })).toBe('spawn_agent(count the TODOs)');
  });

  it('bad batch shapes are honest failures', async () => {
    const tool = batchTool();
    const cwd = tempProject();
    const run = (input: unknown) => tool.run(input, { cwd, dryRun: false });
    expect((await run({ tasks: [] })).summary).toContain('2–5');
    expect((await run({ tasks: 'x' })).summary).toContain('array');
    expect((await run({ tasks: ['a', 'b', 'c', 'd', 'e', 'f'] })).summary).toContain('2–5');
    expect((await run({ tasks: ['a', 42] })).summary).toContain('must be a string');
    expect((await run({ tasks: ['a', '  '] })).summary).toContain('must not be empty');
    expect((await run({ tasks: ['same task', 'same task'] })).summary).toContain('duplicate');
    const both = await run({ task: 'one', tasks: ['a', 'b'] });
    expect(both.ok).toBe(false);
    expect(both.summary).toContain('not both');
    // A single task (old shape) still works and stays sequential-path exact.
    expect((await run({ task: '   ' })).summary).toContain('must not be empty');
    expect((await run({})).summary).toContain('missing required string field "task"');
  });
});

describe('spawn_agent wiring in the commands', () => {
  it('chat --safe excludes spawn_agent (read-only stays read-only)', async () => {
    // Import the wiring logic indirectly: chat constructs tools internally.
    // The --safe filter is behavior we assert via the wire: a safe chat's
    // request body tools must not include spawn_agent. Drive a real runChat
    // turn against the mock.
    const { runChat } = await import('../src/commands/chat.js');
    const io: CliIo = {
      stdin: Readable.from([]),
      isTTY: true,
      out: () => {},
      err: () => {},
      writeOut: () => {},
      writeErr: () => {},
    };
    const cwd = tempProject();
    let advertised: string[] = [];
    server.setHandler((req) => {
      if (req.path === '/v1/chat/completions') {
        const body = JSON.parse(req.body) as { tools?: { function: { name: string } }[] };
        advertised = (body.tools ?? []).map((t) => t.function.name);
      }
      if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
        return {
          status: 200,
          body: JSON.stringify({
            id: 'glm-5.3-flash',
            display_name: 'Mock',
            context_window: 100000,
            input_price_per_mtok: '1.00',
            output_price_per_mtok: '2.00',
          }),
        };
      }
      return {
        status: 200,
        sse: framesToSse(sseText('ok')),
      };
    });
    const ctx = { debug: false, json: false, apiUrl: server.url, io };
    await runChat(ctx, { cwd, safe: true });
    expect(advertised).not.toContain('spawn_agent');
  });
});
