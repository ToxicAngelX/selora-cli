/**
 * Built-in tool tests (files, exec, git, glob/grep) — every tool is REAL:
 * each test performs the actual filesystem/spawn/git operation in a temp
 * project root and asserts the honest result shape. Input validation feeds
 * untrusted model JSON (wrong shapes, missing fields, out-of-range values)
 * and expects {ok:false} with an exact message, never a crash.
 * git tests need a real repo (git via spawn args, GIT_* env is scoped).
 */

import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { editFileTool, readFileTool, writeFileTool } from '../src/agent/tools/files.js';
import { runCommandTool, tokenizeCommand } from '../src/agent/tools/exec.js';
import { globTool, grepTool } from '../src/agent/tools/search.js';
import {
  gitCommitTool,
  gitDiffTool,
  gitLogTool,
  gitRestoreTool,
  gitStatusTool,
} from '../src/agent/tools/git.js';
import type { ToolContext } from '../src/agent/tool.js';
import { projectConfigPath } from '../src/config/project.js';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'selora-tools-'));
}

function ctx(root: string, dryRun = false): ToolContext & { dryRun: boolean } {
  return { cwd: root, dryRun };
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe('read_file', () => {
  it('reads a real file: content payload, honest line/byte summary', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n', 'utf8');
      const res = await readFileTool.run({ path: 'a.txt' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.content).toBe('one\ntwo\nthree\n');
      expect(res.summary).toBe('read a.txt (3 lines, 14 B)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('default 200 lines: longer files are truncated with a count hint; max_lines is honored', async () => {
    const root = tempRoot();
    try {
      const text = Array.from({ length: 250 }, (_, i) => `line${i + 1}`).join('\n');
      writeFileSync(join(root, 'big.txt'), `${text}\n`, 'utf8');
      const res = await readFileTool.run({ path: 'big.txt' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('250 lines');
      expect(res.summary).toContain('truncated');
      expect(res.content).toContain('line200');
      expect(res.content).not.toContain('line201');
      expect(res.content).toContain('50 more lines');

      const res50 = await readFileTool.run({ path: 'big.txt', max_lines: 50 }, ctx(root));
      expect(res50.content).not.toContain('line51');
      expect(res50.content).toContain('200 more lines');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('missing file / directory / 256 KB refusal / exclude globs — honest failures', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'sub'), { recursive: true });
      expect((await readFileTool.run({ path: 'nope.txt' }, ctx(root))).summary).toContain(
        'no such file: nope.txt',
      );
      expect((await readFileTool.run({ path: 'sub' }, ctx(root))).summary).toContain(
        'not a file: sub',
      );
      writeFileSync(join(root, 'huge.txt'), 'x'.repeat(256 * 1024 + 1), 'utf8');
      const huge = await readFileTool.run({ path: 'huge.txt' }, ctx(root));
      expect(huge.ok).toBe(false);
      expect(huge.summary).toContain('over the 256.0 KB tool file limit');
      // the project's context.exclude is enforced
      writeFileSync(
        projectConfigPath(root),
        JSON.stringify({ context: { include: ['src/**'], exclude: ['secrets/**'] } }),
        'utf8',
      );
      mkdirSync(join(root, 'secrets'), { recursive: true });
      writeFileSync(join(root, 'secrets', 'k.txt'), 'x', 'utf8');
      const excl = await readFileTool.run({ path: 'secrets/k.txt' }, ctx(root));
      expect(excl.ok).toBe(false);
      expect(excl.summary).toContain('excluded by the project context globs');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('untrusted input shapes: non-object, missing path, bad max_lines/start_line, outside root', async () => {
    const root = tempRoot();
    try {
      expect((await readFileTool.run('a.txt', ctx(root))).summary).toContain(
        'input must be an object',
      );
      expect((await readFileTool.run({}, ctx(root))).summary).toContain(
        'missing required field "path"',
      );
      expect(
        (await readFileTool.run({ path: 'a.txt', max_lines: 0 }, ctx(root))).summary,
      ).toContain('max_lines must be an integer between 1 and 10000');
      expect(
        (await readFileTool.run({ path: 'a.txt', max_lines: 'ten' }, ctx(root))).summary,
      ).toContain('max_lines must be an integer between 1 and 10000');
      expect(
        (await readFileTool.run({ path: 'a.txt', start_line: 0 }, ctx(root))).summary,
      ).toContain('start_line must be an integer between 1 and 10000');
      // v0.3: an escape is no longer a hard refusal — it is an OUTSIDE path
      // that needs permission (dry run reports it; a real ungranted run fails).
      const esc = await readFileTool.run({ path: '../escape.txt' }, ctx(root, true));
      expect(esc.ok).toBe(true);
      expect(esc.outside).toEqual({ abs: expect.any(String) });
      expect(esc.preview).toContain('outside the project root');
      const escReal = await readFileTool.run({ path: '../escape.txt' }, ctx(root));
      expect(escReal.ok).toBe(false);
      expect(escReal.summary).toContain('outside the project root and access was not granted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('v0.3: start_line reads a range; an outside path granted via outsideDirs reads for real', async () => {
    const root = tempRoot();
    try {
      const text = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n');
      writeFileSync(join(root, 'r.txt'), `${text}\n`, 'utf8');
      const ranged = await readFileTool.run(
        { path: 'r.txt', start_line: 4, max_lines: 3 },
        ctx(root),
      );
      expect(ranged.ok).toBe(true);
      expect(ranged.content).toBe(
        'line4\nline5\nline6\n(… 4 more lines — pass max_lines to read more)',
      );
      expect(ranged.summary).toContain('lines 4-6 of 10');
      const past = await readFileTool.run({ path: 'r.txt', start_line: 11 }, ctx(root));
      expect(past.ok).toBe(false);
      expect(past.summary).toContain('start_line 11 is past the end');

      // outside: granted via ctx.outsideDirs (what an 'always' answer grants).
      // realpath: tmpdir may be a symlink (macOS) or a short name (Windows
      // runners) — the grant must match the resolved path exactly.
      const home = realpathSync(mkdtempSync(join(tmpdir(), 'selora-outside-')));
      try {
        mkdirSync(join(home, 'Desktop'), { recursive: true });
        writeFileSync(join(home, 'Desktop', 'n.txt'), 'far away\n', 'utf8');
        const granted = {
          cwd: root,
          dryRun: false,
          outsideDirs: [join(home, 'Desktop')],
        };
        const res = await readFileTool.run({ path: join(home, 'Desktop', 'n.txt') }, granted);
        expect(res.ok).toBe(true);
        expect(res.content).toBe('far away\n');
        expect(res.summary).toContain('read ');
        expect(res.summary).toContain('n.txt');
      } finally {
        rmSync(home, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe('write_file', () => {
  it('dry run describes the write and writes NOTHING; approval writes for real (dirs created)', async () => {
    const root = tempRoot();
    try {
      const dry = await writeFileTool.run(
        { path: 'src/new/mod.ts', content: 'export {}\n' },
        ctx(root, true),
      );
      expect(dry.ok).toBe(true);
      expect(dry.summary).toBe('would write src/new/mod.ts (10 B)');
      expect(dry.preview).toContain('write src/new/mod.ts — full content:');
      expect(dry.preview).toContain('export {}');
      expect(existsSync(join(root, 'src'))).toBe(false); // dry run created nothing

      const res = await writeFileTool.run(
        { path: 'src/new/mod.ts', content: 'export {}\n' },
        ctx(root),
      );
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('wrote src/new/mod.ts (10 B)');
      expect(readFileSync(join(root, 'src', 'new', 'mod.ts'), 'utf8')).toBe('export {}\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('overwrite preview says overwrite; a 256 KB+ content payload is refused; bad shapes', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'f.txt'), 'old', 'utf8');
      const dry = await writeFileTool.run({ path: 'f.txt', content: 'new' }, ctx(root, true));
      expect(dry.summary).toBe('would overwrite f.txt (3 B)');
      expect(dry.preview).toContain('overwrite f.txt');

      const huge = await writeFileTool.run(
        { path: 'f.txt', content: 'x'.repeat(256 * 1024 + 1) },
        ctx(root),
      );
      expect(huge.ok).toBe(false);
      expect(huge.summary).toContain('over the 256.0 KB tool limit');

      expect((await writeFileTool.run({ path: 'f.txt' }, ctx(root))).summary).toContain(
        'missing required field "content"',
      );
      expect((await writeFileTool.run({ content: 'x' }, ctx(root))).summary).toContain(
        'missing required field "path"',
      );
      expect(
        (await writeFileTool.run({ path: 'f.txt', content: 42 }, ctx(root))).summary,
      ).toContain('content must be a string');
      // v0.3: an escape is an outside path needing permission, not a refusal
      const esc = await writeFileTool.run({ path: '../out.txt', content: 'x' }, ctx(root, true));
      expect(esc.ok).toBe(true);
      expect(esc.outside).toEqual({ abs: expect.any(String) });
      const escReal = await writeFileTool.run({ path: '../out.txt', content: 'x' }, ctx(root));
      expect(escReal.ok).toBe(false);
      expect(escReal.summary).toContain('outside the project root and access was not granted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// edit_file
// ---------------------------------------------------------------------------

describe('edit_file', () => {
  it('replaces the FIRST occurrence only; preview shows find/replace with context', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'e.ts'), 'const a = 1;\nconst a = 2;\n', 'utf8');
      const dry = await editFileTool.run(
        { path: 'e.ts', find: 'const a = 1;', replace: 'const a = 42;' },
        ctx(root, true),
      );
      expect(dry.ok).toBe(true);
      expect(dry.summary).toBe('would replace 1 occurrence in e.ts');
      expect(dry.preview).toContain('replace:');
      expect(dry.preview).toContain('const a = 42;');
      // dry run changed nothing
      expect(readFileSync(join(root, 'e.ts'), 'utf8')).toContain('const a = 1;');

      const res = await editFileTool.run(
        { path: 'e.ts', find: 'const a = 1;', replace: 'const a = 42;' },
        ctx(root),
      );
      expect(res.ok).toBe(true);
      const after = readFileSync(join(root, 'e.ts'), 'utf8');
      expect(after).toBe('const a = 42;\nconst a = 2;\n'); // only the first one
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('find text not found → honest error naming the file; bad shapes refused', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'e.ts'), 'hello\n', 'utf8');
      const nf = await editFileTool.run({ path: 'e.ts', find: 'absent', replace: 'x' }, ctx(root));
      expect(nf.ok).toBe(false);
      expect(nf.summary).toContain('find text not found in e.ts (file has 2 lines)');
      expect(
        (await editFileTool.run({ path: 'e.ts', find: '', replace: 'x' }, ctx(root))).summary,
      ).toContain('find must not be empty');
      expect((await editFileTool.run({ path: 'e.ts', find: 'h' }, ctx(root))).summary).toContain(
        'missing required field "replace"',
      );
      expect(
        (await editFileTool.run({ path: 'nope.txt', find: 'a', replace: 'b' }, ctx(root))).summary,
      ).toContain('no such file: nope.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('v0.3: an AMBIGUOUS find is refused with the occurrence count; dry run carries the diff', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'amb.ts'), 'x = 1;\nx = 1;\n', 'utf8');
      const amb = await editFileTool.run(
        { path: 'amb.ts', find: 'x = 1;', replace: 'x = 2;' },
        ctx(root),
      );
      expect(amb.ok).toBe(false);
      expect(amb.summary).toContain('matches 2 times in amb.ts');
      expect(amb.summary).toContain('exactly once');
      // the file is untouched by the refusal
      expect(readFileSync(join(root, 'amb.ts'), 'utf8')).toBe('x = 1;\nx = 1;\n');

      // a unique edit's dry run carries before/after for the colored diff
      writeFileSync(join(root, 'u.ts'), 'one\ntwo\nthree\n', 'utf8');
      const dry = await editFileTool.run(
        { path: 'u.ts', find: 'two', replace: 'TWO' },
        ctx(root, true),
      );
      expect(dry.ok).toBe(true);
      expect(dry.diff).toEqual({ before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' });
      const real = await editFileTool.run({ path: 'u.ts', find: 'two', replace: 'TWO' }, ctx(root));
      expect(real.diff?.after).toBe('one\nTWO\nthree\n');
      expect(readFileSync(join(root, 'u.ts'), 'utf8')).toBe('one\nTWO\nthree\n');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------

describe('tokenizeCommand', () => {
  it('splits words, honors single and double quotes and backslash escapes', () => {
    expect(tokenizeCommand('echo hello world')).toEqual({
      ok: true,
      argv: ['echo', 'hello', 'world'],
    });
    expect(tokenizeCommand("echo 'two words'")).toEqual({ ok: true, argv: ['echo', 'two words'] });
    expect(tokenizeCommand('git commit -m "a message"')).toEqual({
      ok: true,
      argv: ['git', 'commit', '-m', 'a message'],
    });
    expect(tokenizeCommand('echo a\\ b')).toEqual({ ok: true, argv: ['echo', 'a b'] });
    expect(tokenizeCommand('  echo   x  ')).toEqual({ ok: true, argv: ['echo', 'x'] });
    expect(tokenizeCommand('')).toEqual({ ok: true, argv: [] });
  });

  it('unbalanced quotes are refused — no shell ever sees them', () => {
    expect(tokenizeCommand("echo 'oops")).toEqual({ ok: false, error: 'unbalanced single quote' });
    expect(tokenizeCommand('echo "oops')).toEqual({ ok: false, error: 'unbalanced double quote' });
  });

  it('shell metacharacters are LITERAL arguments (no shell is involved)', () => {
    const res = tokenizeCommand('echo a;rm -rf / && echo $(pwd)');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.argv).toEqual(['echo', 'a;rm', '-rf', '/', '&&', 'echo', '$(pwd)']);
  });
});

// These spawn real POSIX binaries (printf/ls/sleep) and assert no-shell behavior
// that only exists on POSIX. Windows has its own refusal tests below.
describe.skipIf(process.platform === 'win32')('run_command (POSIX)', () => {
  it('spawns argv directly: output captured as content, exit 0 is ok', async () => {
    const root = tempRoot();
    try {
      const res = await runCommandTool.run({ command: 'printf hello' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.content).toBe('hello');
      expect(res.summary).toBe('ran: printf hello (1 lines of output)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('runs in the project root (cwd) — metacharacters are literal, never shell', async () => {
    const root = tempRoot();
    try {
      // `pwd` proves the cwd; `echo a; touch pwned` proves no shell ran
      const res = await runCommandTool.run({ command: 'pwd' }, ctx(root));
      expect(res.ok).toBe(true);
      // macOS: cwd reports the realpath (/private/var/... vs /var/...); compare
      // resolved real paths, not literal strings.
      expect(realpathSync((res.content ?? '').trim())).toBe(realpathSync(root));
      const evil = await runCommandTool.run({ command: 'echo a; touch pwned' }, ctx(root));
      expect(evil.ok).toBe(true); // echo printed the literal argument...
      expect(evil.content).toContain('a; touch pwned');
      expect(existsSync(join(root, 'pwned'))).toBe(false); // ...and no file was created
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('non-zero exit is an honest failure carrying exit code + output to the model', async () => {
    const root = tempRoot();
    try {
      const res = await runCommandTool.run({ command: 'ls definitely-missing-dir' }, ctx(root));
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('command failed (exit code');
      expect(res.content).toContain('Command failed with exit code');
      expect(res.content).toContain('definitely-missing-dir');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('output is capped at 8 KB per stream, with an honest truncation note', async () => {
    const root = tempRoot();
    try {
      const res = await runCommandTool.run(
        { command: 'node -e \'process.stdout.write("x".repeat(9000))\'' },
        ctx(root),
      );
      expect(res.ok).toBe(true);
      // exactly 8192 payload bytes, then the honest truncation note
      expect(res.content!.indexOf('\n')).toBe(8192);
      expect(res.content).toContain('(… stdout truncated at 8 KB)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('timeout kills the process and reports it honestly', async () => {
    const root = tempRoot();
    try {
      const res = await runCommandTool.run({ command: 'sleep 30', timeout_ms: 1000 }, ctx(root));
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('timed out after 1s: sleep 30');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 10000);

  it('dry run describes without spawning; bad shapes and bad timeout refused', async () => {
    const root = tempRoot();
    try {
      const dry = await runCommandTool.run({ command: 'echo hi' }, ctx(root, true));
      expect(dry.ok).toBe(true);
      expect(dry.summary).toBe('would run: echo hi');
      expect(dry.preview).toContain('timeout: 60s');
      expect((await runCommandTool.run({}, ctx(root))).summary).toContain(
        'missing required field "command"',
      );
      expect((await runCommandTool.run({ command: '   ' }, ctx(root))).summary).toContain(
        'command must be a non-empty string',
      );
      expect(
        (await runCommandTool.run({ command: 'x', timeout_ms: 999999999 }, ctx(root))).summary,
      ).toContain('timeout_ms must be an integer between 1000 and 300000');
      // a command that cannot spawn (binary does not exist) is an honest failure
      const missing = await runCommandTool.run({ command: 'no-such-binary-xyz --v' }, ctx(root));
      expect(missing.ok).toBe(false);
      expect(missing.summary).toContain('cannot run no-such-binary-xyz');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// git tools (a real temp repo; GIT identity env is scoped to the spawns)
// ---------------------------------------------------------------------------

function gitRepo(): string {
  const root = tempRoot();
  runIn(root, ['init', '-q']);
  runIn(root, ['config', 'user.email', 'agent-test@example.invalid']);
  runIn(root, ['config', 'user.name', 'Agent Test']);
  writeFileSync(join(root, 'tracked.txt'), 'original\n', 'utf8');
  runIn(root, ['add', 'tracked.txt']);
  runIn(root, ['commit', '-q', '-m', 'initial']);
  return root;
}

function runIn(root: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd: root, shell: false, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
}

describe('git tools', () => {
  it('git_status: clean vs changed, dry-run describes, outside a repo fails honestly', async () => {
    const root = gitRepo();
    try {
      const clean = await gitStatusTool.run({}, ctx(root));
      expect(clean.ok).toBe(true);
      expect(clean.summary).toBe('git status: 0 changed paths');
      expect(clean.content).toMatch(/^## \S+$/); // the branch line — nothing else

      writeFileSync(join(root, 'tracked.txt'), 'modified\n', 'utf8');
      const dirty = await gitStatusTool.run({}, ctx(root));
      expect(dirty.summary).toBe('git status: 1 changed path');
      expect(dirty.content).toContain('## ');
      expect(dirty.content).toContain(' tracked.txt');

      const dry = await gitStatusTool.run({}, ctx(root, true));
      expect(dry.summary).toBe('would run: git status --short --branch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git_diff: unstaged and staged views, path filter, no changes', async () => {
    const root = gitRepo();
    try {
      const none = await gitDiffTool.run({}, ctx(root));
      expect(none.ok).toBe(true);
      expect(none.content).toBe('(no changes)');

      writeFileSync(join(root, 'tracked.txt'), 'changed line\n', 'utf8');
      const unstaged = await gitDiffTool.run({}, ctx(root));
      expect(unstaged.ok).toBe(true);
      expect(unstaged.content).toContain('-original');
      expect(unstaged.content).toContain('+changed line');

      runIn(root, ['add', 'tracked.txt']);
      const staged = await gitDiffTool.run({ staged: true }, ctx(root));
      expect(staged.summary).toContain('staged');
      expect(staged.content).toContain('+changed line');

      // unstaged diff of the fully staged file is empty now
      const pathFiltered = await gitDiffTool.run({ path: 'other.txt' }, ctx(root));
      expect(pathFiltered.content).toBe('(no changes)');
      expect((await gitDiffTool.run({ path: 42 }, ctx(root))).summary).toContain(
        'path must be a string when given',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git_log: commit count and limit validation', async () => {
    const root = gitRepo();
    try {
      const log = await gitLogTool.run({}, ctx(root));
      expect(log.ok).toBe(true);
      expect(log.summary).toBe('git log: 1 commit');
      expect(log.content).toContain('initial');
      expect((await gitLogTool.run({ limit: 0 }, ctx(root))).summary).toContain(
        'limit must be an integer between 1 and 100',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git_commit: stages the listed files and commits the message VERBATIM (arg, never shell)', async () => {
    const root = gitRepo();
    try {
      const dry = await gitCommitTool.run(
        { message: 'add new file', files: ['new.txt'] },
        ctx(root, true),
      );
      expect(dry.ok).toBe(true);
      expect(dry.preview).toContain('commit message:');
      expect(dry.preview).toContain('add new file');
      expect(dry.preview).toContain('files to stage: new.txt');

      // a message with shell metacharacters is committed as text, not executed
      writeFileSync(join(root, 'new.txt'), 'content\n', 'utf8');
      const res = await gitCommitTool.run(
        { message: 'evil; touch pwned", $(pwd)', files: ['new.txt'] },
        ctx(root),
      );
      expect(res.ok).toBe(true);
      const log = await gitLogTool.run({}, ctx(root));
      expect(log.content).toContain('evil; touch pwned", $(pwd)');
      expect(existsSync(join(root, 'pwned'))).toBe(false);
      expect((await gitCommitTool.run({ message: '' }, ctx(root))).summary).toContain(
        'message must be a non-empty string',
      );
      expect(
        (await gitCommitTool.run({ message: 'x', files: ['a', 42] }, ctx(root))).summary,
      ).toContain('files must be an array of non-empty path strings');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('git_restore: discards uncommitted changes to exactly one path', async () => {
    const root = gitRepo();
    try {
      writeFileSync(join(root, 'tracked.txt'), 'mangled\n', 'utf8');
      const res = await gitRestoreTool.run({ path: 'tracked.txt' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('restored tracked.txt (uncommitted changes discarded)');
      // Windows git checks out with CRLF (core.autocrlf) — normalize for compare
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe(
        'original\n',
      );
      expect((await gitRestoreTool.run({ path: '' }, ctx(root))).summary).toContain(
        'path must be a non-empty string',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('outside a repository every git tool fails honestly (no crash)', async () => {
    const root = tempRoot(); // plain dir, no .git
    try {
      const status = await gitStatusTool.run({}, ctx(root));
      expect(status.ok).toBe(false);
      expect(status.summary).toContain('git status failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// glob / grep tools
// ---------------------------------------------------------------------------

function searchTree(): string {
  const root = tempRoot();
  mkdirSync(join(root, 'src', 'agent'), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"name":"selora"}\n', 'utf8');
  writeFileSync(join(root, 'src', 'index.ts'), 'export const A = 1;\n', 'utf8');
  writeFileSync(join(root, 'src', 'agent.ts'), 'export const B = 2;\n', 'utf8');
  writeFileSync(join(root, 'src', 'agent', 'loop.ts'), 'export const C = 3;\n', 'utf8');
  writeFileSync(join(root, 'src', 'agent', 'notes.md'), '# notes\n', 'utf8');
  return root;
}

describe('glob tool', () => {
  it('finds files by pattern (recursive **), basename fallback, and none-matches honestly', async () => {
    const root = searchTree();
    try {
      const res = await globTool.run({ pattern: 'src/**/*.ts' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('3 files match src/**/*.ts');
      expect(res.content).toContain('src/index.ts');
      expect(res.content).toContain('src/agent/loop.ts');
      expect(res.content).not.toContain('notes.md');

      const base = await globTool.run({ pattern: '*.json' }, ctx(root));
      expect(base.content).toContain('package.json');

      const none = await globTool.run({ pattern: 'nope/**/*.xyz' }, ctx(root));
      expect(none.content).toBe('(no files match nope/**/*.xyz)');

      const dry = await globTool.run({ pattern: '*.ts' }, ctx(root, true));
      expect(dry.summary).toBe('would find files matching *.ts under .');
      expect((await globTool.run({}, ctx(root))).summary).toContain(
        'pattern must be a non-empty string',
      );
      expect((await globTool.run({ pattern: 'x', path: '../out' }, ctx(root))).summary).toContain(
        'escapes the project root',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('the shipped default excludes are enforced: node_modules and dist are never walked', async () => {
    const root = searchTree();
    try {
      mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
      writeFileSync(join(root, 'node_modules', 'dep', 'x.ts'), 'export {}\n', 'utf8');
      const res = await globTool.run({ pattern: '**/*.ts' }, ctx(root));
      expect(res.content).not.toContain('node_modules');
      const grep = await grepTool.run({ pattern: 'export' }, ctx(root));
      expect(grep.content).not.toContain('node_modules');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('grep tool', () => {
  it('searches contents line-by-line as path:line:text, with glob filter and path scoping', async () => {
    const root = searchTree();
    try {
      const res = await grepTool.run({ pattern: 'export const' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('3 matches in 5 files');
      expect(res.content).toContain('src/index.ts:1:export const A = 1;');
      expect(res.content).toContain('src/agent/loop.ts:1:export const C = 3;');

      const onlyTs = await grepTool.run({ pattern: 'export', glob: '*.ts' }, ctx(root));
      expect(onlyTs.content).not.toContain('notes.md');

      const scoped = await grepTool.run({ pattern: 'notes', path: 'src/agent' }, ctx(root));
      expect(scoped.content).toContain('src/agent/notes.md:1:');

      const none = await grepTool.run({ pattern: 'zzz-not-there' }, ctx(root));
      expect(none.content).toBe('(no matches for /zzz-not-there/)');

      const dry = await grepTool.run({ pattern: 'x' }, ctx(root, true));
      expect(dry.summary).toBe('would grep for /x/ under .');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('invalid regex is an honest error; binary and >256 KB files are skipped and reported', async () => {
    const root = searchTree();
    try {
      const bad = await grepTool.run({ pattern: '(unclosed' }, ctx(root));
      expect(bad.ok).toBe(false);
      expect(bad.summary).toContain('grep: invalid regular expression');

      writeFileSync(join(root, 'blob.bin'), 'text\0binary\n', 'utf8');
      writeFileSync(join(root, 'large.txt'), `${'a'.repeat(200)}\n`.repeat(1400), 'utf8'); // ~281 KB
      const res = await grepTool.run({ pattern: 'a' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('1 binary file skipped');
      expect(res.summary).toContain('1 file over 256 KB skipped');
      expect(res.content).not.toContain('blob.bin');
      expect(res.content).not.toContain('large.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('match cap: 200 matches maximum, reported honestly; long lines truncate at 200 chars', async () => {
    const root = tempRoot();
    try {
      const lines = Array.from({ length: 250 }, (_, i) => `hit number ${i}`).join('\n');
      writeFileSync(join(root, 'many.txt'), lines, 'utf8');
      const res = await grepTool.run({ pattern: 'hit' }, ctx(root));
      expect(res.summary).toContain('200 matches');
      expect(res.summary).toContain('matches capped at 200');
      expect(res.content!.split('\n').filter((l) => l.includes(':')).length).toBe(200);

      writeFileSync(join(root, 'long.txt'), `${'y'.repeat(300)}needle\n`, 'utf8');
      const long = await grepTool.run({ pattern: 'needle' }, ctx(root));
      expect(long.content).toContain('…'); // the 300-char line was cut at 200
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
