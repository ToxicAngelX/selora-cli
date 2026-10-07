/**
 * The workspace trust screen (v0.8): the pure gate (trustScreenCapable), the
 * picker itself (runTrustScreen over a scripted stdin), and the chat startup
 * gating end-to-end — untrusted cwd shows the screen, Enter trusts and the
 * REPL starts, second launch goes straight in, "No, exit"/Esc exits 0 with
 * one short line, and --json/--yes/non-raw stdin never see the screen at all.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { startMockServer, type MockServer } from './mock/server.js';
import {
  CHAT_STREAM_FULL,
  FAKE_KEY_USER,
  REVOKED_KEY_401,
  modelDetailBody,
} from './mock/fixtures.js';
import { cleanup, freshEnv, useApiUrl, type TempEnv } from './helpers/env.js';
import { saveConfig } from '../src/config/index.js';
import { homeAbbrev, isTrustedDir, trustDir, trustedPath } from '../src/config/trust.js';
import { runTrustScreen, trustScreenCapable } from '../src/ui/trustscreen.js';
import { themeFor } from '../src/ui/theme.js';
import { runChat } from '../src/commands/chat.js';
import type { CliContext, CliIo } from '../src/context.js';

const plain = themeFor('mono', false); // level 0: styling is the identity

let server: MockServer;
let env: TempEnv;
const envDirs: string[] = [];

beforeAll(async () => {
  server = await startMockServer();
  useApiUrl(server.url);
});

beforeEach(() => {
  env = freshEnv();
  envDirs.push(env.dir);
});

afterAll(async () => {
  for (const d of envDirs) cleanup(d);
  await server.close();
});

function realTempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

async function until(cond: () => boolean, label: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`condition not met in time: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('trustScreenCapable — the startup gate', () => {
  const base = {
    isTTY: true,
    json: false,
    yes: false,
    stdinRawCapable: true,
    env: {} as NodeJS.ProcessEnv,
  };

  it('shows only on an interactive, menu-capable terminal without --json/--yes', () => {
    expect(trustScreenCapable(base)).toBe(true);
    expect(trustScreenCapable({ ...base, isTTY: false })).toBe(false);
    expect(trustScreenCapable({ ...base, json: true })).toBe(false);
    expect(trustScreenCapable({ ...base, yes: true })).toBe(false);
    expect(trustScreenCapable({ ...base, stdinRawCapable: false })).toBe(false);
  });

  it('NO_COLOR and TERM=dumb never see the screen', () => {
    expect(trustScreenCapable({ ...base, env: { NO_COLOR: '1' } })).toBe(false);
    expect(trustScreenCapable({ ...base, env: { TERM: 'dumb' } })).toBe(false);
    expect(trustScreenCapable({ ...base, env: { TERM: 'xterm-256color' } })).toBe(true);
  });
});

describe('runTrustScreen — the picker', () => {
  function screenIo(stdin: PassThrough): {
    io: { stdin: PassThrough; write: (s: string) => void };
    text(): string;
  } {
    let text = '';
    return {
      io: {
        stdin,
        write: (s) => {
          text += s;
        },
      },
      text: () => text,
    };
  }

  it('renders the reference layout: workspace line, safety check, numbered options, footer', async () => {
    const cwd = join(env.dir, 'proj');
    mkdirSync(cwd, { recursive: true });
    const stdin = new PassThrough();
    const h = screenIo(stdin);
    const picked = runTrustScreen({ cwd, theme: plain, io: h.io });
    await tick();
    const shown = h.text();
    expect(shown).toContain('Accessing workspace:');
    // the path renders exactly as homeAbbrev computes it for this env
    expect(shown).toContain(` ${homeAbbrev(realpathSync(cwd))}`);
    expect(shown).toContain('Quick safety check: is this a folder you created or one you trust?');
    expect(shown).toContain('read, edit, and run commands here.');
    expect(shown).toContain('❯ 1. Yes, I trust this folder');
    expect(shown).toContain('  2. No, exit');
    expect(shown).toContain('Enter to confirm · Esc to cancel');
    stdin.write('\x1b'); // Esc — don't leave the promise hanging
    await expect(picked).resolves.toBe(false);
  });

  it('Enter on option 1 trusts the folder (persisted) and resolves true', async () => {
    const cwd = realTempDir('selora-screen-');
    const stdin = new PassThrough();
    const h = screenIo(stdin);
    try {
      const picked = runTrustScreen({ cwd, theme: plain, io: h.io });
      await tick();
      stdin.write('\r');
      await expect(picked).resolves.toBe(true);
      expect(isTrustedDir(cwd)).toBe(true);
      expect(existsSync(trustedPath())).toBe(true);
      expect(h.text()).toContain("won't ask about this folder again");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('arrow-down + Enter ("No, exit") resolves false and persists NOTHING', async () => {
    const cwd = realTempDir('selora-screen-');
    const stdin = new PassThrough();
    const h = screenIo(stdin);
    try {
      const picked = runTrustScreen({ cwd, theme: plain, io: h.io });
      await tick();
      stdin.write('\x1b[B');
      await tick();
      stdin.write('\r');
      await expect(picked).resolves.toBe(false);
      expect(isTrustedDir(cwd)).toBe(false);
      expect(existsSync(trustedPath())).toBe(false);
      expect(h.text()).toContain('· not trusted — exiting');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Esc resolves false (cancel == exit)', async () => {
    const cwd = realTempDir('selora-screen-');
    const stdin = new PassThrough();
    const h = screenIo(stdin);
    try {
      const picked = runTrustScreen({ cwd, theme: plain, io: h.io });
      await tick();
      stdin.write('\x1b');
      await expect(picked).resolves.toBe(false);
      expect(isTrustedDir(cwd)).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// chat startup gating (through runChat against the mock gateway)
// ---------------------------------------------------------------------------

function installChatRoutes(): void {
  server.setHandler((req) => {
    if (req.method === 'GET' && req.path.startsWith('/v1/models/')) {
      const id = decodeURIComponent(req.path.slice('/v1/models/'.length));
      return { status: 200, body: modelDetailBody(id) };
    }
    if (req.method === 'POST' && req.path === '/v1/chat/completions') {
      if ((req.headers['authorization'] ?? '') !== `Bearer ${FAKE_KEY_USER}`) {
        return { status: 401, body: REVOKED_KEY_401 };
      }
      return { status: 200, sse: CHAT_STREAM_FULL };
    }
    return { status: 404, body: '{"error":{"code":"not_found","message":"no fixture"}}' };
  });
}

/** Raw-mode-capable stdin (a PassThrough with a setRawMode stub) — what a real terminal looks like. */
function rawStdin(): PassThrough & { setRawMode(m: boolean): void } {
  const s = new PassThrough() as PassThrough & { setRawMode(m: boolean): void };
  s.setRawMode = () => {};
  return s;
}

function ttyIo(stdin: PassThrough): {
  io: CliIo;
  cap: { out(): string; err(): string; all(): string };
} {
  let out = '';
  let err = '';
  const io: CliIo = {
    stdin,
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

function chatCtx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: server.url, io };
}

describe('chat startup — the trust gate', () => {
  it('untrusted cwd: the screen renders, Enter trusts, the REPL starts, and the SECOND launch goes straight in', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      // first launch: the screen appears and trusts on Enter
      const stdin1 = rawStdin();
      const h1 = ttyIo(stdin1);
      const first = runChat(chatCtx(h1.io), { cwd });
      await until(() => h1.cap.err().includes('Accessing workspace:'), 'trust screen');
      stdin1.write('\r');
      await until(() => h1.cap.out().includes('Connected to'), 'REPL started');
      stdin1.write('/exit\n');
      await first;
      expect(h1.cap.all()).toContain('✓ Session ended');
      expect(isTrustedDir(cwd)).toBe(true);

      // second launch: no screen, straight into chat
      const stdin2 = rawStdin();
      const h2 = ttyIo(stdin2);
      const second = runChat(chatCtx(h2.io), { cwd });
      await until(() => h2.cap.out().includes('Connected to'), 'REPL started');
      expect(h2.cap.all()).not.toContain('Accessing workspace:');
      stdin2.write('/exit\n');
      await second;
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('"No, exit": one short line, exit 0, the REPL never starts, nothing persisted', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      const stdin = rawStdin();
      const h = ttyIo(stdin);
      const chat = runChat(chatCtx(h.io), { cwd });
      await until(() => h.cap.err().includes('Accessing workspace:'), 'trust screen');
      stdin.write('\x1b[B');
      await tick();
      stdin.write('\r');
      await chat;
      expect(h.cap.err()).toContain('· not trusted — exiting');
      expect(h.cap.all()).not.toContain('Connected to');
      expect(process.exitCode).toBeUndefined();
      expect(isTrustedDir(cwd)).toBe(false);
      expect(existsSync(trustedPath())).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('Esc cancels exactly like "No, exit"', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      const stdin = rawStdin();
      const h = ttyIo(stdin);
      const chat = runChat(chatCtx(h.io), { cwd });
      await until(() => h.cap.err().includes('Accessing workspace:'), 'trust screen');
      stdin.write('\x1b');
      await chat;
      expect(h.cap.err()).toContain('· not trusted — exiting');
      expect(process.exitCode).toBeUndefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--json: no screen, no block (an untrusted cwd goes straight to the REPL)', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      const stdin = rawStdin();
      const h = ttyIo(stdin);
      const chat = runChat(chatCtx(h.io, true), { cwd });
      await until(() => h.cap.out().includes('Connected to'), 'json session started');
      expect(h.cap.all()).not.toContain('Accessing workspace:');
      stdin.write('/exit\n');
      await chat;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--yes implies trust for the session: no screen, nothing persisted', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      const stdin = rawStdin();
      const h = ttyIo(stdin);
      const chat = runChat(chatCtx(h.io), { cwd, yes: true });
      await until(() => h.cap.out().includes('Connected to'), 'REPL started');
      expect(h.cap.all()).not.toContain('Accessing workspace:');
      stdin.write('/exit\n');
      await chat;
      expect(isTrustedDir(cwd)).toBe(false);
      expect(existsSync(trustedPath())).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('an already-trusted cwd (selora trust add) skips the screen entirely', async () => {
    saveConfig({ apiKey: FAKE_KEY_USER });
    installChatRoutes();
    const cwd = realTempDir('selora-chat-trust-');
    try {
      trustDir(cwd);
      const stdin = rawStdin();
      const h = ttyIo(stdin);
      const chat = runChat(chatCtx(h.io), { cwd });
      await until(() => h.cap.out().includes('Connected to'), 'REPL started');
      expect(h.cap.all()).not.toContain('Accessing workspace:');
      stdin.write('/exit\n');
      await chat;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
