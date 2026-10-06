/**
 * Agent session tests: the store (names, save/load/list/delete, atomic write,
 * malformed-file honesty) and the `selora sessions` command (list, show, rm)
 * driven through injected CliContext. `show` passes rendered text through the
 * redaction chokepoint — a session whose conversation swallowed a real-looking
 * key prints redacted (the canary mechanism, like redact.test.ts).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanup, capturedIo, freshEnv, type TempEnv } from './helpers/env.js';
import {
  deleteSession,
  listSessions,
  loadSession,
  newSession,
  saveSession,
  sessionNameOk,
  sessionPath,
  sessionsDir,
} from '../src/agent/session/store.js';
import { runSessions } from '../src/commands/sessions.js';
import type { CliContext, CliIo } from '../src/context.js';

let env: TempEnv;

beforeAll(() => {
  env = freshEnv();
});

afterAll(() => {
  cleanup(env.dir);
});

function tempProject(): string {
  return mkdtempSync(join(tmpdir(), 'selora-sess-'));
}

function ctx(io: CliIo, json = false): CliContext {
  return { debug: false, json, apiUrl: 'http://127.0.0.1:1', io };
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

describe('session store', () => {
  it('name validation: the conservative slug set (a name can never traverse)', () => {
    for (const good of ['a', 'fix-login-2', 'Refactor_.v2', 'x'.repeat(64)]) {
      expect(sessionNameOk(good)).toBe(true);
    }
    for (const bad of [
      '',
      '-leading-dash',
      '.dotfile',
      'has space',
      'has/slash',
      'has\\backslash',
      'x'.repeat(65),
      '../escape',
      'nul\0byte',
    ]) {
      expect(sessionNameOk(bad)).toBe(false);
    }
  });

  it('save/load roundtrip: full wire-shaped history (tool calls + tool results) survives', () => {
    const root = tempProject();
    try {
      const s = newSession('fix-login', 'glm-5.3-flash');
      s.messages = [
        { role: 'user', content: 'fix the login bug' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":"src/login.ts"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'the file contents' },
        { role: 'assistant', content: 'fixed it' },
      ];
      const path = saveSession(root, s);
      expect(path).toBe(sessionPath(root, 'fix-login'));
      const loaded = loadSession(root, 'fix-login');
      expect(loaded).not.toBeNull();
      expect(loaded!.messages).toEqual(s.messages);
      expect(loaded!.model).toBe('glm-5.3-flash');
      // save refreshes updatedAt (never earlier than createdAt)
      expect(loaded!.updatedAt >= loaded!.createdAt).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('save is atomic: no tmp files are left behind; dirs are created on demand', () => {
    const root = tempProject();
    try {
      expect(existsSync(sessionsDir(root))).toBe(false);
      saveSession(root, newSession('one', 'm1'));
      saveSession(root, newSession('two', 'm2'));
      const files = readdirSync(sessionsDir(root));
      expect(files.sort()).toEqual(['one.json', 'two.json']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('load: missing session → null; malformed JSON / wrong shapes → null, never a crash', () => {
    const root = tempProject();
    try {
      expect(loadSession(root, 'ghost')).toBeNull();
      mkdirSync(sessionsDir(root), { recursive: true });
      writeFileSync(sessionPath(root, 'broken'), '{not json', 'utf8');
      expect(loadSession(root, 'broken')).toBeNull();
      writeFileSync(sessionPath(root, 'array'), '[]', 'utf8');
      expect(loadSession(root, 'array')).toBeNull();
      writeFileSync(
        sessionPath(root, 'nomessages'),
        JSON.stringify({ name: 'x', model: 'm', createdAt: 't', updatedAt: 't' }),
        'utf8',
      );
      expect(loadSession(root, 'nomessages')).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('list: newest update first, message counts, ignores non-session files', () => {
    const root = tempProject();
    try {
      // files written with EXPLICIT updatedAt values — the sort is deterministic
      const older = { ...newSession('older', 'm'), updatedAt: '2026-10-05T10:00:00.000Z' };
      const newer = {
        ...newSession('newer', 'm'),
        updatedAt: '2026-10-05T11:00:00.000Z',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'yo' },
        ],
      };
      mkdirSync(sessionsDir(root), { recursive: true });
      writeFileSync(sessionPath(root, 'older'), JSON.stringify(older), 'utf8');
      writeFileSync(sessionPath(root, 'newer'), JSON.stringify(newer), 'utf8');
      writeFileSync(join(sessionsDir(root), 'notes.txt'), 'not a session', 'utf8');
      const list = listSessions(root);
      expect(list.map((s) => s.name)).toEqual(['newer', 'older']);
      expect(list[0]!.messageCount).toBe(2);
      expect(list[1]!.messageCount).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('delete: true when it existed, false when it did not', () => {
    const root = tempProject();
    try {
      saveSession(root, newSession('gone', 'm'));
      expect(deleteSession(root, 'gone')).toBe(true);
      expect(existsSync(sessionPath(root, 'gone'))).toBe(false);
      expect(deleteSession(root, 'gone')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// the sessions command
// ---------------------------------------------------------------------------

describe('selora sessions', () => {
  it('list: empty project → the honest start-hint; populated → newest-first lines', async () => {
    const root = tempProject();
    try {
      const { io, cap } = capturedIo();
      await runSessions(ctx(io), undefined, undefined, { cwd: root });
      expect(cap.err.join('\n')).toContain(
        'no sessions in this project — start one: selora run --session <name> "<prompt>"',
      );

      const s = newSession('work', 'glm-5.3-flash');
      s.messages = [{ role: 'user', content: 'hi' }];
      saveSession(root, s);
      const { io: io2, cap: cap2 } = capturedIo();
      await runSessions(ctx(io2), 'list', undefined, { cwd: root });
      expect(cap2.out.join('\n')).toContain('Sessions in');
      expect(cap2.out.join('\n')).toContain('work');
      expect(cap2.out.join('\n')).toContain('glm-5.3-flash · 1 messages');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('list --json: the machine shape (no stdout chatter)', async () => {
    const root = tempProject();
    try {
      const s = newSession('j', 'm1');
      s.messages = [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' },
      ];
      saveSession(root, s);
      const { io, cap } = capturedIo();
      await runSessions(ctx(io, true), 'list', undefined, { cwd: root });
      const parsed = JSON.parse(cap.out.join('')) as {
        ok: boolean;
        sessions: Array<{ name: string; messages: number }>;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.sessions).toEqual([
        { name: 'j', model: 'm1', updatedAt: expect.any(String), messages: 2 },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('show: renders roles incl. tool calls/results, truncates at 400 chars, REDACTS key material', async () => {
    const root = tempProject();
    try {
      const s = newSession('mixed', 'glm-5.3-flash');
      const long = 'x'.repeat(500);
      s.messages = [
        { role: 'user', content: `use sk-gw-REALKEY1234567890 ${long}` },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_9',
              type: 'function',
              function: { name: 'read_file', arguments: '{"path":".env"}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_9', content: 'sk-gw-ANOTHERKEY000000' },
        { role: 'assistant', content: 'done' },
      ];
      saveSession(root, s);
      const { io, cap } = capturedIo();
      await runSessions(ctx(io), 'show', 'mixed', { cwd: root });
      const text = cap.out.join('\n');
      expect(text).toContain('name');
      expect(text).toContain('user');
      expect(text).toContain('read_file({"path":".env"})'); // assistant tool_calls rendered
      expect(text).toContain('[call_9]'); // tool result rendered with its call id
      expect(text).toContain('… (truncated)'); // 400-char display truncation
      // the redaction chokepoint: real-looking keys never print
      expect(text).not.toContain('REALKEY1234567890');
      expect(text).toContain('sk-gw-…redacted');
      expect(text).not.toContain('ANOTHERKEY000000');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('show --json carries the FULL untruncated messages (data the user fetched)', async () => {
    const root = tempProject();
    try {
      const s = newSession('full', 'm');
      s.messages = [{ role: 'user', content: 'x'.repeat(500) }];
      saveSession(root, s);
      const { io, cap } = capturedIo();
      await runSessions(ctx(io, true), 'show', 'full', { cwd: root });
      const parsed = JSON.parse(cap.out.join('')) as {
        ok: boolean;
        messages: Array<{ content: string }>;
      };
      expect(parsed.ok).toBe(true);
      expect(parsed.messages[0]!.content).toHaveLength(500);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rm: --yes deletes (json + text); without --yes non-interactively it refuses with exit 1', async () => {
    const root = tempProject();
    try {
      saveSession(root, newSession('kill', 'm'));
      const { io, cap } = capturedIo();
      await runSessions(ctx(io), 'rm', 'kill', { cwd: root, yes: true });
      expect(cap.out.join('\n')).toContain('Deleted session kill');
      expect(existsSync(sessionPath(root, 'kill'))).toBe(false);

      saveSession(root, newSession('keep', 'm'));
      const { io: io2, cap: cap2 } = capturedIo();
      await runSessions(ctx(io2), 'rm', 'keep', { cwd: root });
      expect(cap2.err.join('\n')).toContain('confirmation required — pass --yes');
      expect(process.exitCode).toBe(1);
      expect(existsSync(sessionPath(root, 'keep'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('usage errors: unknown name, missing name, unknown action', async () => {
    const root = tempProject();
    try {
      const missing = capturedIo();
      await runSessions(ctx(missing.io), 'show', 'ghost', { cwd: root });
      expect(missing.cap.err.join('\n')).toContain('no session named "ghost"');
      expect(process.exitCode).toBe(1);

      const noName = capturedIo();
      await runSessions(ctx(noName.io), 'show', undefined, { cwd: root });
      expect(noName.cap.err.join('\n')).toContain('Usage: selora sessions show <name>');

      const badAction = capturedIo();
      await runSessions(ctx(badAction.io), 'explode', undefined, { cwd: root });
      expect(badAction.cap.err.join('\n')).toContain('unknown action "explode"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
