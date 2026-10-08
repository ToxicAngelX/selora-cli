import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/api/sse.js';
import { streamChat } from '../src/api/endpoints/chat.js';
import { SeloraClient } from '../src/api/client.js';

function fakeClient(events: ReadonlyArray<readonly [string, string | undefined]>): SeloraClient {
  const client = new SeloraClient({ baseUrl: 'http://localhost', apiKey: 'sk-gw-TEST' });
  (client as unknown as {
    requestStream: (
      path: string,
      opts: { onEvent: (data: string, id?: string) => void },
    ) => Promise<void>;
  }).requestStream = async (_path, opts) => {
    for (const [event, id] of events) opts.onEvent(event, id);
  };
  return client;
}

describe('stream identity', () => {
  it('parses SSE ids and ignores duplicate events in streamChat', async () => {
    const seen: string[] = [];
    const parser = createSseParser((data, id) => seen.push(`${id ?? '-'}:${data}`));
    parser('id: 1\ndata: first\n\nid: 1\ndata: first\n\nid: 2\ndata: second\n\n');
    expect(seen).toEqual(['1:first', '1:first', '2:second']);

    const deltas: string[] = [];
    await streamChat(
      fakeClient([
        ['{"choices":[{"delta":{"content":"Hi"}}]}', '1'],
        ['{"choices":[{"delta":{"content":"Hi"}}]}', '1'],
      ]),
      { model: 'test', messages: [{ role: 'user', content: 'x' }] },
      { onDelta: (text) => deltas.push(text) },
    );
    expect(deltas).toEqual(['Hi']);
  });
});
