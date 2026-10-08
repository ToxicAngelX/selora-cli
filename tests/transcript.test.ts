import { describe, expect, it } from 'vitest';
import { TranscriptStore } from '../src/ui/transcript.js';

describe('TranscriptStore', () => {
  it('updates one assistant message in place and finalizes idempotently', () => {
    const store = new TranscriptStore();
    store.apply({ type: 'append', id: 'assistant:1', kind: 'assistant', text: 'hel' });
    store.apply({ type: 'append', id: 'assistant:1', kind: 'assistant', text: 'lo' });
    store.apply({ type: 'complete', id: 'assistant:1' });
    store.apply({ type: 'complete', id: 'assistant:1' });
    expect(store.snapshot()).toEqual([
      { id: 'assistant:1', kind: 'assistant', text: 'hello', complete: true, rendered: false },
    ]);
  });

  it('ignores a duplicated event key and renders each message once', () => {
    const store = new TranscriptStore();
    store.apply(
      { type: 'append', id: 'assistant:1', kind: 'assistant', text: 'hello' },
      'turn-1:delta-1',
    );
    store.apply(
      { type: 'append', id: 'assistant:1', kind: 'assistant', text: 'hello' },
      'turn-1:delta-1',
    );
    expect(store.snapshot()[0]?.text).toBe('hello');
    expect(store.markRendered('assistant:1')).toBe(true);
    expect(store.markRendered('assistant:1')).toBe(false);
  });

  it('sanitizes untrusted message text before it reaches the renderer', () => {
    const esc = String.fromCharCode(27);
    const store = new TranscriptStore();
    store.apply({
      type: 'append',
      id: 'tool:1',
      kind: 'tool',
      text: `safe${esc}[2Jtext`,
    });
    expect(store.snapshot()[0]?.text).toBe('safetext');
  });
});
