/**
 * Unit tests for the push-based SSE parser. The critical property: events
 * split at EVERY byte boundary (fed one char at a time) still come out whole
 * and in order. Plus: keep-alive comments, multi-line data, CRLF tolerance,
 * the [DONE] sentinel, and the trailing-event flush.
 */

import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/api/sse.js';

function collect(): { events: string[]; onEvent: (data: string) => void } {
  const events: string[] = [];
  return { events, onEvent: (data: string) => events.push(data) };
}

describe('createSseParser', () => {
  it('parses simple events from one chunk', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: one\n\ndata: two\n\n');
    expect(events).toEqual(['one', 'two']);
  });

  it('delivers [DONE] like any other data event (raw, unquoted)', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: {"a":1}\n\ndata: [DONE]\n\n');
    expect(events).toEqual(['{"a":1}', '[DONE]']);
  });

  it('buffers events split across pushes at EVERY byte boundary (one char at a time)', () => {
    const stream =
      'data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n' +
      ': keep-alive\n\n' +
      'data: {"choices":[]}\n\n' +
      'data: [DONE]\n\n';
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    for (const ch of stream) {
      p(ch);
    }
    expect(events).toEqual([
      '{"choices":[{"index":0,"delta":{"content":"Hi"}}]}',
      '{"choices":[]}',
      '[DONE]',
    ]);
  });

  it('buffers a mid-event split at every possible single cut point', () => {
    const a = 'data: {"delta":{"content":"abcdefgh"}}\n\n';
    const b = 'data: [DONE]\n\n';
    for (let cut = 0; cut <= a.length; cut++) {
      const { events, onEvent } = collect();
      const p = createSseParser(onEvent);
      p(a.slice(0, cut));
      p(a.slice(cut));
      p(b);
      expect(events).toEqual(['{"delta":{"content":"abcdefgh"}}', '[DONE]'], `cut at ${cut}`);
    }
  });

  it('ignores keep-alive comment lines (and comment-only events)', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p(': keep-alive\n\n');
    p(': another comment\n\n');
    p('data: real\n\n');
    expect(events).toEqual(['real']);
  });

  it('joins multi-line data fields with \\n', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: line1\ndata: line2\n\ndata: solo\n\n');
    expect(events).toEqual(['line1\nline2', 'solo']);
  });

  it('strips exactly one optional space after the data field colon', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data:nospace\n\ndata: one space\n\ndata:  two spaces\n\n');
    expect(events).toEqual(['nospace', 'one space', ' two spaces']);
  });

  it('ignores non-data field lines (event:, id:, retry:)', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('event: message\nid: 7\ndata: payload\nretry: 100\n\n');
    expect(events).toEqual(['payload']);
  });

  it('tolerates CRLF line endings and \\r\\n\\r\\n event boundaries', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: a\r\ndata: b\r\n\r\ndata: c\r\n\r\n');
    expect(events).toEqual(['a\nb', 'c']);
  });

  it('tolerates mixed \\r\\n\\n boundaries and lone \\r endings', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: a\r\n\n');
    expect(events).toEqual(['a']);
    p('data: b\r\r');
    p('\n');
    expect(events).toEqual(['a', 'b']);
  });

  it('splits CRLF pairs across chunk boundaries (\\r then \n in separate pushes)', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: x\r');
    p('\n\r');
    p('\ndata: y\r');
    p('\n\r');
    p('\n');
    expect(events).toEqual(['x', 'y']);
  });

  it('a lone trailing \\r flushed at end still emits its event', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: tail\r');
    p.flush();
    expect(events).toEqual(['tail']);
  });

  it('flush emits a trailing event that never got its final blank line', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: complete\n\ndata: trailing');
    expect(events).toEqual(['complete']);
    p.flush();
    expect(events).toEqual(['complete', 'trailing']);
  });

  it('flush with nothing buffered is a no-op', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data: done\n\n');
    p.flush();
    expect(events).toEqual(['done']);
  });

  it('empty data events (data: with no value) are delivered as empty strings', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p('data:\n\n');
    expect(events).toEqual(['']);
  });

  it('multiple events in one chunk after a comment burst, all in order', () => {
    const { events, onEvent } = collect();
    const p = createSseParser(onEvent);
    p(': c1\n: c2\n\ndata: 1\n\ndata: 2\n\n: c3\n\ndata: 3\n\n');
    expect(events).toEqual(['1', '2', '3']);
  });
});
