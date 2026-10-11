/**
 * v2.2 mid-stream drop resume (loop.ts) — end-to-end against the mock
 * gateway's sseDestroy mode (the socket dies mid-body; the client's reader
 * rejects with a network error — a real drop, not a finish-less clean end).
 *
 * Covers:
 *  - drop after partial content → the turn RESUMES (assistant partial +
 *    continue-exactly instruction appended to a COPY of the history); the
 *    continuation is stitched on with the seam overlap trimmed once.
 *  - the stitch: a mock that deliberately repeats words at the seam yields
 *    the exact expected final text; assistant-complete carries the STITCHED
 *    content and the real history stays clean (no synthetic messages).
 *  - the bound: 3 consecutive drops → the error surfaces AND the partial text
 *    the user watched is preserved (deltas flowed; a dim note says why).
 *  - tool safety: a drop after a tool_calls fragment is NEVER resumed.
 *  - a user cancel during the resume propagates 'cancelled', no more retries.
 *  - usage/charge honesty: the dropped attempt's mid-stream usage chunk AND
 *    the successful attempt's usage both fold into the totals.
 *  - no resume for: in-band errors (http_error), zero-partial drops.
 *  - stitchStreamParts units: overlap trim, the 200-char bound, empty sides.
 * Never touches prod; fake sk-gw-TEST keys only.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockServer, type MockServer } from './mock/server.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { createAutoAsker } from '../src/agent/permissions.js';
import { runAgentLoop, stitchStreamParts } from '../src/agent/loop.js';
import { SeloraApiError } from '../src/api/errors.js';
import { SeloraClient } from '../src/api/client.js';

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

const FAKE_KEY = 'sk-gw-TEST_RESUME';

function makeClient(): SeloraClient {
  return new SeloraClient({ baseUrl: server.url, apiKey: FAKE_KEY, debug: false, logger: () => {} });
}

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-resume-'));
}

function frame(v: unknown): string {
  return `data: ${JSON.stringify(v)}\n\n`;
}

const ROLE = frame({ choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
const DONE = 'data: [DONE]\n\n';

function contentFrame(text: string): string {
  return frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function finishFrame(reason: string): string {
  return frame({ choices: [{ index: 0, delta: {}, finish_reason: reason }] });
}

function usageFrame(total: number, charge: string): string {
  return frame({
    choices: [],
    usage: { prompt_tokens: total - 5, completion_tokens: 5, total_tokens: total },
    gateway: { charge, request_id: 'req_resume' },
  });
}

interface LoopCapture {
  deltas: string[];
  activity: string[];
  turnUsages: (number | undefined)[];
}

function makeCallbacks(): {
  callbacks: Parameters<typeof runAgentLoop>[0]['callbacks'];
  cap: LoopCapture;
} {
  const cap: LoopCapture = { deltas: [], activity: [], turnUsages: [] };
  return {
    cap,
    callbacks: {
      onDelta: (text) => {
        cap.deltas.push(text);
      },
      onActivity: (line) => {
        cap.activity.push(line);
      },
      onTurnComplete: (totals) => {
        cap.turnUsages.push(totals.usage?.totalTokens);
      },
    },
  };
}

describe('mid-stream drop resume', () => {
  it('a mid-body drop resumes and stitches the continuation (overlap trimmed once)', async () => {
    // Attempt 0 streams 60%-ish of the reply, then the socket dies. The resume
    // deliberately REPEATS "the lazy" at the seam — the stitch trims it once.
    const partial = 'PART-A the quick brown fox jumps over the lazy';
    const continuation = 'the lazy dog naps. END';
    const bodies: string[] = [];
    let calls = 0;
    server.setHandler((req) => {
      if (req.method !== 'POST' || req.path !== '/v1/chat/completions') {
        return { status: 404, body: '{"error":{"code":"not_found","message":"x"}}' };
      }
      calls += 1;
      bodies.push(req.body);
      if (calls === 1) {
        return { status: 200, sse: [ROLE, contentFrame(partial)], sseDestroy: true };
      }
      return {
        status: 200,
        sse: [ROLE, contentFrame(continuation), finishFrame('stop'), usageFrame(30, '0.000030'), DONE],
      };
    });

    const { callbacks, cap } = makeCallbacks();
    const result = await runAgentLoop({
      client: makeClient(),
      model: 'm',
      messages: [{ role: 'user', content: 'tell me about the fox' }],
      tools: [],
      maxTurns: 4,
      cwd: tempProject(),
      permissions: createAutoAsker(),
      autoApprove: false,
      callbacks,
    });

    expect(result.stop).toBe('completed');
    expect(result.finishReason).toBe('stop');
    // Exact stitched text — the seam's repeated "the lazy" appears ONCE.
    expect(result.content).toBe('PART-A the quick brown fox jumps over the lazy dog naps. END');
    expect(calls).toBe(2);
    expect(cap.activity).toContain('· stream dropped — resuming (1/2)');

    // The resume request carried the partial as an assistant message plus the
    // continue-exactly instruction — appended to a COPY (history stayed clean).
    const resumeBody = JSON.parse(bodies[1]!) as {
      messages: { role: string; content: unknown }[];
    };
    const msgs = resumeBody.messages;
    expect(msgs.length).toBe(3);
    expect(msgs[1]).toEqual({ role: 'assistant', content: partial });
    expect(msgs[2]?.role).toBe('user');
    expect(String(msgs[2]?.content)).toContain('Continue EXACTLY');

    // The returned history holds ONE assistant message — the stitched text,
    // no synthetic continue-exchange.
    expect(result.messages.length).toBe(2);
    const assistant = result.messages[1];
    expect(assistant?.role).toBe('assistant');
    expect(assistant?.role === 'assistant' ? assistant.content : '').toBe(
      'PART-A the quick brown fox jumps over the lazy dog naps. END',
    );
  });

  it('3 consecutive drops: the error surfaces AND the partial text is preserved', async () => {
    server.setHandler(() => ({
      status: 200,
      sse: [ROLE, contentFrame('PARTIAL-TEXT the user already watched')],
      sseDestroy: true,
    }));
    const { callbacks, cap } = makeCallbacks();
    let thrown: unknown;
    try {
      await runAgentLoop({
        client: makeClient(),
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        maxTurns: 4,
        cwd: tempProject(),
        permissions: createAutoAsker(),
        autoApprove: false,
        callbacks,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeloraApiError);
    expect((thrown as SeloraApiError).kind).toBe('network');
    // 1 initial + 2 resumes = 3 attempts.
    expect(server.requests.length).toBeGreaterThanOrEqual(3);
    // The resume notes + the give-up note.
    expect(cap.activity).toContain('· stream dropped — resuming (1/2)');
    expect(cap.activity).toContain('· stream dropped — resuming (2/2)');
    expect(cap.activity).toContain('· stream dropped — reply incomplete after 2 resumes');
    // The partial text the user watched is NOT lost — its deltas flowed.
    expect(cap.deltas.join('')).toContain('PARTIAL-TEXT the user already watched');
  });

  it('a drop after a tool_calls fragment is NEVER resumed (tool safety)', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      return {
        status: 200,
        sse: [
          ROLE,
          contentFrame('working on it'),
          frame({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_DROP',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{"path":"x' },
                    },
                  ],
                },
                finish_reason: null,
              },
            ],
          }),
        ],
        sseDestroy: true,
      };
    });
    const { callbacks, cap } = makeCallbacks();
    let thrown: unknown;
    try {
      await runAgentLoop({
        client: makeClient(),
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        maxTurns: 4,
        cwd: tempProject(),
        permissions: createAutoAsker(),
        autoApprove: false,
        callbacks,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeloraApiError);
    expect((thrown as SeloraApiError).kind).toBe('network');
    expect(calls).toBe(1); // no resume attempt
    expect(cap.activity.some((l) => l.includes('resuming'))).toBe(false);
  });

  it('a user cancel during the resume propagates cancelled — no more retries', async () => {
    const controller = new AbortController();
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      if (calls === 1) {
        return { status: 200, sse: [ROLE, contentFrame('partial before the drop')], sseDestroy: true };
      }
      // The resume stream starts but never finishes — the abort kills it.
      return { status: 200, sse: [ROLE], sseHang: true };
    });
    const { callbacks, cap } = makeCallbacks();
    const run = runAgentLoop({
      client: makeClient(),
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxTurns: 4,
      cwd: tempProject(),
      permissions: createAutoAsker(),
      autoApprove: false,
      signal: controller.signal,
      callbacks,
    });
    setTimeout(() => controller.abort(), 150);
    let thrown: unknown;
    try {
      await run;
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeloraApiError);
    expect((thrown as SeloraApiError).kind).toBe('cancelled');
    expect(cap.activity).toContain('· stream dropped — resuming (1/2)');
    expect(calls).toBe(2); // the resume went out; nothing after the cancel
  });

  it('usage/charge from BOTH the dropped and the successful attempt are counted', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      if (calls === 1) {
        // The usage chunk arrives MID-STREAM (before the drop) — the gateway
        // charged for those tokens; the loop must count them.
        return {
          status: 200,
          sse: [ROLE, contentFrame('ALPHA BETA '), usageFrame(15, '0.000010')],
          sseDestroy: true,
        };
      }
      return {
        status: 200,
        sse: [ROLE, contentFrame('GAMMA'), finishFrame('stop'), usageFrame(30, '0.000020'), DONE],
      };
    });
    const { callbacks, cap } = makeCallbacks();
    const result = await runAgentLoop({
      client: makeClient(),
      model: 'm',
      messages: [{ role: 'user', content: 'q' }],
      tools: [],
      maxTurns: 4,
      cwd: tempProject(),
      permissions: createAutoAsker(),
      autoApprove: false,
      callbacks,
    });
    expect(result.stop).toBe('completed');
    expect(result.content).toBe('ALPHA BETA GAMMA');
    // Both halves charged: 15 + 30 tokens, 10 + 20 micro.
    expect(result.usageTotal?.totalTokens).toBe(45);
    expect(result.chargeTotalMicro).toBe(30n);
    // onTurnComplete fired for the dropped attempt (15) and the final one (30).
    expect(cap.turnUsages).toEqual([15, 30]);
  });

  it('an in-band stream error after partial content is NOT resumed (http_error)', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      return {
        status: 200,
        sse: [
          ROLE,
          contentFrame('partial'),
          frame({ error: { code: 'upstream', message: 'provider exploded', request_id: 'r1' } }),
          DONE,
        ],
      };
    });
    const { callbacks, cap } = makeCallbacks();
    let thrown: unknown;
    try {
      await runAgentLoop({
        client: makeClient(),
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        maxTurns: 4,
        cwd: tempProject(),
        permissions: createAutoAsker(),
        autoApprove: false,
        callbacks,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeloraApiError);
    expect((thrown as SeloraApiError).kind).toBe('http_error');
    expect((thrown as SeloraApiError).message).toBe('provider exploded');
    expect(calls).toBe(1);
    expect(cap.activity.some((l) => l.includes('resuming'))).toBe(false);
  });

  it('a drop with ZERO partial content is a plain error (today’s behavior)', async () => {
    let calls = 0;
    server.setHandler(() => {
      calls += 1;
      return { status: 200, sse: [ROLE], sseDestroy: true };
    });
    const { callbacks, cap } = makeCallbacks();
    let thrown: unknown;
    try {
      await runAgentLoop({
        client: makeClient(),
        model: 'm',
        messages: [{ role: 'user', content: 'q' }],
        tools: [],
        maxTurns: 4,
        cwd: tempProject(),
        permissions: createAutoAsker(),
        autoApprove: false,
        callbacks,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(SeloraApiError);
    expect((thrown as SeloraApiError).kind).toBe('network');
    expect(calls).toBe(1);
    expect(cap.activity.some((l) => l.includes('stream dropped'))).toBe(false);
  });
});

describe('stitchStreamParts', () => {
  it('trims the longest suffix/prefix overlap exactly once', () => {
    expect(stitchStreamParts('the quick brown fox', 'brown fox jumps')).toBe(
      'the quick brown fox jumps',
    );
    expect(stitchStreamParts('abc', 'abcabc')).toBe('abcabc');
  });

  it('joins as-is when there is no clean overlap (an honest seam beats lost text)', () => {
    expect(stitchStreamParts('ALPHA BETA ', 'GAMMA')).toBe('ALPHA BETA GAMMA');
    expect(stitchStreamParts('end.', 'Next paragraph.')).toBe('end.Next paragraph.');
  });

  it('empty sides pass through', () => {
    expect(stitchStreamParts('', 'x')).toBe('x');
    expect(stitchStreamParts('x', '')).toBe('x');
    expect(stitchStreamParts('', '')).toBe('');
  });

  it('the overlap check is bounded to the partial’s last 200 chars', () => {
    // A 250-char overlap: only the last 200 of the partial are eligible, so
    // the trim stops at 200 and 50 chars remain duplicated — documented bound.
    const seam = 's'.repeat(250);
    const partial = `HEAD${seam}`;
    const continuation = `${seam}TAIL`;
    const stitched = stitchStreamParts(partial, continuation);
    expect(stitched).toBe(`HEAD${'s'.repeat(250)}${'s'.repeat(50)}TAIL`);
  });
});
