/**
 * Write-safety regression tests (v2.1.1) — the classic-gate real-run path
 * (run, --yes, session-allowed calls, non-TTY chat) previously wrote with a
 * plain writeFileSync: non-atomic, and blind to the file changing between
 * the approved dry-run preview and the write. Now:
 *
 *  - write_file / edit_file real runs go through atomicWriteFile (tmp +
 *    fsync + rename, existing mode bits preserved);
 *  - the loop threads the approved dry run's `before` as ctx.expectedBefore
 *    and the real run refuses honestly when the bytes moved since;
 *  - a session-allowed ('always') write label carries a content baseline —
 *    an external edit between turns RE-PROMPTS instead of clobbering.
 *
 * Unit tests drive the tools directly; loop tests run the real agent loop
 * against the local mock gateway with scripted permission askers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { editFileTool, writeFileTool } from '../src/agent/tools/files.js';
import type { ToolContext } from '../src/agent/tool.js';
import type { PermissionAsker } from '../src/agent/permissions.js';
import { runAgentLoop } from '../src/agent/loop.js';
import { builtinTools } from '../src/agent/tools/index.js';
import { SeloraClient } from '../src/api/client.js';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL, FAKE_KEY_USER } from './mock/fixtures.js';
import { freshEnv, useApiUrl, cleanup, type TempEnv } from './helpers/env.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'selora-wsafe-'));
}

function ctx(
  root: string,
  dryRun: boolean,
  expectedBefore?: string,
): ToolContext & { dryRun: boolean } {
  return { cwd: root, dryRun, ...(expectedBefore !== undefined ? { expectedBefore } : {}) };
}

// ---------------------------------------------------------------------------
// unit: write_file stale detection + atomicity
// ---------------------------------------------------------------------------

describe('write_file — stale-edit detection (expectedBefore)', () => {
  it('matching baseline: the write lands', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'old content\n', 'utf8');
      const res = await writeFileTool.run(
        { path: 'a.txt', content: 'new content\n' },
        ctx(root, false, 'old content\n'),
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new content\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('file changed since the preview: honest refusal, disk untouched', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'old content\n', 'utf8');
      const res = await writeFileTool.run(
        { path: 'a.txt', content: 'new content\n' },
        ctx(root, false, 'the preview baseline\n'),
      );
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('changed on disk since the preview was approved');
      expect(res.summary).toContain('re-read the file and retry');
      // the external edit wins — never a silent clobber
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('old content\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("create baseline '': a file that APPEARED since the preview (non-empty) refuses", async () => {
    const root = tempRoot();
    try {
      // the dry run saw no file (baseline ''); one materialized meanwhile
      writeFileSync(join(root, 'new.txt'), 'someone else got here first\n', 'utf8');
      const res = await writeFileTool.run(
        { path: 'new.txt', content: 'agent content\n' },
        ctx(root, false, ''),
      );
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('changed on disk since the preview');
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('someone else got here first\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("create baseline '': still absent → writes; an EMPTY file appearing is harmless", async () => {
    const root = tempRoot();
    try {
      const res = await writeFileTool.run(
        { path: 'new.txt', content: 'agent content\n' },
        ctx(root, false, ''),
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(root, 'new.txt'), 'utf8')).toBe('agent content\n');

      writeFileSync(join(root, 'empty.txt'), '', 'utf8');
      const res2 = await writeFileTool.run(
        { path: 'empty.txt', content: 'filled\n' },
        ctx(root, false, ''),
      );
      expect(res2.ok).toBe(true);
      expect(readFileSync(join(root, 'empty.txt'), 'utf8')).toBe('filled\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fail-closed: an existing file that outgrew the read cap since the preview refuses', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'big.txt'), 'x'.repeat(256 * 1024 + 1), 'utf8');
      const res = await writeFileTool.run(
        { path: 'big.txt', content: 'replacement\n' },
        ctx(root, false, 'small original\n'),
      );
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('changed on disk since the preview');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('no baseline (expectedBefore absent): the legacy behavior — write proceeds', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'old\n', 'utf8');
      const res = await writeFileTool.run(
        { path: 'a.txt', content: 'new\n' },
        ctx(root, false), // no expectedBefore — e.g. a >256 KB dry run
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('new\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('edit_file — stale-edit detection (expectedBefore)', () => {
  it('matching baseline: the edit applies', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf8');
      const res = await editFileTool.run(
        { path: 'a.txt', find: 'beta', replace: 'BETA' },
        ctx(root, false, 'alpha\nbeta\ngamma\n'),
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('file changed since the preview: honest refusal, disk untouched', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'user edited this\nbeta\ngamma\n', 'utf8');
      const res = await editFileTool.run(
        { path: 'a.txt', find: 'beta', replace: 'BETA' },
        ctx(root, false, 'alpha\nbeta\ngamma\n'),
      );
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('changed on disk since the preview was approved');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('user edited this\nbeta\ngamma\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('write_file — atomic writes', () => {
  it('an overwrite preserves the existing permission bits (POSIX)', async () => {
    const root = tempRoot();
    try {
      const target = join(root, 'script.sh');
      writeFileSync(target, '#!/bin/sh\nold\n', 'utf8');
      chmodSync(target, 0o750);
      const res = await writeFileTool.run(
        { path: 'script.sh', content: '#!/bin/sh\nnew\n' },
        ctx(root, false),
      );
      expect(res.ok).toBe(true);
      if (process.platform !== 'win32') {
        expect(statSync(target).mode & 0o777).toBe(0o750);
      }
      expect(readFileSync(target, 'utf8')).toBe('#!/bin/sh\nnew\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a failed write (directory target) leaves NO tmp litter behind', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'adir'));
      const res = await writeFileTool.run(
        { path: 'adir', content: 'nope\n' },
        ctx(root, false),
      );
      expect(res.ok).toBe(false);
      const leftovers = readdirSync(root).filter((n) => n.includes('.selora-'));
      expect(leftovers).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('write into a fresh subdirectory tree still works (parents created)', async () => {
    const root = tempRoot();
    try {
      const res = await writeFileTool.run(
        { path: 'deep/nested/file.txt', content: 'down here\n' },
        ctx(root, false),
      );
      expect(res.ok).toBe(true);
      expect(readFileSync(join(root, 'deep', 'nested', 'file.txt'), 'utf8')).toBe('down here\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// loop level: the wired behavior end-to-end against the mock gateway
// ---------------------------------------------------------------------------

const WRITE_A: string[] = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_WA","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"out.txt\\",\\"content\\":\\"first content\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
  'data: [DONE]\n\n',
];

const WRITE_B: string[] = [
  'data: {"choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_WB","type":"function","function":{"name":"write_file","arguments":"{\\"path\\":\\"out.txt\\",\\"content\\":\\"second content\\"}"}}]},"finish_reason":null}]}\n\n',
  'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
  'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
  'data: [DONE]\n\n',
];

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

/** First N chat requests return the given tool-call streams, then answers. */
function routeRounds(rounds: string[][]): void {
  let chatCalls = 0;
  server.setHandler((req) => {
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      chatCalls += 1;
      return { status: 200, sse: chatCalls <= rounds.length ? rounds[chatCalls - 1]! : CHAT_STREAM_FULL };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
}

function loopClient(): SeloraClient {
  return new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY_USER });
}

describe('agent loop — write safety wiring', () => {
  it('prompted write: an edit landing while the prompt is open REFUSES the write (never clobbers)', async () => {
    routeRounds([WRITE_A]);
    const dir = tempRoot();
    try {
      writeFileSync(join(dir, 'out.txt'), 'original\n', 'utf8');
      // The asker simulates the user saving the file in their editor WHILE
      // the permission prompt is open, then answering 'y'.
      const asker: PermissionAsker = {
        ask: async () => {
          writeFileSync(join(dir, 'out.txt'), 'sneaky external edit\n', 'utf8');
          return 'allow';
        },
        replacement: async () => null,
      };
      const events: Array<{ ok: boolean; summary: string }> = [];
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write it' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onToolResult: (info) => events.push({ ok: info.ok, summary: info.summary }),
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.ok).toBe(false);
      expect(events[0]!.summary).toContain('changed on disk since the preview was approved');
      // the external edit survives; the model is TOLD the write was refused
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('sneaky external edit\n');
      const toolMsg = result.messages.find((m) => m.role === 'tool');
      expect(toolMsg?.content).toContain('changed on disk since the preview');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session-allowed ('a') write: prompts once, later same-label writes run WITHOUT asking", async () => {
    routeRounds([WRITE_A, WRITE_B]);
    const dir = tempRoot();
    try {
      let asks = 0;
      const asker: PermissionAsker = {
        ask: async () => {
          asks += 1;
          return 'allow-session';
        },
        replacement: async () => null,
      };
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write twice' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: { onDelta: () => {}, onTurnComplete: () => {} },
      });
      expect(asks).toBe(1);
      // the agent's own second write lands on top of its first (baseline
      // refreshed after the first) — no stale false-positive
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('second content');
      expect(result.stop).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("session-allowed write + an EXTERNAL edit between turns: the loop ASKS AGAIN instead of clobbering", async () => {
    routeRounds([WRITE_A, WRITE_B]);
    const dir = tempRoot();
    try {
      let asks = 0;
      const asker: PermissionAsker = {
        ask: async () => {
          asks += 1;
          // First call: allow for the session. Second call (the re-prompt
          // after the external edit): deny — the user declines the overwrite.
          return asks === 1 ? 'allow-session' : 'deny';
        },
        replacement: async () => null,
      };
      const activity: string[] = [];
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write twice' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onActivity: (line) => activity.push(line),
          onToolResult: (info) => {
            // The user's editor saves over the file right after the agent's
            // first write landed — the second write must NOT silently win.
            if (info.ok && info.name === 'write_file' && !existsSync(join(dir, 'MARK'))) {
              writeFileSync(join(dir, 'MARK'), '', 'utf8');
              writeFileSync(join(dir, 'out.txt'), 'user edit between turns\n', 'utf8');
            }
          },
        },
      });
      expect(asks).toBe(2); // re-prompted
      expect(activity.some((l) => l.includes('asking again'))).toBe(true);
      // denied at the re-prompt: the external edit is intact
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('user edit between turns\n');
      const denied = result.toolEvents.filter((e) => e.summary === 'denied by user');
      expect(denied).toHaveLength(1);
      expect(result.stop).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session-allowed write re-approved after an external edit: the new baseline sticks', async () => {
    routeRounds([WRITE_A, WRITE_B]);
    const dir = tempRoot();
    try {
      let asks = 0;
      const asker: PermissionAsker = {
        ask: async () => {
          asks += 1;
          return 'allow-session'; // both times
        },
        replacement: async () => null,
      };
      await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write twice' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onToolResult: (info) => {
            if (info.ok && info.name === 'write_file' && !existsSync(join(dir, 'MARK'))) {
              writeFileSync(join(dir, 'MARK'), '', 'utf8');
              writeFileSync(join(dir, 'out.txt'), 'user edit between turns\n', 'utf8');
            }
          },
        },
      });
      expect(asks).toBe(2);
      // re-approved with the fresh diff: the second write lands this time
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('second content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session-allowed write, file DELETED between turns: re-asked, not blind-recreated', async () => {
    routeRounds([WRITE_A, WRITE_B]);
    const dir = tempRoot();
    try {
      let asks = 0;
      const asker: PermissionAsker = {
        ask: async () => {
          asks += 1;
          return asks === 1 ? 'allow-session' : 'deny';
        },
        replacement: async () => null,
      };
      const result = await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write twice' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onToolResult: (info) => {
            if (info.ok && info.name === 'write_file' && existsSync(join(dir, 'out.txt'))) {
              rmSync(join(dir, 'out.txt')); // external deletion after the first write
            }
          },
        },
      });
      expect(asks).toBe(2); // the deletion invalidated the blanket allow
      expect(existsSync(join(dir, 'out.txt'))).toBe(false); // denied at the re-prompt
      expect(result.stop).toBe('completed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('session-allowed write, file outgrew the diff cap between turns: unverifiable = re-ask', async () => {
    routeRounds([WRITE_A, WRITE_B]);
    const dir = tempRoot();
    try {
      let asks = 0;
      const asker: PermissionAsker = {
        ask: async () => {
          asks += 1;
          return 'allow-session';
        },
        replacement: async () => null,
      };
      await runAgentLoop({
        client: loopClient(),
        model: 'test-model',
        messages: [{ role: 'user', content: 'write twice' }],
        tools: builtinTools(),
        maxTurns: 5,
        cwd: dir,
        permissions: asker,
        autoApprove: false,
        callbacks: {
          onDelta: () => {},
          onTurnComplete: () => {},
          onToolResult: (info) => {
            if (info.ok && info.name === 'write_file' && !existsSync(join(dir, 'MARK'))) {
              writeFileSync(join(dir, 'MARK'), '', 'utf8');
              writeFileSync(join(dir, 'out.txt'), 'x'.repeat(256 * 1024 + 1), 'utf8');
            }
          },
        },
      });
      // a baseline existed but the probe could not verify it → the user is asked
      expect(asks).toBe(2);
      // re-approved: the write lands (no check is possible at this size)
      expect(readFileSync(join(dir, 'out.txt'), 'utf8')).toBe('second content');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
