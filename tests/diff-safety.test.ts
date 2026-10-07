/**
 * Diff safety tests: guardPath containment (escapes, symlink tricks,
 * not-yet-existing files), atomicWriteFile (exact bytes, mode preservation,
 * errno mapping, tmp litter), SnapshotTracker conflict detection, EOL
 * detection, and the secret scanner (every rule, placeholder suppression,
 * masking, the 20-finding cap).
 *
 * macOS note: tmpdir() may sit behind a symlink (/var → /private/var) and
 * guardPath resolves the root to its realpath, so every suite root here is
 * realpath-resolved up front (same convention as agent-paths.test.ts).
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  atomicWriteFile,
  detectEolOf,
  guardPath,
  readSnapshot,
  scanSecrets,
  SnapshotTracker,
} from '../src/diff/safety.js';

const dirs: string[] = [];

function tempRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'selora-diff-safety-')));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Tmp files atomicWriteFile must never leave behind. */
function tmpLitter(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes('.selora-') && name.endsWith('.tmp'));
}

describe('guardPath', () => {
  it('accepts a plain path inside the root and returns the resolved path', () => {
    const root = tempRoot();
    const res = guardPath(root, join(root, 'a', 'b.txt'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(join(root, 'a', 'b.txt'));
  });

  it('refuses a `..` climb out of the root with OUTSIDE_ROOT', () => {
    const root = tempRoot();
    const res = guardPath(root, join(root, '..', 'escape.txt'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('OUTSIDE_ROOT');
  });

  it('refuses an absolute path outside the root with OUTSIDE_ROOT', () => {
    const root = tempRoot();
    const outside = tempRoot();
    const res = guardPath(root, join(outside, 'elsewhere.txt'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('OUTSIDE_ROOT');
  });

  it('refuses a symlink inside the root that points outside', () => {
    const root = tempRoot();
    const outside = tempRoot();
    writeFileSync(join(outside, 'secret.txt'), 'shh');
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'));
    const res = guardPath(root, join(root, 'link.txt'));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('OUTSIDE_ROOT');
  });

  it('follows a symlink that stays inside the root', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'real.txt'), 'hi');
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'));
    const res = guardPath(root, join(root, 'alias.txt'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(realpathSync(join(root, 'real.txt')));
  });

  it('accepts a non-existent file under an existing directory', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'sub'));
    const res = guardPath(root, join(root, 'sub', 'new.txt'));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value).toBe(join(root, 'sub', 'new.txt'));
  });
});

describe('readSnapshot', () => {
  it('returns undefined for a missing file', () => {
    const root = tempRoot();
    expect(readSnapshot(join(root, 'nope.txt'))).toBeUndefined();
  });

  it('captures content, mode, EOL style and the trailing-newline flag', () => {
    const root = tempRoot();
    const abs = join(root, 'crlf.txt');
    writeFileSync(abs, 'a\r\nb\r\n');
    const snap = readSnapshot(abs);
    expect(snap).toBeDefined();
    expect(snap?.text).toBe('a\r\nb\r\n');
    expect(snap?.eol).toBe('crlf');
    expect(snap?.endsWithNewline).toBe(true);
    expect(typeof snap?.mode).toBe('number');
    expect(typeof snap?.mtimeMs).toBe('number');
  });
});

describe('atomicWriteFile', () => {
  it('creates a file with the exact content and reports utf8 bytes', () => {
    const root = tempRoot();
    const abs = join(root, 'hello.txt');
    const res = atomicWriteFile(abs, 'hello\n');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.bytes).toBe(6);
    expect(readFileSync(abs, 'utf8')).toBe('hello\n');
    expect(tmpLitter(root)).toEqual([]);
  });

  it('counts multibyte utf8 content in bytes, not characters', () => {
    const root = tempRoot();
    const abs = join(root, 'multi.txt');
    const content = 'héllo → ✓\n';
    const res = atomicWriteFile(abs, content);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.bytes).toBe(Buffer.byteLength(content, 'utf8'));
    expect(readFileSync(abs, 'utf8')).toBe(content);
  });

  it.skipIf(process.platform === 'win32')('preserves the existing file mode on overwrite', () => {
    const root = tempRoot();
    const abs = join(root, 'locked.txt');
    writeFileSync(abs, 'old');
    chmodSync(abs, 0o640);
    const res = atomicWriteFile(abs, 'new');
    expect(res.ok).toBe(true);
    expect(statSync(abs).mode & 0o777).toBe(0o640);
    expect(readFileSync(abs, 'utf8')).toBe('new');
  });

  it.skipIf(process.platform === 'win32')('applies opts.mode to a new file', () => {
    const root = tempRoot();
    const abs = join(root, 'private.txt');
    const res = atomicWriteFile(abs, 'x', { mode: 0o600 });
    expect(res.ok).toBe(true);
    expect(statSync(abs).mode & 0o777).toBe(0o600);
  });

  it('fails with ENOENT when the parent directory does not exist, leaving no tmp', () => {
    const root = tempRoot();
    const res = atomicWriteFile(join(root, 'nope', 'f.txt'), 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('ENOENT');
    expect(existsSync(join(root, 'nope'))).toBe(false);
    expect(tmpLitter(root)).toEqual([]);
  });

  it('fails with EISDIR when the target is a directory, leaving no tmp', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'adir'));
    const res = atomicWriteFile(join(root, 'adir'), 'x');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe('EISDIR');
    expect(tmpLitter(root)).toEqual([]);
  });
});

describe('SnapshotTracker', () => {
  it('reports no conflict right after note()', () => {
    const root = tempRoot();
    const abs = join(root, 'a.txt');
    writeFileSync(abs, 'before\n');
    const tracker = new SnapshotTracker();
    tracker.note(abs);
    expect(tracker.check(abs)).toEqual({ conflict: false });
  });

  it('detects an external modification between note() and check()', () => {
    const root = tempRoot();
    const abs = join(root, 'a.txt');
    writeFileSync(abs, 'before\n');
    const tracker = new SnapshotTracker();
    tracker.note(abs);
    writeFileSync(abs, 'after — someone else was here\n');
    const res = tracker.check(abs);
    expect(res.conflict).toBe(true);
    if (res.conflict) expect(res.message).toContain('changed');
  });

  it('warns honestly when overwriting a non-empty file never read this session', () => {
    const root = tempRoot();
    const abs = join(root, 'existing.txt');
    writeFileSync(abs, 'someone else wrote this\n');
    const tracker = new SnapshotTracker();
    const res = tracker.check(abs);
    expect(res.conflict).toBe(true);
    if (res.conflict) {
      expect(res.message).toBe('file exists on disk and was never read this session');
    }
  });

  it('reports no conflict for a file that does not exist yet', () => {
    const root = tempRoot();
    const tracker = new SnapshotTracker();
    expect(tracker.check(join(root, 'new.txt'))).toEqual({ conflict: false });
  });

  it('reports no conflict for an existing but empty file never read', () => {
    const root = tempRoot();
    const abs = join(root, 'empty.txt');
    writeFileSync(abs, '');
    const tracker = new SnapshotTracker();
    expect(tracker.check(abs)).toEqual({ conflict: false });
  });

  it('detects when a noted file is deleted before the write', () => {
    const root = tempRoot();
    const abs = join(root, 'gone.txt');
    writeFileSync(abs, 'was here\n');
    const tracker = new SnapshotTracker();
    tracker.note(abs);
    rmSync(abs);
    const res = tracker.check(abs);
    expect(res.conflict).toBe(true);
  });
});

describe('detectEolOf', () => {
  it('classifies lf, crlf, mixed and terminator-free text', () => {
    expect(detectEolOf('a\nb')).toBe('lf');
    expect(detectEolOf('a\r\nb')).toBe('crlf');
    expect(detectEolOf('a\nb\r\nc')).toBe('mixed');
    expect(detectEolOf('')).toBe('none');
    expect(detectEolOf('abc')).toBe('none');
  });
});

describe('scanSecrets', () => {
  it('flags a private key banner', () => {
    const findings = scanSecrets('-----BEGIN OPENSSH PRIVATE KEY-----\nbody\n');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('private-key');
    expect(findings[0]?.line).toBe(1);
  });

  it('flags an AWS access key id', () => {
    const secret = 'AKIA1234567890ABCDEF';
    const findings = scanSecrets(`const id = "${secret}";`);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('aws-access-key');
    expect(findings[0]?.snippet).not.toContain(secret);
  });

  it('flags an AWS secret access key assignment', () => {
    const findings = scanSecrets('aws_secret_access_key = wJalrXUtnFEMIK7MDENGbPxRfiCYzABCD1234');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('aws-secret-key');
  });

  it('flags api tokens (sk-*, ghp_*, glpat-*, xox*, AIza*, JWT)', () => {
    const cases = [
      'sk-abcdefghij0123456789abcd',
      'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
      'github_pat_11ABCDEFG0aBcDeFgHiJkLmN_oPqRsTuVwXyZ0123456',
      'glpat-aBcDeFgHiJkLmNoPqRsT',
      'xoxb-1234567890ab',
      'AIzaSyAbcDefGhijkLmnOpQrsTuvWxYz0123456789',
      'eyJaaaaaaaaaa.bbbbbbbbbb.ccccc',
    ];
    for (const token of cases) {
      const findings = scanSecrets(`const t = "${token}";`);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.rule).toBe('api-token');
      expect(findings[0]?.snippet).not.toContain(token);
    }
  });

  it('flags an env-style secret assignment', () => {
    const findings = scanSecrets('export STRIPE_SECRET_KEY=pk_live_abcdef123456');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.rule).toBe('env-assignment');
    expect(findings[0]?.snippet).not.toContain('pk_live_abcdef123456');
  });

  it('suppresses obvious placeholders', () => {
    const samples = [
      'const k = "sk-your-key-here";',
      'API_KEY=<your-key>',
      'TOKEN=${TOKEN}',
      'PASSWORD=xxxxxxxxxxxx',
      'SECRET_KEY=examplekey123456',
      'const id = "AKIAIOSFODNN7EXAMPLE";',
    ];
    for (const sample of samples) {
      expect(scanSecrets(sample)).toEqual([]);
    }
  });

  it('reports the correct 1-based line number', () => {
    const text = [
      'const a = 1;',
      'const token = "sk-abcdefghij0123456789abcd";',
      'const b = 2;',
    ].join('\n');
    const findings = scanSecrets(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  it('masks the secret in the snippet, keeping the first 4 chars', () => {
    const secret = 'sk-abcdefghij0123456789abcd';
    const findings = scanSecrets(`token = "${secret}"`);
    expect(findings).toHaveLength(1);
    const snippet = findings[0]?.snippet ?? '';
    expect(snippet).not.toContain(secret);
    expect(snippet).toContain('sk-a…');
    expect(snippet.length).toBeLessThanOrEqual(72);
  });

  it('caps findings at 20', () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      lines.push(`key${i} = AKIA${String(1000000000000000 + i)}`);
    }
    const findings = scanSecrets(lines.join('\n'));
    expect(findings).toHaveLength(20);
  });

  it('returns no findings for clean code', () => {
    expect(scanSecrets('const x = 1;\nfunction add(a, b) { return a + b; }\n')).toEqual([]);
  });
});
