/**
 * Plain node:http mock gateway on 127.0.0.1:0 (ephemeral port). Tests install
 * a handler; every request is captured (method, path, headers, body) so tests
 * can assert Authorization headers were sent correctly. Responses always
 * carry an x-request-id header, per the wire reference.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface CapturedRequest {
  method: string;
  /** Path WITHOUT the query string. */
  path: string;
  /** Full request URL including the query string (e.g. /v1/me/usage?days=7). */
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockResponse {
  status: number;
  headers?: Record<string, string> | undefined;
  body?: string | undefined;
  /** Never respond (for timeout tests). */
  hang?: boolean;
  /** SSE mode: raw frames written in order (each carries its own \n\n). Frames may split a single event across two entries — the client parser must buffer. */
  sse?: string[] | undefined;
  /** Delay in ms between SSE frames (default 0 — separate write() calls, no delay). */
  sseDelayMs?: number | undefined;
  /** After writing all frames, leave the stream open (mid-stream hang — abort tests). */
  sseHang?: boolean | undefined;
}

export type MockHandler = (
  req: CapturedRequest,
  res: ServerResponse,
) => MockResponse | Promise<MockResponse>;

export interface MockServer {
  port: number;
  url: string;
  requests: CapturedRequest[];
  setHandler(handler: MockHandler): void;
  close(): Promise<void>;
}

function flattenHeaders(msg: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(msg.headers)) {
    if (typeof v === 'string') out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(', ');
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let handler: MockHandler = () => ({
    status: 404,
    body: '{"error":{"code":"not_found","message":"no fixture"}}',
  });
  let n = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '/';
      const captured: CapturedRequest = {
        method: req.method ?? 'GET',
        path: url.split('?')[0]!,
        url,
        headers: flattenHeaders(req),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      n += 1;
      const requestId = `mock-req-${n}`;
      Promise.resolve(handler(captured, res))
        .then(async (mock: MockResponse) => {
          if (mock.hang === true) return; // leave the socket open, never respond
          const baseHeaders =
            mock.sse !== undefined
              ? { 'content-type': 'text/event-stream', 'x-request-id': requestId }
              : { 'content-type': 'application/json', 'x-request-id': requestId };
          res.writeHead(mock.status, { ...baseHeaders, ...(mock.headers ?? {}) });
          if (mock.sse !== undefined) {
            // Separate write() calls (optionally delayed) force the client to
            // buffer and parse incrementally.
            const delay = mock.sseDelayMs ?? 0;
            for (const frame of mock.sse) {
              if (delay > 0) await sleep(delay);
              res.write(frame);
            }
            if (mock.sseHang === true) return; // stream stays open mid-way
            res.end();
            return;
          }
          res.end(mock.body ?? '');
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'application/json', 'x-request-id': requestId });
          res.end(JSON.stringify({ error: { code: 'mock_error', message: String(err) } }));
        });
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    setHandler(h: MockHandler) {
      handler = h;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Destroy sockets left open by hang/sseHang responses so close() cannot block.
        server.closeAllConnections();
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
