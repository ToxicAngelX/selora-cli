import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SeloraClient } from '../src/api/client.js';
import { SeloraApiError } from '../src/api/errors.js';
import type { ChatMessage } from '../src/api/endpoints/chat.js';
import { runAgentLoop, type AgentEvent, type AgentLoopOptions } from '../src/agent/loop.js';
import { SessionAllows } from '../src/agent/permissions.js';
import type { Tool } from '../src/agent/tool.js';
import { maybeCompact } from '../src/agent/compact.js';
import { runCommandTool } from '../src/agent/tools/exec.js';
import { makeSubagentTool } from '../src/agent/tools/subagent.js';
import { startMockServer, type MockServer } from './mock/server.js';

let server: MockServer;
let cwd: string;
let client: SeloraClient;

beforeEach(async () => {
  server = await startMockServer();
  cwd = mkdtempSync(join(tmpdir(), 'selora-lifecycle-'));
  client = new SeloraClient({ baseUrl: server.url, apiKey: 'sk-gw-TEST_LIFECYCLE' });
});
afterEach(async () => {
  await server.close();
  rmSync(cwd, { recursive: true, force: true });
});

function round(
  calls: Array<{ id: string; name: string; args?: string }> = [],
  text = 'done',
  totalTokens = 10,
  charge = '0.000015',
): string[] {
  const frames: unknown[] = [
    { choices: [{ delta: { content: text.slice(0, 2) }, finish_reason: null }] },
    { choices: [{ delta: { content: text.slice(2) }, finish_reason: null }] },
    {
      choices: [
        {
          delta: {
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.args ?? '{}' },
            })),
          },
          finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
        },
      ],
    },
    {
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: totalTokens },
      gateway: { charge },
    },
  ];
  return [...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`), 'data: [DONE]\n\n'];
}

function routes(rounds: string[][]): void {
  let count = 0;
  server.setHandler(() => ({ status: 200, sse: rounds[count++] ?? round() }));
}

function tool(run?: Tool['run'], kind: Tool['kind'] = 'write'): Tool {
  return {
    name: 'test_tool',
    kind,
    description: 'test',
    parameters: { type: 'object', properties: {} },
    permissionLabel: () => 'test_tool(x)',
    run:
      run ?? (async (_input, ctx) => ({ ok: true, summary: ctx.dryRun ? 'preview' : 'executed' })),
  };
}

function options(extra: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    client,
    model: 'test-model',
    messages: [{ role: 'user', content: 'work' }],
    tools: [tool()],
    cwd,
    maxTurns: 5,
    autoApprove: false,
    permissions: { ask: async () => 'allow', replacement: async () => null },
    callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
    ...extra,
  };
}

const requested = { id: 'reused-call', name: 'test_tool' };

describe('cancel-safe tool batches', () => {
  it.each(['preview', 'permission', 'real', 'review', 'apply'] as const)(
    'abort during %s preserves completed effects and skips pending calls',
    async (phase) => {
      const controller = new AbortController();
      routes([
        round([
          { ...requested, id: 'first' },
          { ...requested, id: 'second' },
        ]),
      ]);
      const runs: string[] = [];
      const signals: Array<AbortSignal | undefined> = [];
      const snapshots: ChatMessage[][] = [];
      const apply = vi.fn(async () => {
        writeFileSync(join(cwd, 'effect.txt'), 'applied');
        if (phase === 'apply') controller.abort();
        return { ok: true, summary: 'applied effect' };
      });
      const run: Tool['run'] = async (_input, ctx) => {
        signals.push(ctx.signal);
        runs.push(ctx.dryRun ? 'preview' : 'real');
        if (ctx.dryRun) {
          if (phase === 'preview') controller.abort();
          return {
            ok: true,
            summary: 'preview',
            diff: { before: '', after: 'effect', path: 'effect.txt' },
          };
        }
        writeFileSync(join(cwd, 'effect.txt'), 'executed');
        if (phase === 'real') controller.abort();
        return { ok: true, summary: 'executed effect', content: 'effect happened' };
      };
      await expect(
        runAgentLoop(
          options({
            tools: [tool(run)],
            signal: controller.signal,
            permissions: {
              ask: async () => {
                if (phase === 'permission') controller.abort();
                return 'allow';
              },
              replacement: async () => null,
            },
            fileChange:
              phase === 'review' || phase === 'apply'
                ? {
                    review: async () => {
                      if (phase === 'review') controller.abort();
                      return { action: 'apply' };
                    },
                    apply,
                  }
                : undefined,
            callbacks: {
              onDelta: () => {},
              onTurnComplete: () => {},
              onHistorySnapshot: (snapshot) => snapshots.push(snapshot),
            },
          }),
        ),
      ).rejects.toMatchObject({ kind: 'cancelled' });
      expect(signals.every((signal) => signal === controller.signal)).toBe(true);
      expect(runs).toEqual(phase === 'real' ? ['preview', 'real'] : ['preview']);
      expect(apply).toHaveBeenCalledTimes(phase === 'apply' ? 1 : 0);
      expect(server.requests).toHaveLength(1);
      const messages = snapshots.at(-1)!;
      expect(messages).toBeDefined();
      const answers = messages.filter((message) => message.role === 'tool');
      expect(answers.map((message) => message.tool_call_id)).toEqual(['first', 'second']);
      expect(answers[1]!.content).toContain('Cancelled');
      if (phase === 'real' || phase === 'apply') {
        expect(answers[0]!.content).toContain(
          phase === 'real' ? 'effect happened' : 'applied effect',
        );
        expect(readFileSync(join(cwd, 'effect.txt'), 'utf8')).toBe(
          phase === 'real' ? 'executed' : 'applied',
        );
      } else expect(answers[0]!.content).toContain('Cancelled');
    },
  );

  it('a later stream abort keeps the previous wire-valid checkpoint', async () => {
    const controller = new AbortController();
    let count = 0;
    server.setHandler(() =>
      ++count === 1
        ? { status: 200, sse: round([requested]) }
        : { status: 200, sse: round([], 'unfinished').slice(0, 1), sseHang: true },
    );
    const snapshots: ChatMessage[][] = [];
    let deltas = 0;
    await expect(
      runAgentLoop(
        options({
          signal: controller.signal,
          callbacks: {
            onDelta: () => {
              if (++deltas === 3) controller.abort();
            },
            onTurnComplete: () => {},
            onHistorySnapshot: (snapshot) => snapshots.push(snapshot),
          },
        }),
      ),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]!.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: requested.id,
      content: 'executed',
    });
  });
});

describe('agent lifecycle events', () => {
  it('unknown and malformed wire calls still emit paired failure events', async () => {
    const events: AgentEvent[] = [];
    routes([
      round([{ id: 'unknown', name: 'missing_tool' }]),
      round([{ id: 'malformed', name: 'test_tool', args: '{bad' }]),
      round(),
    ]);
    await runAgentLoop(
      options({
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onEvent: (event) => events.push(event),
        },
      }),
    );
    const starts = events.filter((event) => event.type === 'tool-start');
    const results = events.filter((event) => event.type === 'tool-result');
    expect(starts).toHaveLength(2);
    expect(results).toHaveLength(2);
    expect(results.map((event) => event.summary)).toEqual([
      expect.stringContaining('Unknown tool'),
      expect.stringContaining('not valid JSON'),
    ]);
    expect(results.every((event) => event.ok === false)).toBe(true);
  });

  it('rich callbacks get one start/result, activity retains permission status, events isolate runs and turns', async () => {
    routes([round([requested]), round([requested]), round()]);
    const events: AgentEvent[] = [];
    const activity: string[] = [];
    const start = vi.fn();
    const result = vi.fn();
    await runAgentLoop(
      options({
        permissions: { ask: async () => 'allow-session', replacement: async () => null },
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onEvent: (event) => events.push(event),
          onActivity: (line) => activity.push(line),
          onToolStart: start,
          onToolResult: result,
        },
      }),
    );
    expect(start).toHaveBeenCalledTimes(2);
    expect(result).toHaveBeenCalledTimes(2);
    expect(activity).toEqual(['· allowed for this session']);
    const assistants = events.filter((event) => event.type === 'assistant-start');
    expect(assistants).toHaveLength(3);
    expect(new Set(assistants.map((event) => event.id)).size).toBe(3);
    const deltas = events.filter((event) => event.type === 'assistant-delta');
    expect(deltas.slice(0, 2).map((event) => [event.id, event.sequence, event.text])).toEqual([
      [assistants[0]!.id, 0, 'do'],
      [assistants[0]!.id, 1, 'ne'],
    ]);
    expect(
      events.filter((event) => event.type === 'assistant-complete').map((event) => event.content),
    ).toEqual(['done', 'done', 'done']);
    const starts = events.filter((event) => event.type === 'tool-start');
    const results = events.filter((event) => event.type === 'tool-result');
    expect(starts).toHaveLength(2);
    expect(results.map((event) => event.id)).toEqual(starts.map((event) => event.id));
    expect(starts[0]!.id).not.toBe(starts[1]!.id);
    expect(starts.map((event) => event.callId)).toEqual(['reused-call', 'reused-call']);
    const second: AgentEvent[] = [];
    await runAgentLoop(
      options({
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onEvent: (event) => second.push(event),
        },
      }),
    );
    expect(second[0]!.id).not.toBe(events[0]!.id);
  });
});

describe('subagent accounting', () => {
  it('reports each round once with fractional cost and one activity start/result', async () => {
    routes([round([requested], 'work', 10, '0.000015'), round([], 'report', 20, '0.000025')]);
    const usage: Array<{ totalTokens: number; charge: string | undefined }> = [];
    const activity: string[] = [];
    const sub = makeSubagentTool({
      client,
      model: () => 'test-model',
      permissions: options().permissions,
      allows: new SessionAllows(),
      autoApprove: false,
      parentTools: [tool()],
      onSubEvent: (line) => activity.push(line),
      onSubUsage: (totals) => usage.push(totals),
    });
    const result = await sub.run({ task: 'work' }, { cwd, dryRun: false });
    expect(result.ok).toBe(true);
    expect(usage).toEqual([
      { totalTokens: 10, charge: '0.000015' },
      { totalTokens: 20, charge: '0.000025' },
    ]);
    expect(activity.filter((line) => line.includes('→'))).toHaveLength(1);
    expect(activity.filter((line) => line.includes('executed'))).toHaveLength(1);
  });
});

describe('compaction cancellation', () => {
  it('passes signal to an injected summarizer, propagates abort instead of losing history', async () => {
    const controller = new AbortController();
    const history: ChatMessage[] = Array.from({ length: 20 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    await expect(
      maybeCompact(history, client, {
        tokens: 1,
        signal: controller.signal,
        summarize: async (_messages, signal) => {
          expect(signal).toBe(controller.signal);
          controller.abort();
          throw new Error('aborted');
        },
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    await expect(
      maybeCompact(history, client, {
        tokens: 1,
        summarize: async () => {
          throw new SeloraApiError({ kind: 'cancelled', message: 'Request cancelled.' });
        },
      }),
    ).rejects.toMatchObject({ kind: 'cancelled' });
    const soft = await maybeCompact(history, client, {
      tokens: 1,
      summarize: async () => {
        throw new Error('offline');
      },
    });
    expect(soft.messages).toEqual(history);
  });
  it('aborts the real summarizer HTTP stream', async () => {
    const controller = new AbortController();
    server.setHandler(() => ({ status: 200, sse: round().slice(0, 1), sseHang: true }));
    const history: ChatMessage[] = Array.from({ length: 20 }, () => ({
      role: 'user',
      content: 'x'.repeat(1000),
    }));
    const pending = maybeCompact(history, client, { tokens: 1, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ kind: 'cancelled' });
    await vi.waitFor(() => expect(server.requests).toHaveLength(1));
    controller.abort();
    await assertion;
  });
});

describe.skipIf(process.platform === 'win32')('command lifecycle', () => {
  it('abort kills a real command and its SIGTERM-resistant grandchild', async () => {
    const grandchild = join(cwd, 'grandchild.cjs');
    const parent = join(cwd, 'parent.cjs');
    const ready = join(cwd, 'ready.json');
    writeFileSync(
      grandchild,
      "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.argv[2], JSON.stringify({parent: process.ppid, child: process.pid})); setInterval(()=>{},1000);",
    );
    writeFileSync(
      parent,
      "process.on('SIGTERM',()=>{}); require('node:child_process').spawn(process.execPath,[process.argv[2],process.argv[3]],{stdio:'ignore'}); setInterval(()=>{},1000);",
    );
    const controller = new AbortController();
    const pending = runCommandTool.run(
      {
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(parent)} ${JSON.stringify(grandchild)} ${JSON.stringify(ready)}`,
        timeout_ms: 1000,
      },
      { cwd, dryRun: false, signal: controller.signal },
    );
    let pids: { parent: number; child: number } | undefined;
    try {
      await vi.waitFor(
        () => {
          pids = JSON.parse(readFileSync(ready, 'utf8'));
        },
        { timeout: 900 },
      );
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(false);
      expect(result.summary).toContain('cancelled');
      await vi.waitFor(() => {
        for (const pid of [pids!.parent, pids!.child]) {
          let running = true;
          try {
            // Linux reaping may lag; a zombie is no longer a running effect.
            if (process.platform === 'linux')
              running = readFileSync(`/proc/${pid}/stat`, 'utf8').split(' ')[2] !== 'Z';
            else process.kill(pid, 0);
          } catch {
            running = false;
          }
          expect(running).toBe(false);
        }
      });
    } finally {
      controller.abort();
      for (const pid of pids ? [pids.parent, pids.child] : []) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* exited */
        }
      }
      await pending;
    }
  });
  it('decodes UTF-8 across real stdout/stderr chunk boundaries', async () => {
    const script = join(cwd, 'utf8.cjs');
    writeFileSync(
      script,
      "const b=Buffer.from('€漢'); for (const stream of [process.stdout,process.stderr]) {stream.write(b.subarray(0,1));setTimeout(()=>stream.write(b.subarray(1)),80);}",
    );
    const result = await runCommandTool.run(
      { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}` },
      { cwd, dryRun: false },
    );
    expect(result.content).toBe('€漢\n€漢');
  });
});
