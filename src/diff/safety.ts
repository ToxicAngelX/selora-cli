/**
 * src/diff/safety.ts — the SAFETY module of the diff subsystem: the last
 * checkpoint between "the model wants to write this" and bytes on disk.
 * Everything the engine/history modules do is reversible bookkeeping; this
 * module is where irreversible I/O happens, so every operation here is
 * built around one rule: fail honestly, never halfway.
 *
 * What lives here:
 *  - guardPath: containment of an absolute path inside the project root,
 *    checked on the REALPATH-resolved path — `..` climbs and symlinks that
 *    point outside the root are refused with OUTSIDE_ROOT rather than
 *    followed out. It wraps the tool sandbox (agent/paths.ts
 *    resolveToolPath) so the diff subsystem enforces exactly the same
 *    boundary the read/write tools do, including the not-yet-existing-file
 *    case (deepest existing ancestor is resolved, the rest re-appended).
 *  - readSnapshot / SnapshotTracker: read-before-write conflict detection.
 *    A snapshot is taken when the agent reads a file; before the write the
 *    file is re-read and CONTENT-compared (sizes/mtimes are only a fast
 *    path on paper — mtime granularity lies, so the comparison is the
 *    honest one). An overwrite of a file the session never read earns one
 *    honest conflict message instead of silent destruction.
 *  - atomicWriteFile: tmp-file-then-rename in the SAME directory (rename is
 *    atomic only within one filesystem), fsync before rename so a crash
 *    mid-write never leaves a truncated target. Existing files keep their
 *    permission bits; win32-style EBUSY/EPERM/ENOENT rename races retry
 *    briefly and fall back to copy+remove. The tmp file is never left
 *    behind, whatever fails.
 *  - detectEolOf / scanSecrets: line-ending sniffing (so a written file
 *    keeps the EOL style it had) and a last-ditch secret scanner for ADDED
 *    lines. The scanner is a warning surface, not a guarantee: known token
 *    shapes (private-key banners, AWS/GitHub/GitLab/Slack/Google/JWT
 *    tokens, *_KEY=*_TOKEN= env assignments) are reported with the secret
 *    masked, and obvious placeholders are suppressed so the signal stays
 *    worth reading.
 *
 * Nothing here throws across the module boundary: fallible operations
 * return SafeResult<T> with a typed DiffErrorCode, and errno codes are
 * mapped (ENOENT/EACCES/EPERM/EISDIR/EBUSY/ENOSPC/EROFS) rather than
 * stringified into oblivion.
 */

import {
  chmodSync,
  closeSync,
  copyFileSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { resolveToolPath } from '../agent/paths.js';
import type {
  DiffError,
  DiffErrorCode,
  EolStyle,
  FileSnapshot,
  SafeResult,
  SecretFinding,
} from './types.js';

// ---------------------------------------------------------------------------
// path guard
// ---------------------------------------------------------------------------

/**
 * Verify that `abs` (untrusted, model-produced) stays inside `root` once
 * every symlink on the way is resolved. Returns the realpath-resolved
 * absolute path on success — callers write to THAT path, never to the
 * raw input, so a swapped symlink cannot redirect the write after the check.
 */
export function guardPath(root: string, abs: string): SafeResult<string> {
  const res = resolveToolPath(root, abs);
  if (!res.ok) {
    const outside = res.error.includes('escapes') || res.error.includes('outside');
    return {
      ok: false,
      error: {
        code: outside ? 'OUTSIDE_ROOT' : 'OTHER',
        message: res.error,
        path: abs,
      },
    };
  }
  return { ok: true, value: res.abs };
}

// ---------------------------------------------------------------------------
// snapshots + conflict detection
// ---------------------------------------------------------------------------

/**
 * Read `abs` into a point-in-time snapshot (content, mtime, permission
 * bits, EOL style, trailing-newline flag). Returns undefined on any error —
 * missing, unreadable, a directory — and never throws.
 */
export function readSnapshot(abs: string): FileSnapshot | undefined {
  try {
    const text = readFileSync(abs, 'utf8');
    const st = statSync(abs);
    return {
      text,
      mtimeMs: st.mtimeMs,
      mode: st.mode & 0o777,
      eol: detectEolOf(text),
      endsWithNewline: text.length > 0 && text.endsWith('\n'),
    };
  } catch {
    return undefined;
  }
}

/**
 * Session-scoped record of what the agent has read, for conflict detection
 * at write time. note() when the agent reads a file; check() before the
 * write lands. The comparison is CONTENT-based: filesystem mtime
 * granularity (and the odd same-mtime rewrite) makes stat-only checks lie,
 * and the cost of one re-read is nothing next to a silent clobber.
 */
export class SnapshotTracker {
  private readonly snapshots = new Map<string, FileSnapshot>();

  /** Snapshot `abs` now; a no-op when the file is missing or unreadable. */
  note(abs: string): void {
    const snap = readSnapshot(abs);
    if (snap !== undefined) this.snapshots.set(abs, snap);
  }

  /**
   * Whether writing `abs` right now would clobber something this session
   * did not see. Conflict when a noted file changed (or vanished) since the
   * note, or when the target exists, is non-empty, and was never read —
   * that last case is the one honest warning an overwrite-by-accident gets.
   */
  check(abs: string): { conflict: false } | { conflict: true; message: string } {
    const noted = this.snapshots.get(abs);
    const current = readSnapshot(abs);
    if (noted !== undefined) {
      if (current === undefined) {
        return {
          conflict: true,
          message: `file was deleted or became unreadable since it was read: ${abs}`,
        };
      }
      if (current.text !== noted.text) {
        return {
          conflict: true,
          message: `file changed on disk since it was read this session: ${abs}`,
        };
      }
      return { conflict: false };
    }
    if (current !== undefined && current.text.length > 0) {
      return {
        conflict: true,
        message: 'file exists on disk and was never read this session',
      };
    }
    return { conflict: false };
  }
}

// ---------------------------------------------------------------------------
// atomic writes
// ---------------------------------------------------------------------------

/** errno codes that map one-to-one onto DiffErrorCode. */
const ERRNO_CODES: Readonly<Record<string, DiffErrorCode>> = {
  ENOENT: 'ENOENT',
  EACCES: 'EACCES',
  EPERM: 'EPERM',
  EISDIR: 'EISDIR',
  EBUSY: 'EBUSY',
  ENOSPC: 'ENOSPC',
  EROFS: 'EROFS',
};

function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function toDiffError(err: unknown, path: string): DiffError {
  const message = err instanceof Error ? err.message : String(err);
  const raw = errnoCode(err);
  const code = raw !== undefined && Object.hasOwn(ERRNO_CODES, raw) ? ERRNO_CODES[raw] : undefined;
  return { code: code ?? 'OTHER', message, path };
}

/** Blocking sleep for the rename retry loop (Atomics.wait — no timer, no event loop). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename codes worth a retry: win32 locks and dir-creation races, never real refusals. */
function isRetryableRename(err: unknown): boolean {
  const code = errnoCode(err);
  return code === 'EBUSY' || code === 'EPERM' || code === 'ENOENT';
}

/**
 * renameSync with the win32 dance: a target held open by another process
 * (indexer, AV, editor) makes rename fail EBUSY/EPERM where POSIX would
 * succeed. Retry briefly, then fall back to copy+remove — not atomic, but
 * the only way through a lock, and still better than failing the write.
 */
function renameOver(tmp: string, abs: string): void {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      renameSync(tmp, abs);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRename(err)) throw err;
      if (attempt < 2) sleepSync(50);
    }
  }
  try {
    copyFileSync(tmp, abs);
    rmSync(tmp, { force: true });
  } catch {
    throw lastErr;
  }
}

/** Permission bits of the existing target, when there is one. */
function existingModeOf(abs: string): number | undefined {
  try {
    return statSync(abs).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` to `abs` atomically: a uniquely-named tmp file in the
 * SAME directory (rename is atomic only within one filesystem) is written,
 * fsynced, chmodded, then renamed over the target. Mode resolution:
 * opts.mode wins, else an existing target keeps its bits, else the umask
 * default (0o666 & ~umask via openSync) stands. On any failure the tmp
 * file is unlinked best-effort and the errno is mapped to a DiffErrorCode —
 * the target is never left half-written and the directory never litters.
 */
export function atomicWriteFile(
  abs: string,
  content: string,
  opts?: { mode?: number | undefined },
): SafeResult<{ bytes: number }> {
  const dir = dirname(abs);
  const tmp = join(dir, `.${basename(abs)}.selora-${randomUUID()}.tmp`);
  // A directory target is EISDIR on every platform — fail fast before the tmp
  // exists (win32's rename answers EPERM there, and retrying a directory is
  // pure noise).
  try {
    if (lstatSync(abs).isDirectory()) {
      return {
        ok: false,
        error: { code: 'EISDIR', message: `target is a directory: ${abs}`, path: abs },
      };
    }
  } catch {
    // absent target — the normal write path
  }
  let fd: number | undefined;
  try {
    fd = openSync(tmp, 'w');
    const buf = Buffer.from(content, 'utf8');
    let off = 0;
    while (off < buf.length) {
      off += writeSync(fd, buf, off, buf.length - off);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const mode = opts?.mode ?? existingModeOf(abs);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameOver(tmp, abs);
    return { ok: true, value: { bytes: buf.byteLength } };
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // best effort — the error below is the honest one
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // tmp may never have been created (openSync failed) — nothing to clean
    }
    return { ok: false, error: toDiffError(err, abs) };
  }
}

// ---------------------------------------------------------------------------
// EOL detection
// ---------------------------------------------------------------------------

/**
 * The dominant line terminator of `text`: 'crlf' when every terminator is
 * CRLF, 'lf' when every one is LF, 'mixed' when both appear, 'none' when
 * there are no terminators at all (empty or single-line files — nothing to
 * preserve yet).
 */
export function detectEolOf(text: string): EolStyle {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.replace(/\r\n/g, '').match(/\n/g) ?? []).length;
  if (crlf > 0 && lf > 0) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

// ---------------------------------------------------------------------------
// secret scanning
// ---------------------------------------------------------------------------

/** Findings cap — past this the output is noise, not signal. */
const MAX_SECRET_FINDINGS = 20;

/** Snippet length cap for one finding. */
const MAX_SNIPPET = 72;

interface SecretRule {
  id: string;
  re: RegExp;
  /** Extract the secret itself from a match (placeholder check + masking). */
  secret: (m: RegExpExecArray) => string;
}

const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'private-key',
    re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    secret: (m) => m[0],
  },
  {
    id: 'aws-access-key',
    re: /\bAKIA[0-9A-Z]{16}\b/,
    secret: (m) => m[0],
  },
  {
    id: 'aws-secret-key',
    re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*(\S{20,})/i,
    secret: (m) => m[1] ?? m[0],
  },
  {
    id: 'api-token',
    re: /\b(sk-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{20,}|xox[bapors]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{35}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,})/,
    secret: (m) => m[1] ?? m[0],
  },
  {
    id: 'env-assignment',
    re: /^\s*(?:export\s+)?[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*=\s*["']?(\S{8,})/,
    secret: (m) => m[1] ?? m[0],
  },
];

/**
 * Obvious placeholders are not secrets: documentation examples, template
 * markers, and runs of one repeated character. Checked against the
 * extracted value (quotes stripped), lowercase for the word checks.
 */
function looksLikePlaceholder(value: string): boolean {
  const stripped = value.replace(/^["']+|["']+$/g, '');
  const lower = stripped.toLowerCase();
  if (
    lower.includes('example') ||
    lower.includes('placeholder') ||
    lower.includes('changeme') ||
    lower.includes('your-')
  ) {
    return true;
  }
  if (stripped.includes('<') || stripped.includes('${') || stripped.includes('***')) return true;
  return stripped.length >= 8 && /^(.)\1+$/.test(stripped);
}

/**
 * The trimmed line with the secret masked to its first 4 characters + '…',
 * capped at MAX_SNIPPET. The full secret NEVER appears in a snippet — a
 * finding is a pointer for a human, not a copy of the credential.
 */
function maskSnippet(line: string, secret: string): string {
  const trimmed = line.trim();
  const idx = trimmed.indexOf(secret);
  const masked = `${secret.slice(0, 4)}…`;
  const shown =
    idx === -1 ? trimmed : trimmed.slice(0, idx) + masked + trimmed.slice(idx + secret.length);
  return shown.length > MAX_SNIPPET ? `${shown.slice(0, MAX_SNIPPET - 1)}…` : shown;
}

/**
 * Scan the NEW text of a change for secret-looking strings, line by line
 * (findings point at the added line the reviewer should look at). First
 * matching rule wins per line; placeholders are suppressed; the result is
 * capped at MAX_SECRET_FINDINGS.
 */
export function scanSecrets(newText: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = newText.split('\n');
  for (const [i, line] of lines.entries()) {
    if (findings.length >= MAX_SECRET_FINDINGS) break;
    for (const rule of SECRET_RULES) {
      const m = rule.re.exec(line);
      if (m === null) continue;
      const secret = rule.secret(m);
      if (looksLikePlaceholder(secret)) continue;
      findings.push({ rule: rule.id, line: i + 1, snippet: maskSnippet(line, secret) });
      break;
    }
  }
  return findings;
}
