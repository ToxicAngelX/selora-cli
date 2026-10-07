/**
 * Context meter + auto-compaction tests. Pure modules — the bar shape, zone
 * coloring thresholds, token estimation, fold-boundary wire-safety, and the
 * maybeCompact contract (threshold, keep-recent, fail-soft).
 */

import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../src/api/endpoints/chat.js';
import {
  contextBar,
  compactBarFor,
  estimateTokensHistory,
  estimateTokensMessage,
  CRITICAL_RATIO,
  DEFAULT_CONTEXT_TOKENS,
  WARN_RATIO,
  PULSE_FRAMES,
} from '../src/agent/contextmeter.js';
import { maybeCompact, KEEP_RECENT, MIN_FOLD_MESSAGES } from '../src/agent/compact.js';
import { SeloraClient } from '../src/api/client.js';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL } from './mock/fixtures.js';

const u = (text: string): ChatMessage => ({ role: 'user', content: text });
const a = (text: string): ChatMessage => ({ role: 'assistant', content: text });
const toolMsg = (id: string, content: string): ChatMessage => ({
  role: 'tool',
  tool_call_id: id,
  content,
});
const aWithCalls = (id: string, args: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function', function: { name: 'read_file', arguments: args } }],
});

describe('estimateTokens', () => {
  it('scales with content length (chars/4)', () => {
    expect(estimateTokensMessage(u('12345678'))).toBe(2); // 8 chars → 2
    expect(estimateTokensMessage(u('x'.repeat(400)))).toBe(100);
  });

  it('counts tool-call argument skeletons', () => {
    const plain = estimateTokensMessage(a('abcd'));
    const withCall = estimateTokensMessage(aWithCalls('t1', 'x'.repeat(40)));
    expect(withCall).toBeGreaterThan(plain + 10);
  });

  it('history is the sum', () => {
    const h = [u('1234'), a('5678')];
    expect(estimateTokensHistory(h)).toBe(2);
  });
});

describe('contextBar', () => {
  it('renders the shape: cells, percent, numbers', () => {
    const bar = contextBar(15_000, { tokens: 30_000 });
    expect(bar).toMatch(/^ctx [▰▱]{8} 50% · [\d,.]+\/30,000$/);
  });

  it('0 used → 0%, all empty cells', () => {
    const bar = contextBar(0, { tokens: 30_000 });
    expect(bar).toContain('▱▱▱▱▱▱▱▱');
    expect(bar).toContain('0%');
  });

  it('full → 100%, all filled', () => {
    const bar = contextBar(30_000, { tokens: 30_000 });
    expect(bar).toContain('▰▰▰▰▰▰▰▰');
    expect(bar).toContain('100%');
  });

  it('clamps above 100%', () => {
    const bar = contextBar(90_000, { tokens: 30_000 });
    expect(bar).toContain('100%');
  });

  it('theme colors: gradient fill below warn, warning at ≥75%, error at ≥90%', () => {
    const theme = {
      warning: (s: string) => `W(${s})`,
      error: (s: string) => `E(${s})`,
      gradientAt: (s: string) => `G(${s})`,
      dim: (s: string) => `D(${s})`,
    };
    const healthy = contextBar(10_000, { tokens: 30_000 }, theme);
    expect(healthy).toContain('G(▰)');
    expect(healthy).not.toContain('W(▰)');
    const warn = contextBar(24_000, { tokens: 30_000 }, theme); // 80%
    expect(warn).toContain('W(▰)');
    expect(warn).not.toContain('E(▰)');
    const critical = contextBar(29_000, { tokens: 30_000 }, theme); // ~97%
    expect(critical).toContain('E(▰)');
  });

  it('empty cells are dimmed with a theme', () => {
    const theme = {
      warning: (s: string) => `W(${s})`,
      error: (s: string) => `E(${s})`,
      gradientAt: (s: string) => `G(${s})`,
      dim: (s: string) => `D(${s})`,
    };
    const bar = contextBar(3_750, { tokens: 30_000 }, theme); // 1 filled cell
    expect(bar).toContain('G(▰)');
    expect(bar).toContain('D(▱)');
  });

  it('thresholds exported and sane', () => {
    expect(WARN_RATIO).toBe(0.75);
    expect(CRITICAL_RATIO).toBe(0.9);
    expect(DEFAULT_CONTEXT_TOKENS).toBe(30_000);
  });
});

describe('compactBarFor (the animated critical bar)', () => {
  it('is the base bar + a braille pulse + label', () => {
    const line = compactBarFor(29_000, 3, { tokens: 30_000 });
    expect(line).toContain('ctx ');
    expect(line).toContain(PULSE_FRAMES[3]!);
    expect(line).toContain('compaction threshold');
  });

  it('frame advances the pulse glyph (animation frames differ)', () => {
    const f0 = compactBarFor(29_000, 0, { tokens: 30_000 });
    const f1 = compactBarFor(29_000, 1, { tokens: 30_000 });
    expect(f0).not.toBe(f1);
  });

  it('wraps the pulse + label in error color when a theme is given', () => {
    const theme = {
      warning: (s: string) => `W(${s})`,
      error: (s: string) => `E(${s})`,
      gradientAt: (s: string) => `G(${s})`,
      dim: (s: string) => `D(${s})`,
    };
    const line = compactBarFor(29_000, 0, { tokens: 30_000 }, theme);
    expect(line).toContain('E(');
  });
});

describe('maybeCompact', () => {
  let server: MockServer;
  const client = (): SeloraClient =>
    new SeloraClient({ baseUrl: server.url, apiKey: 'sk-test' });

  function longHistory(): ChatMessage[] {
    const h: ChatMessage[] = [];
    for (let i = 0; i < 30; i += 1) {
      h.push(u(`${'user message '.repeat(120)} #${i}`)); // ~600 tokens each
      h.push(a(`${'assistant reply '.repeat(120)} #${i}`));
    }
    return h;
  }

  it('below threshold — untouched', async () => {
    server = await startMockServer();
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    try {
      const h = [u('hello'), a('hi')];
      const res = await maybeCompact(h, client(), { tokens: 30_000 });
      expect(res.compacted).toBe(false);
      expect(res.messages).toEqual(h);
    } finally {
      server.close();
    }
  });

  it('too short to fold — untouched even above threshold', async () => {
    server = await startMockServer();
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    try {
      const h = [u('x'.repeat(200_000))]; // huge single message, only 1 msg
      const res = await maybeCompact(h, client(), { tokens: 1000 });
      expect(res.compacted).toBe(false);
    } finally {
      server.close();
    }
  });

  it('above threshold — folds the prefix into ONE marker message, keeps the tail', async () => {
    server = await startMockServer();
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    try {
      const h = longHistory(); // 60 messages, way over 30k tokens
      const res = await maybeCompact(h, client(), { tokens: 5000 });
      expect(res.compacted).toBe(true);
      expect(res.folded).toBeGreaterThanOrEqual(MIN_FOLD_MESSAGES);
      // marker is message[0], role user, with the compact marker text
      const marker = res.messages[0]!;
      expect(marker.role).toBe('user');
      expect(typeof marker.content === 'string' ? marker.content : '').toContain(
        'compact',
      );
      // the kept tail length: original - folded + 1 marker
      expect(res.messages.length).toBe(h.length - res.folded + 1);
      // the tail is verbatim (identity)
      expect(res.messages.slice(1)).toEqual(h.slice(res.folded));
      // headroom reclaimed
      expect(res.tokensAfter).toBeLessThan(res.tokensBefore);
    } finally {
      server.close();
    }
  });

  it('wire safety — the kept region never starts with an orphaned tool result', async () => {
    server = await startMockServer();
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    try {
      const h: ChatMessage[] = [];
      for (let i = 0; i < 20; i += 1) {
        h.push(u(`${'padding '.repeat(100)} #${i}`));
      }
      h.push(aWithCalls('call-1', '{ "path": "x" }'));
      h.push(toolMsg('call-1', 'result content'));
      h.push(u('continue'));
      const res = await maybeCompact(h, client(), { tokens: 1000 });
      expect(res.compacted).toBe(true);
      // the first kept message is NOT a tool result
      expect(res.messages[1]!.role).not.toBe('tool');
      // and every assistant tool_call in the kept region still has its result
      const kept = res.messages.slice(1);
      for (let i = 0; i < kept.length; i += 1) {
        const m = kept[i]!;
        if (m.role === 'assistant' && (m.tool_calls ?? []).length > 0) {
          const ids = new Set((m.tool_calls ?? []).map((c) => c.id));
          for (let j = i + 1; j < kept.length; j += 1) {
            const n = kept[j]!;
            if (n.role === 'tool') ids.delete(n.tool_call_id);
          }
          expect([...ids]).toEqual([]);
        }
      }
    } finally {
      server.close();
    }
  });

  it('fail-soft — a throwing summarizer returns the history unchanged', async () => {
    const h = longHistory();
    const fakeClient = client();
    const res = await maybeCompact(h, fakeClient, {
      tokens: 1000,
      summarize: async () => {
        throw new Error('summarizer rail down');
      },
    });
    expect(res.compacted).toBe(false);
    expect(res.messages).toEqual(h);
  });

  it('empty summary — treated as failure, unchanged', async () => {
    const h = longHistory();
    const res = await maybeCompact(h, client(), {
      tokens: 1000,
      summarize: async () => '',
    });
    expect(res.compacted).toBe(false);
  });

  it('KEEP_RECENT tail preserved exactly', async () => {
    server = await startMockServer();
    server.setHandler(() => ({ status: 200, sse: CHAT_STREAM_FULL }));
    try {
      const h = longHistory();
      const res = await maybeCompact(h, client(), { tokens: 5000 });
      expect(res.compacted).toBe(true);
      const kept = res.messages.slice(1);
      // kept region must be a suffix of the original
      const suffix = h.slice(h.length - kept.length);
      expect(kept).toEqual(suffix);
      expect(kept.length).toBeGreaterThanOrEqual(KEEP_RECENT - 2); // snap may trim a couple
    } finally {
      server.close();
    }
  });
});
