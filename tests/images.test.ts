/**
 * Image input tests (v0.6): the @path tokenizer (quotes, escapes, Windows
 * paths, the literal-\@ hatch), the file guards (missing / directory / >4 MB /
 * extension), the multimodal user-content shape, and the WIRE encoding — a
 * chat turn with an image must reach /v1/chat/completions as a content array
 * with a data:image/... base64 part, and the transcript shows only the
 * `[image: name, KB]` marker.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL, FAKE_KEY_USER, modelDetailBody } from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import {
  extractImageTokens,
  formatImageSize,
  imageMarker,
  loadImageAttachment,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  parseImageInput,
  userMessageContent,
} from '../src/images.js';
import { runChat } from '../src/commands/chat.js';
import { runRun } from '../src/commands/run.js';
import type { CliContext, CliIo } from '../src/context.js';

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

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-img-'));
}

/** A tiny valid-enough PNG (the CLI never inspects content — the gateway does). */
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function writeImage(dir: string, name: string, bytes: Buffer = PNG_BYTES): void {
  writeFileSync(join(dir, name), bytes);
}

// ---------------------------------------------------------------------------
// tokenizer
// ---------------------------------------------------------------------------

describe('extractImageTokens', () => {
  it('no image tokens → the input is returned VERBATIM (no normalization)', () => {
    expect(extractImageTokens('describe  this   please')).toEqual({
      text: 'describe  this   please',
      paths: [],
    });
    expect(extractImageTokens('@channel ping @foo.txt')).toEqual({
      text: '@channel ping @foo.txt',
      paths: [],
    });
  });

  it('extracts @path tokens with image extensions; the rest is the text', () => {
    expect(extractImageTokens('what is in @shot.png here')).toEqual({
      text: 'what is in here',
      paths: ['shot.png'],
    });
    expect(extractImageTokens('@a.png @b.JPG')).toEqual({ text: '', paths: ['a.png', 'b.JPG'] });
  });

  it('backslash-escaped spaces (POSIX drag-and-drop) keep the path together', () => {
    expect(extractImageTokens('look @/tmp/my\\ shot.png please')).toEqual({
      text: 'look please',
      paths: ['/tmp/my shot.png'],
    });
  });

  it('quoted paths (Windows drag-and-drop) work after the marker', () => {
    expect(extractImageTokens('look @"C:\\my dir\\a.png" now')).toEqual({
      text: 'look now',
      paths: ['C:\\my dir\\a.png'],
    });
  });

  it('Windows paths survive: a backslash before a non-escapable char is literal', () => {
    expect(extractImageTokens('@C:\\shots\\a.png')).toEqual({
      text: '',
      paths: ['C:\\shots\\a.png'],
    });
  });

  it('\\@ escapes the marker: a literal @path.png stays in the text', () => {
    expect(extractImageTokens('mention \\@logo.png literally')).toEqual({
      text: 'mention \\@logo.png literally',
      paths: [],
    });
  });

  it('@ alone and @<non-image> are literal text', () => {
    expect(extractImageTokens('say @ to @notes.md here')).toEqual({
      text: 'say @ to @notes.md here',
      paths: [],
    });
  });
});

// ---------------------------------------------------------------------------
// file guards
// ---------------------------------------------------------------------------

describe('loadImageAttachment', () => {
  it('missing file → honest error, nothing encoded', () => {
    const dir = tempProject();
    try {
      const r = loadImageAttachment('ghost.png', dir);
      expect(r).toEqual({ ok: false, error: 'image not found: ghost.png' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a directory is not an image', () => {
    const dir = tempProject();
    try {
      mkdirSync(join(dir, 'pic.png'));
      const r = loadImageAttachment('pic.png', dir);
      expect(r).toEqual({ ok: false, error: 'not a file: pic.png' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('over 4 MB → refused BEFORE encoding, with the size in the message', () => {
    const dir = tempProject();
    try {
      writeImage(dir, 'huge.png', Buffer.alloc(MAX_IMAGE_BYTES + 1, 0x42));
      const r = loadImageAttachment('huge.png', dir);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toContain('image too large: huge.png');
        expect(r.error).toContain('4 MB');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a valid file encodes to a data URL with the right mime and size', () => {
    const dir = tempProject();
    try {
      writeImage(dir, 'ok.webp');
      const r = loadImageAttachment('ok.webp', dir);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.attachment.name).toBe('ok.webp');
        expect(r.attachment.bytes).toBe(PNG_BYTES.length);
        expect(r.attachment.dataUrl).toBe(`data:image/webp;base64,${PNG_BYTES.toString('base64')}`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('parseImageInput', () => {
  it(`more than ${MAX_IMAGES_PER_MESSAGE} images → hard error, nothing loaded`, () => {
    const dir = tempProject();
    try {
      for (const n of ['1', '2', '3', '4', '5']) writeImage(dir, `${n}.png`);
      const r = parseImageInput('@1.png @2.png @3.png @4.png @5.png', dir);
      expect(r).toEqual({
        ok: false,
        error: `too many images: 5 attached — the limit is ${MAX_IMAGES_PER_MESSAGE} per message`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the first failing file wins; the error names it', () => {
    const dir = tempProject();
    try {
      writeImage(dir, 'ok.png');
      const r = parseImageInput('@ok.png and @gone.png', dir);
      expect(r).toEqual({ ok: false, error: 'image not found: gone.png' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('up to 4 images attach in order with the text', () => {
    const dir = tempProject();
    try {
      for (const n of ['1', '2', '3', '4']) writeImage(dir, `${n}.png`);
      const r = parseImageInput('compare @1.png @2.png @3.png @4.png all', dir);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.text).toBe('compare all');
        expect(r.images.map((i) => i.name)).toEqual(['1.png', '2.png', '3.png', '4.png']);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// wire shape
// ---------------------------------------------------------------------------

describe('userMessageContent', () => {
  const img = {
    name: 'a.png',
    path: '/x/a.png',
    bytes: 3,
    dataUrl: 'data:image/png;base64,AAA',
  };

  it('no images → the plain string (the v1 shape, unchanged)', () => {
    expect(userMessageContent('hello', [])).toBe('hello');
  });

  it('with images → parts array, text first, then image_url parts', () => {
    expect(userMessageContent('look', [img])).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });

  it('images-only (empty text) carries NO empty text part', () => {
    expect(userMessageContent('', [img])).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]);
  });
});

describe('formatImageSize / imageMarker', () => {
  it('formats B, KB (one decimal, trimmed), and MB', () => {
    expect(formatImageSize(512)).toBe('512 B');
    expect(formatImageSize(2048)).toBe('2 KB');
    expect(formatImageSize(12700)).toBe('12.4 KB');
    expect(formatImageSize(4 * 1024 * 1024)).toBe('4 MB');
  });

  it('the marker is the exact transcript shape', () => {
    expect(
      imageMarker({ name: 'logo.png', path: '/x/logo.png', bytes: 12700, dataUrl: 'data:...' }),
    ).toBe('[image: logo.png, 12.4 KB]');
  });
});

// ---------------------------------------------------------------------------
// integration: chat and run against the mock gateway
// ---------------------------------------------------------------------------

function replIo(lines: string[]): {
  io: CliIo;
  cap: { out(): string; err(): string; all(): string };
} {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdin: Readable.from(lines.map((l) => `${l}\n`)),
    isTTY: true,
    out: (s) => {
      out += `${s}\n`;
    },
    err: (s) => {
      err += `${s}\n`;
    },
    writeOut: (s) => {
      out += s;
    },
    writeErr: (s) => {
      err += s;
    },
  };
  return { io, cap: { out: () => out, err: () => err, all: () => `${out}\n${err}` } };
}

function ctxFor(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

function installRoutes(): void {
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      return { status: 200, body: modelDetailBody(req.path.slice('/v1/models/'.length)) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
}

describe('images in chat and run (mock gateway)', () => {
  it('chat: @image attaches a data-URL part; the transcript shows the marker, never base64', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      writeImage(dir, 'shot.png');
      const before = server.requests.length;
      const { io, cap } = replIo(['what is in @shot.png', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });

      // the transcript marker printed; the base64 payload NEVER did
      expect(cap.out()).toContain(`[image: shot.png, ${formatImageSize(PNG_BYTES.length)}]`);
      expect(cap.all()).not.toContain(PNG_BYTES.toString('base64'));

      // the request body carried the multimodal parts array
      const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
      const body = JSON.parse(chatReq!.body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'what is in' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
          },
        ],
      });
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chat: a missing image errors BEFORE the turn and sends nothing', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const before = server.requests.length;
      const { io, cap } = replIo(['look at @ghost.png', '/exit']);
      await runChat(ctxFor(io), { cwd: dir });
      expect(cap.all()).toContain('✗ image not found: ghost.png');
      expect(server.requests.slice(before).some((r) => r.path === '/v1/chat/completions')).toBe(
        false,
      );
      expect(process.exitCode).toBeUndefined(); // the REPL stays alive
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run: the same @path syntax, marker on stderr, parts on the wire', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      writeImage(dir, 'run.png');
      const before = server.requests.length;
      const { io, cap } = replIo([]);
      await runRun(ctxFor(io), 'describe @run.png', { cwd: dir });
      expect(cap.err()).toContain(`· [image: run.png, ${formatImageSize(PNG_BYTES.length)}]`);
      const chatReq = server.requests.slice(before).find((r) => r.path === '/v1/chat/completions');
      const body = JSON.parse(chatReq!.body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.messages[0]).toEqual({
        role: 'user',
        content: [
          { type: 'text', text: 'describe' },
          {
            type: 'image_url',
            image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
          },
        ],
      });
      expect(cap.out()).toContain('Hello, world!');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run: an image-only prompt is valid (no usage error)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      writeImage(dir, 'only.png');
      const { io, cap } = replIo([]);
      await runRun(ctxFor(io), '@only.png', { cwd: dir });
      expect(cap.out()).toContain('Hello, world!');
      const chatReq = server.requests.at(-1)!;
      const body = JSON.parse(chatReq.body) as {
        messages: Array<{ role: string; content: unknown }>;
      };
      // no empty text part on the wire
      expect(body.messages[0]!.content).toEqual([
        {
          type: 'image_url',
          image_url: { url: `data:image/png;base64,${PNG_BYTES.toString('base64')}` },
        },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('run: image errors exit 1 with the friendly message (json + text)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const dir = tempProject();
    try {
      const before = server.requests.length;
      const { io, cap } = replIo([]);
      await runRun(ctxFor(io), 'look @missing.png', { cwd: dir });
      expect(cap.err()).toContain('✗ image not found: missing.png');
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      const { io: jio, cap: jcap } = replIo([]);
      await runRun(ctxFor(jio, true), 'look @missing.png', { cwd: dir });
      const parsed = JSON.parse(jcap.out()) as { ok: boolean; error: { message: string } };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.message).toBe('image not found: missing.png');
      expect(process.exitCode).toBe(1);
      expect(server.requests.slice(before).some((r) => r.path === '/v1/chat/completions')).toBe(
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
