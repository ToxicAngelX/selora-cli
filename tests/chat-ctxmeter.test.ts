/**
 * REPL-level integration: the ctx meter line renders in the prompt block once
 * the conversation has history, and a session that crosses the compaction
 * threshold actually compacts (marker message in the SAVED session, bullet
 * printed, conversation continues).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { CliIo } from '../src/context.js';
import type { CliContext } from '../src/context.js';
import { runChat } from '../src/commands/chat.js';
import { startMockServer, type MockServer } from './mock/server.js';
import { CHAT_STREAM_FULL, FAKE_KEY_USER, modelDetailBody } from './mock/fixtures.js';
import { saveConfig } from '../src/config/index.js';
import { cleanup, freshEnv, type TempEnv } from './helpers/env.js';
import { trustDir } from '../src/config/trust.js';

let server: MockServer;
let env: TempEnv;

beforeAll(async () => {
  server = await startMockServer();
  env = freshEnv();
});

afterAll(async () => {
  cleanup(env.dir);
  await server.close();
});

const chatDirs: string[] = [];
function chatCwd(seloraJson?: string): string {
  const d = mkdtempSync(join(tmpdir(), 'selora-ctxmeter-'));
  chatDirs.push(d);
  if (seloraJson !== undefined) {
    writeFileSync(join(d, 'selora.json'), seloraJson, 'utf8');
  }
  return d;
}

afterAll(() => {
  for (const d of chatDirs) rmSync(d, { recursive: true, force: true });
});

function replIo(lines: string[]): {
  io: CliIo;
  cap: { all(): string; err(): string };
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
  return { io, cap: { all: () => `${out}\n${err}`, err: () => err } };
}

function ctx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

function installRoutes(): void {
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.path.slice('/v1/models/'.length));
      return { status: 200, body: modelDetailBody(id) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    return { status: 404, body: '{}' };
  });
}

describe('chat ctx meter + compaction', () => {
  it('the ctx bar renders in the prompt block after a reply (sessionTokens > 0 too)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const cwd = chatCwd();
    trustDir(cwd);
    const { io, cap } = replIo(['hello', '/exit']);
    await runChat(ctx(io), { cwd });
    const text = cap.all();
    expect(text).toContain('ctx ▱▱▱▱'); // empty-ish bar: cells + 'ctx ' prefix
    expect(text).toContain('0%'); // tiny conversation, nearly empty bar
    expect(text).toContain('30,000'); // default budget on the meter
    expect(text).toContain('✓ Session ended');
  });

  it('compaction fires when the threshold is crossed (tiny budget in selora.json)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    // 4000-token budget: one mock turn's usage alone doesn't count, but the
    // RESUMED history does — seed a session file with a big history first.
    const cwd = chatCwd(JSON.stringify({ agent: { contextTokens: 1000 } }));
    trustDir(cwd);

    // first session: one message, saved to disk
    const { io: io1 } = replIo(['hello', '/exit']);
    await runChat(ctx(io1), { cwd });

    // now craft a big saved session by appending messages to the stored file
    const sessionFile = join(cwd, '.selora/sessions/chat.json');
    const stored = JSON.parse(readFileSync(sessionFile, 'utf8')) as {
      messages: { role: string; content: string }[];
    };
    const filler = 'x'.repeat(200);
    while (stored.messages.length < 40) {
      stored.messages.push({ role: 'user', content: filler });
      stored.messages.push({ role: 'assistant', content: filler });
    }
    writeFileSync(sessionFile, JSON.stringify(stored), 'utf8');

    // resume: the big history + one new prompt → estimate crosses 1000*0.9
    // → compaction runs BEFORE the model call
    const { io, cap } = replIo(['hello again', '/exit']);
    await runChat(ctx(io), { cwd, resumeName: 'chat' });
    const text = cap.all();
    expect(text).toContain('context compacted');
    expect(text).toContain('messages folded into a summary');

    // the saved session now carries the marker
    const after = JSON.parse(readFileSync(sessionFile, 'utf8')) as {
      messages: { role: string; content: string }[];
    };
    const marker = after.messages.find(
      (m) => typeof m.content === 'string' && m.content.includes('compacted'),
    );
    expect(marker).toBeDefined();
    expect(after.messages.length).toBeLessThan(stored.messages.length);
    expect(text).toContain('✓ Session ended');
  });

  it('json mode: no bar, no compaction chatter', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installRoutes();
    const cwd = chatCwd();
    trustDir(cwd);
    const { io, cap } = replIo(['hello', '/exit']);
    // json + piped stdin: the machine path
    const ioJson: CliIo = { ...io, isTTY: false };
    await runChat(ctx(ioJson, true), { cwd });
    const text = cap.all();
    expect(text).not.toContain('ctx ▰');
    expect(text).not.toContain('compaction threshold');
  });
});
