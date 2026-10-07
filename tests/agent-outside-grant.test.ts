/**
 * The v0.8 outside-grant regression (the owner's Windows bug): in AUTO mode an
 * outside-root tool call auto-answered with a PLAIN 'allow', and the loop only
 * remembered the directory on 'allow-session' — so the real run failed with
 * "outside the project root and access was not granted" even though the call
 * was approved. These tests pin the invariant: EVERY approved outside path
 * reaches runApproved with its directory granted (first touch prints
 * "· outside access granted for this session: <dir>"), in auto mode exactly
 * like --yes — while deletions (neverAutoAllow) still ask every time.
 *
 * The loop is driven directly (mock gateway for the stream, real tools, real
 * filesystem) with the mode asker from chat — the exact Windows scenario.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL, FAKE_KEY_USER, REVOKED_KEY_401 } from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { SeloraClient } from '../src/api/client.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { createModeAsker } from '../src/agent/modes.js';
import {
  SessionAllows,
  type PermissionAsker,
  type PermissionRequest,
} from '../src/agent/permissions.js';
import type { ChatMessage } from '../src/api/endpoints/chat.js';

const NOT_FOUND = '{"error":{"code":"not_found","message":"no fixture"}}';

const sseFrame = (o: unknown): string => 'data: ' + JSON.stringify(o) + '\n\n';

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

/** One tool-call round for `tool` with `args`, then the plain answer. */
function routeToolThenAnswer(name: string, args: Record<string, unknown>): void {
  let calls = 0;
  const sse = sseFrame;
  const argStr = JSON.stringify(args);
  const round: string[] = [
    sse({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_OUT1', type: 'function', function: { name, arguments: argStr } }] }, finish_reason: null }] }),
    sse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
    sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, gateway: { charge: '0.000100' } }),
    'data: [DONE]\n\n',
  ];
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      calls += 1;
      return calls === 1
        ? { status: 200, sse: round }
        : { status: 200, sse: [sse({ choices: [{ index: 0, delta: { content: 'done' }, finish_reason: null }] }), 'data: [DONE]\n\n'] };
    }
    return { status: 404, body: NOT_FOUND };
  });
}

/** A recording asker whose answers are scripted (the base under the mode wrap). */
function scriptedBase(decision: 'allow' | 'allow-session' | 'deny'): {
  base: PermissionAsker;
  asked: PermissionRequest[];
} {
  const asked: PermissionRequest[] = [];
  return {
    asked,
    base: {
      ask: async (req) => {
        asked.push(req);
        return decision;
      },
      askDetailed: async (req) => {
        asked.push(req);
        return { decision };
      },
      replacement: async () => null,
    },
  };
}

interface RunResult {
  stop: string;
  toolEvents: Array<{ name: string; ok: boolean; summary: string }>;
  messages: ChatMessage[];
  activities: string[];
  allows: SessionAllows;
}

async function runWith(
  permissions: PermissionAsker,
  cwd: string,
  prompt: string,
): Promise<RunResult> {
  const client = new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER, debug: false });
  const allows = new SessionAllows();
  const activities: string[] = [];
  const result = await runAgentLoop({
    client,
    model: 'test-model',
    messages: [{ role: 'user', content: prompt }],
    tools: builtinTools(),
    maxTurns: 5,
    cwd,
    permissions,
    autoApprove: false,
    callbacks: {
      onDelta: () => {},
      onActivity: (line) => activities.push(line),
      onTurnComplete: () => {},
    },
    allows,
  });
  return { ...result, activities, allows };
}

/** A temp project root with a SIBLING outside dir (the Windows Desktop shape). */
function projectWithOutside(): { project: string; outside: string } {
  // realpath the base: macOS tmpdir is a symlink (/var → /private/var) and the
  // loop stores realpath-resolved grants.
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'selora-outside-')));
  const project = join(base, 'project');
  const outside = join(base, 'outside');
  mkdirSync(project, { recursive: true });
  mkdirSync(outside, { recursive: true });
  return { project, outside };
}

describe('auto mode — outside-path auto-grant (the v0.7 Windows bug)', () => {
  it('the FIRST outside touch in auto mode grants the dir for the session and the write SUCCEEDS', async () => {
    const { project, outside } = projectWithOutside();
    const target = join(outside, 'note.txt');
    try {
      routeToolThenAnswer('write_file', { path: target, content: 'from the agent\n' });
      const { base, asked } = scriptedBase('deny'); // must never be reached in auto mode
      const asker = createModeAsker(base, () => 'auto');
      const run = await runWith(asker, project, 'write a note on my desktop');

      // the exact failure of the bug: an approved call whose real run fails
      expect(existsSync(target)).toBe(true);
      expect(readFileSync(target, 'utf8')).toBe('from the agent\n');
      expect(run.toolEvents[0]?.ok).toBe(true);
      expect(run.toolEvents[0]?.summary).not.toContain('access was not granted');
      // the dir was granted for the session, with the activity line
      expect(run.allows.outsideDirs()).toContain(outside);
      expect(run.activities).toContain(`· outside access granted for this session: ${outside}`);
      // auto mode auto-answered — the human asker never fired
      expect(asked).toHaveLength(0);
      expect(run.stop).toBe('completed');
    } finally {
      rmSync(join(project, '..'), { recursive: true, force: true });
    }
  });

  it("a manual 'y' (plain allow) on the outside prompt also grants + succeeds (the bug class)", async () => {
    const { project, outside } = projectWithOutside();
    const target = join(outside, 'note.txt');
    try {
      routeToolThenAnswer('write_file', { path: target, content: 'manual yes\n' });
      const { base, asked } = scriptedBase('allow');
      const run = await runWith(base, project, 'write a note outside');

      expect(existsSync(target)).toBe(true);
      expect(run.toolEvents[0]?.ok).toBe(true);
      // one prompt (the outside ask), and the dir got remembered
      expect(asked).toHaveLength(1);
      expect(asked[0]?.outsidePath).toBe(target);
      expect(run.allows.outsideDirs()).toContain(outside);
      expect(run.activities).toContain(`· outside access granted for this session: ${outside}`);
    } finally {
      rmSync(join(project, '..'), { recursive: true, force: true });
    }
  });

  it('a denied outside prompt still refuses — and grants nothing', async () => {
    const { project, outside } = projectWithOutside();
    const target = join(outside, 'note.txt');
    try {
      routeToolThenAnswer('write_file', { path: target, content: 'should not land\n' });
      const { base } = scriptedBase('deny');
      const run = await runWith(base, project, 'write a note outside');

      expect(existsSync(target)).toBe(false);
      expect(run.toolEvents[0]?.summary).toBe('denied by user');
      expect(run.allows.outsideDirs()).toHaveLength(0);
      expect(run.activities).toContain('· denied by user');
    } finally {
      rmSync(join(project, '..'), { recursive: true, force: true });
    }
  });

  it('deletions (neverAutoAllow) STILL ask in auto mode after the outside grant', async () => {
    const { project, outside } = projectWithOutside();
    const target = join(outside, 'doomed.txt');
    writeFileSync(target, 'x', 'utf8');
    try {
      routeToolThenAnswer('remove', { path: target, mode: 'permanent' });
      const { base, asked } = scriptedBase('allow'); // the human says yes to the delete
      const asker = createModeAsker(base, () => 'auto');
      const run = await runWith(asker, project, 'delete the outside file');

      // the delete itself executed (human approved), and the outside target
      // was auto-granted BEFORE the delete prompt — but the prompt still
      // happened. (grantDirFor: an existing FILE grants the file itself.)
      expect(existsSync(target)).toBe(false);
      expect(asked).toHaveLength(1); // the remove confirmation, not the outside ask
      expect(run.allows.outsideDirs()).toContain(target);
      expect(run.activities).toContain(`· outside access granted for this session: ${target}`);
    } finally {
      rmSync(join(project, '..'), { recursive: true, force: true });
    }
  });

  it('a second outside touch of the SAME dir in auto mode asks nothing and prints no second grant line', async () => {
    const { project, outside } = projectWithOutside();
    const first = join(outside, 'a.txt');
    const second = join(outside, 'b.txt');
    try {
      // two write rounds, both outside in the same dir
      let calls = 0;
      const roundFor = (id: string, p: string): string[] => [
        'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
        sseFrame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content: 'x\n' }) } }] }, finish_reason: null }] }),
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12},"gateway":{"charge":"0.000100"}}\n\n',
        'data: [DONE]\n\n',
      ];
      server.setHandler((req) => {
        if (req.method === 'POST' && req.path === '/v1/chat/completions') {
          if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
            return { status: 401, body: REVOKED_KEY_401 };
          }
          calls += 1;
          if (calls === 1) return { status: 200, sse: roundFor('call_O1', first) };
          if (calls === 2) return { status: 200, sse: roundFor('call_O2', second) };
          return { status: 200, sse: CHAT_STREAM_FULL };
        }
        return { status: 404, body: NOT_FOUND };
      });

      const { base, asked } = scriptedBase('deny');
      const asker = createModeAsker(base, () => 'auto');
      const run = await runWith(asker, project, 'write two outside files');

      expect(existsSync(first)).toBe(true);
      expect(existsSync(second)).toBe(true);
      expect(asked).toHaveLength(0);
      const grantLines = run.activities.filter(
        (l) => l === `· outside access granted for this session: ${outside}`,
      );
      expect(grantLines).toHaveLength(1);
    } finally {
      rmSync(join(project, '..'), { recursive: true, force: true });
    }
  });
});
