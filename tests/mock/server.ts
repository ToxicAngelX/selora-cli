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
}

export type MockHandler = (req: CapturedRequest, res: ServerResponse) => MockResponse | Promise<MockResponse>;

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

export async function startMockServer(): Promise<MockServer> {
  const requests: CapturedRequest[] = [];
  let handler: MockHandler = () => ({ status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' });
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
        .then((mock: MockResponse) => {
          if (mock.hang === true) return; // leave the socket open, never respond
          res.writeHead(mock.status, {
            'content-type': 'application/json',
            'x-request-id': requestId,
            ...(mock.headers ?? {}),
          });
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
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}
