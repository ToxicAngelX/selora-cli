/**
 * Filesystem management tool tests: list_dir, create_dir, move, copy,
 * remove — every operation is REAL and runs in hermetic temp roots
 * (mkdtemp + rm in finally; roots are realpathed because macOS tmpdir is a
 * symlink). Plus the exported helpers: removeGuard (drive roots, home
 * itself, system folders — win32 simulated on POSIX via the injectable
 * platform) and folderStats. The trash tests set XDG_DATA_HOME to a temp
 * dir and run on Linux only (macOS trashes into ~/.Trash, win32 has no
 * shell-free trash — both would touch the real machine). Untrusted input
 * shapes feed wrong JSON and expect honest {ok:false} results, never a
 * crash.
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
import type { ToolContext } from '../src/agent/tool.js';
import {
  copyTool,
  createDirTool,
  folderStats,
  listDirTool,
  moveTool,
  removeGuard,
  removeTool,
} from '../src/agent/tools/fs.js';

/** Linux-only: the XDG trash assertions (other platforms trash elsewhere). */
const itLinux = process.platform === 'linux' ? it : it.skip;
/** POSIX-only: tool-level tests that path an absolute /etc through the tools. */
const itPosix = process.platform === 'win32' ? it.skip : it;

function tempRoot(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), 'selora-fs-tools-')));
}

function ctx(
  root: string,
  dryRun = false,
  outsideDirs?: readonly string[],
): ToolContext & { dryRun: boolean } {
  if (outsideDirs === undefined) return { cwd: root, dryRun };
  return { cwd: root, dryRun, outsideDirs };
}

// ---------------------------------------------------------------------------
// list_dir
// ---------------------------------------------------------------------------

describe('list_dir', () => {
  it('sorts directories first, then files, with sizes; default path is the root', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'zed'));
      mkdirSync(join(root, 'alpha'));
      writeFileSync(join(root, 'b.txt'), 'x'.repeat(2048), 'utf8');
      writeFileSync(join(root, 'a.txt'), '0123456789', 'utf8');
      const res = await listDirTool.run({}, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.content).toBe('alpha/\nzed/\na.txt (10 B)\nb.txt (2.0 KB)');
      expect(res.summary).toBe('listed 4 entries in .');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists a subdirectory and reports an empty directory honestly', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'sub'));
      writeFileSync(join(root, 'sub', 'only.txt'), 'x', 'utf8');
      const res = await listDirTool.run({ path: 'sub' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('listed 1 entries in sub');
      expect(res.content).toBe('only.txt (1 B)');
      mkdirSync(join(root, 'empty'));
      const empty = await listDirTool.run({ path: 'empty' }, ctx(root));
      expect(empty.content).toBe('(empty directory)');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps at 500 entries with an honest +N more note', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'many'));
      for (let i = 0; i < 501; i += 1) {
        writeFileSync(join(root, 'many', `f${String(i).padStart(3, '0')}.txt`), 'x', 'utf8');
      }
      const res = await listDirTool.run({ path: 'many' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('listed 501 entries in many');
      const lines = (res.content ?? '').split('\n');
      expect(lines.length).toBe(501);
      expect(lines[0]).toBe('f000.txt (1 B)');
      expect(lines[499]).toBe('f499.txt (1 B)');
      expect(lines[500]).toBe('… +1 more');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('missing directory / not a directory — honest failures', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'x', 'utf8');
      expect((await listDirTool.run({ path: 'nope' }, ctx(root))).summary).toContain(
        'no such directory: nope',
      );
      expect((await listDirTool.run({ path: 'a.txt' }, ctx(root))).summary).toContain(
        'not a directory: a.txt',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// create_dir
// ---------------------------------------------------------------------------

describe('create_dir', () => {
  it('dry-run describes the recursive create; the real run creates nested dirs', async () => {
    const root = tempRoot();
    try {
      const dry = await createDirTool.run({ path: 'deep/nested/dir' }, ctx(root, true));
      expect(dry.ok).toBe(true);
      expect(dry.summary).toBe('would create directory deep/nested/dir');
      expect(dry.preview).toContain(join(root, 'deep', 'nested', 'dir'));
      expect(dry.preview).toContain('recursive');
      expect(existsSync(join(root, 'deep'))).toBe(false);

      const res = await createDirTool.run({ path: 'deep/nested/dir' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('created deep/nested/dir');
      expect(existsSync(join(root, 'deep', 'nested', 'dir'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an existing directory is an ok no-op; a file in the way is an honest error', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'there'));
      const again = await createDirTool.run({ path: 'there' }, ctx(root));
      expect(again.ok).toBe(true);
      expect(again.summary).toContain('already exists');
      writeFileSync(join(root, 'file.txt'), 'x', 'utf8');
      const blocked = await createDirTool.run({ path: 'file.txt' }, ctx(root));
      expect(blocked.ok).toBe(false);
      expect(blocked.summary).toContain('a file already exists at file.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itPosix('refuses a system-folder target (the guard is shared with remove)', async () => {
    const root = tempRoot();
    try {
      const res = await createDirTool.run({ path: '/etc/agent-test' }, ctx(root, true, ['/etc']));
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('system folder');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// move / copy
// ---------------------------------------------------------------------------

describe('move', () => {
  it('moves a file to a fresh target (parents created), content preserved', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'data', 'utf8');
      const res = await moveTool.run({ from: 'a.txt', to: 'b/renamed.txt' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('moved a.txt → b/renamed.txt');
      expect(readFileSync(join(root, 'b', 'renamed.txt'), 'utf8')).toBe('data');
      expect(existsSync(join(root, 'a.txt'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('an existing directory target receives the source under its basename', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'dest'));
      writeFileSync(join(root, 'a.txt'), 'data', 'utf8');
      const res = await moveTool.run({ from: 'a.txt', to: 'dest' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('moved a.txt → dest/a.txt');
      expect(readFileSync(join(root, 'dest', 'a.txt'), 'utf8')).toBe('data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('moves a directory with its contents', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'srcdir'));
      writeFileSync(join(root, 'srcdir', 'inner.txt'), 'x', 'utf8');
      const res = await moveTool.run({ from: 'srcdir', to: 'moved' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(existsSync(join(root, 'moved', 'inner.txt'))).toBe(true);
      expect(existsSync(join(root, 'srcdir'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-run shows the resolved destination and moves nothing', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'data', 'utf8');
      const dry = await moveTool.run({ from: 'a.txt', to: 'b/c.txt' }, ctx(root, true));
      expect(dry.ok).toBe(true);
      expect(dry.summary).toBe('would move a.txt → b/c.txt');
      expect(dry.preview).toContain(join(root, 'b', 'c.txt'));
      expect(existsSync(join(root, 'a.txt'))).toBe(true);
      expect(existsSync(join(root, 'b'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses moving a directory into itself and an existing non-directory target', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'd', 'sub'), { recursive: true });
      const intoItself = await moveTool.run({ from: 'd', to: 'd/sub' }, ctx(root));
      expect(intoItself.ok).toBe(false);
      expect(intoItself.summary).toContain('into itself');
      const self = await moveTool.run({ from: 'd', to: 'd' }, ctx(root));
      expect(self.ok).toBe(false);
      expect(self.summary).toContain('into itself');

      writeFileSync(join(root, 'a.txt'), 'x', 'utf8');
      writeFileSync(join(root, 'b.txt'), 'y', 'utf8');
      const ontoFile = await moveTool.run({ from: 'a.txt', to: 'b.txt' }, ctx(root));
      expect(ontoFile.ok).toBe(false);
      expect(ontoFile.summary).toContain('not a directory');
      expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('y');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('copy', () => {
  it('copies a file — the source stays intact', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'a.txt'), 'data', 'utf8');
      const res = await copyTool.run({ from: 'a.txt', to: 'copy.txt' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toBe('copied a.txt → copy.txt');
      expect(readFileSync(join(root, 'copy.txt'), 'utf8')).toBe('data');
      expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('data');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('copies a directory recursively; an existing dir target receives it by basename', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'tree', 'inner'), { recursive: true });
      writeFileSync(join(root, 'tree', 'inner', 'f.txt'), 'x', 'utf8');
      writeFileSync(join(root, 'tree', 'top.txt'), 'y', 'utf8');
      const res = await copyTool.run({ from: 'tree', to: 'tree-copy' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(existsSync(join(root, 'tree-copy', 'inner', 'f.txt'))).toBe(true);
      expect(existsSync(join(root, 'tree-copy', 'top.txt'))).toBe(true);
      expect(existsSync(join(root, 'tree', 'inner', 'f.txt'))).toBe(true);

      // into-dir semantics: an existing directory target receives the source
      mkdirSync(join(root, 'dest'));
      const into = await copyTool.run({ from: 'tree', to: 'dest' }, ctx(root));
      expect(into.ok).toBe(true);
      expect(existsSync(join(root, 'dest', 'tree', 'inner', 'f.txt'))).toBe(true);
      expect(existsSync(join(root, 'dest', 'tree', 'top.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses copying a directory into itself and an existing non-directory target', async () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'd', 'sub'), { recursive: true });
      const intoItself = await copyTool.run({ from: 'd', to: 'd/sub' }, ctx(root));
      expect(intoItself.ok).toBe(false);
      expect(intoItself.summary).toContain('into itself');

      writeFileSync(join(root, 'a.txt'), 'x', 'utf8');
      writeFileSync(join(root, 'b.txt'), 'y', 'utf8');
      const ontoFile = await copyTool.run({ from: 'a.txt', to: 'b.txt' }, ctx(root));
      expect(ontoFile.ok).toBe(false);
      expect(ontoFile.summary).toContain('not a directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe('remove', () => {
  it('permanent mode deletes for real and says so plainly', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'note.txt'), 'gone', 'utf8');
      const res = await removeTool.run({ path: 'note.txt', mode: 'permanent' }, ctx(root));
      expect(res.ok).toBe(true);
      expect(res.summary).toContain('PERMANENT');
      expect(existsSync(join(root, 'note.txt'))).toBe(false);

      mkdirSync(join(root, 'dir'));
      writeFileSync(join(root, 'dir', 'f.txt'), 'x', 'utf8');
      const dir = await removeTool.run({ path: 'dir', mode: 'permanent' }, ctx(root));
      expect(dir.ok).toBe(true);
      expect(existsSync(join(root, 'dir'))).toBe(false);

      const missing = await removeTool.run({ path: 'note.txt' }, ctx(root));
      expect(missing.ok).toBe(false);
      expect(missing.summary).toContain('no such file or directory');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itLinux(
    'trash mode lands the file in XDG Trash/files with a .trashinfo in Trash/info',
    async () => {
      const root = tempRoot();
      const xdg = join(root, 'xdg');
      mkdirSync(xdg);
      const prev = process.env['XDG_DATA_HOME'];
      process.env['XDG_DATA_HOME'] = xdg;
      try {
        writeFileSync(join(root, 'note.txt'), 'gone', 'utf8');
        const res = await removeTool.run({ path: 'note.txt' }, ctx(root));
        expect(res.ok).toBe(true);
        expect(res.summary).toContain('moved to trash');
        expect(existsSync(join(root, 'note.txt'))).toBe(false);
        expect(existsSync(join(xdg, 'Trash', 'files', 'note.txt'))).toBe(true);
        expect(readFileSync(join(xdg, 'Trash', 'files', 'note.txt'), 'utf8')).toBe('gone');
        const info = join(xdg, 'Trash', 'info', 'note.txt.trashinfo');
        expect(existsSync(info)).toBe(true);
        const text = readFileSync(info, 'utf8');
        expect(text).toContain(`Path=${join(root, 'note.txt')}`);
        expect(text).toContain('DeletionDate=');
      } finally {
        if (prev === undefined) delete process.env['XDG_DATA_HOME'];
        else process.env['XDG_DATA_HOME'] = prev;
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  itLinux('same-name trash collisions get " 2", " 3" suffixes', async () => {
    const root = tempRoot();
    const xdg = join(root, 'xdg');
    mkdirSync(xdg);
    const prev = process.env['XDG_DATA_HOME'];
    process.env['XDG_DATA_HOME'] = xdg;
    try {
      mkdirSync(join(root, 'one'));
      mkdirSync(join(root, 'two'));
      mkdirSync(join(root, 'three'));
      writeFileSync(join(root, 'one', 'dup.txt'), '1', 'utf8');
      writeFileSync(join(root, 'two', 'dup.txt'), '2', 'utf8');
      writeFileSync(join(root, 'three', 'dup.txt'), '3', 'utf8');
      for (const dir of ['one', 'two', 'three']) {
        const res = await removeTool.run({ path: `${dir}/dup.txt` }, ctx(root));
        expect(res.ok).toBe(true);
      }
      expect(existsSync(join(xdg, 'Trash', 'files', 'dup.txt'))).toBe(true);
      expect(existsSync(join(xdg, 'Trash', 'files', 'dup.txt 2'))).toBe(true);
      expect(existsSync(join(xdg, 'Trash', 'files', 'dup.txt 3'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['XDG_DATA_HOME'];
      else process.env['XDG_DATA_HOME'] = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  itLinux('dry-run preview: absolute path, item/byte stats, trash note', async () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'note.txt'), 'gone', 'utf8');
      const dry = await removeTool.run({ path: 'note.txt' }, ctx(root, true));
      expect(dry.ok).toBe(true);
      expect(dry.outside).toBeUndefined();
      expect(dry.preview).toContain(join(root, 'note.txt'));
      expect(dry.preview).toContain('1 item · 4 B');
      expect(dry.preview).toContain('moves to trash');
      expect(existsSync(join(root, 'note.txt'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  itPosix('a guarded path fails even in dry-run — no prompting, no claimed success', async () => {
    const root = tempRoot();
    try {
      // /etc is granted for the session, yet the guard still refuses it
      const res = await removeTool.run({ path: '/etc' }, ctx(root, true, ['/etc']));
      expect(res.ok).toBe(false);
      expect(res.summary).toContain('refus');
      expect(res.outside).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('neverAutoAllow is set — one remove approval never blankets the next', () => {
    expect(removeTool.neverAutoAllow).toBe(true);
    expect(createDirTool.neverAutoAllow ?? false).toBe(false);
    expect(moveTool.neverAutoAllow ?? false).toBe(false);
    expect(copyTool.neverAutoAllow ?? false).toBe(false);
    expect(listDirTool.neverAutoAllow ?? false).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// removeGuard + folderStats (the exported helpers)
// ---------------------------------------------------------------------------

describe('removeGuard', () => {
  // explicit platforms keep these hermetic on every host OS
  it('refuses drive roots: /, C:\\, D:, and UNC roots', () => {
    expect(removeGuard('/', { platform: 'linux' }).ok).toBe(false);
    expect(removeGuard('C:\\', { platform: 'win32' }).ok).toBe(false);
    expect(removeGuard('D:', { platform: 'win32' }).ok).toBe(false);
    expect(removeGuard('C:/', { platform: 'win32' }).ok).toBe(false);
    expect(removeGuard('\\\\server', { platform: 'win32' }).ok).toBe(false);
    expect(removeGuard('\\\\server\\share', { platform: 'win32' }).ok).toBe(false);
    // below a UNC root is NOT a root
    expect(removeGuard('\\\\server\\share\\work', { platform: 'win32' }).ok).toBe(true);
  });

  it('refuses the home directory itself (case-insensitive on win32) but not paths inside it', () => {
    expect(removeGuard('/users/ada', { home: '/users/ada', platform: 'linux' }).ok).toBe(false);
    expect(removeGuard('/users/ada/proj', { home: '/users/ada', platform: 'linux' }).ok).toBe(true);
    expect(removeGuard('C:\\Users\\Ada', { home: 'C:\\users\\ada', platform: 'win32' }).ok).toBe(
      false,
    );
    expect(
      removeGuard('C:\\Users\\Ada\\proj', { home: 'C:\\users\\ada', platform: 'win32' }).ok,
    ).toBe(true);
  });

  it('refuses POSIX system folders and everything inside them', () => {
    for (const dir of [
      '/etc',
      '/usr',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/boot',
      '/dev',
      '/proc',
      '/sys',
      '/System',
    ]) {
      expect(removeGuard(dir, { platform: 'linux' }).ok).toBe(false);
      expect(removeGuard(`${dir}/sub`, { platform: 'linux' }).ok).toBe(false);
    }
    // a sibling sharing the prefix is fine — the separator is the boundary
    expect(removeGuard('/etcX', { platform: 'linux' }).ok).toBe(true);
    expect(removeGuard('/tmp/whatever', { platform: 'linux' }).ok).toBe(true);
  });

  it('refuses win32 system folders (simulated platform on POSIX hosts)', () => {
    for (const dir of [
      'C:\\Windows',
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\ProgramData',
      'C:\\System',
    ]) {
      expect(removeGuard(dir, { platform: 'win32' }).ok).toBe(false);
      expect(removeGuard(`${dir}\\sub`, { platform: 'win32' }).ok).toBe(false);
    }
    expect(removeGuard('C:\\Windows\\System32', { platform: 'win32' }).ok).toBe(false);
    expect(removeGuard('D:\\work\\project', { platform: 'win32' }).ok).toBe(true);
  });

  it('a normal project file passes', () => {
    const root = tempRoot();
    try {
      writeFileSync(join(root, 'f.txt'), 'x', 'utf8');
      expect(removeGuard(join(root, 'f.txt')).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('folderStats', () => {
  it('counts entries and file bytes across nested directories', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'stats', 'a'), { recursive: true });
      mkdirSync(join(root, 'stats', 'b'), { recursive: true });
      mkdirSync(join(root, 'stats', 'empty'), { recursive: true });
      writeFileSync(join(root, 'stats', 'a', 'f1'), '0123456789', 'utf8');
      writeFileSync(join(root, 'stats', 'b', 'f2'), 'x'.repeat(2048), 'utf8');
      const s = folderStats(join(root, 'stats'));
      expect(s.items).toBe(5); // 3 dirs + 2 files
      expect(s.bytes).toBe(2058);
      expect(s.truncated).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a plain directory with no files counts only its directories', () => {
    const root = tempRoot();
    try {
      mkdirSync(join(root, 'solo'), { recursive: true });
      const s = folderStats(join(root, 'solo'));
      expect(s.items).toBe(0);
      expect(s.bytes).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// outside-root access flow
// ---------------------------------------------------------------------------

describe('outside-root access flow', () => {
  it('dry run surfaces the outside path; ungranted real run refuses; a granted dir executes', async () => {
    const outer = tempRoot();
    try {
      const root = join(outer, 'proj');
      mkdirSync(root);
      const outside = join(outer, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'x.txt'), 'x', 'utf8');

      const dry = await listDirTool.run({ path: '../outside' }, ctx(root, true));
      expect(dry.ok).toBe(true);
      expect(dry.outside).toEqual({ abs: outside });
      expect(dry.preview).toContain('path outside the project root');
      expect(dry.preview).toContain(outside);
      expect(dry.summary).toContain('would access');
      expect(dry.content).toBeUndefined();

      const real = await listDirTool.run({ path: '../outside' }, ctx(root));
      expect(real.ok).toBe(false);
      expect(real.summary).toContain('outside the project root and access was not granted');

      const granted = await listDirTool.run({ path: '../outside' }, ctx(root, false, [outside]));
      expect(granted.ok).toBe(true);
      expect(granted.content).toContain('x.txt');

      // a prefix-sharing sibling of the granted dir is still outside
      mkdirSync(join(outer, 'outside-evil'));
      const sibling = await listDirTool.run(
        { path: '../outside-evil' },
        ctx(root, false, [outside]),
      );
      expect(sibling.ok).toBe(false);
      expect(sibling.summary).toContain('access was not granted');
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it('remove on an outside dir works once the dir is granted', async () => {
    const outer = tempRoot();
    try {
      const root = join(outer, 'proj');
      mkdirSync(root);
      const outside = join(outer, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'x.txt'), 'x', 'utf8');
      const res = await removeTool.run(
        { path: join(outside, 'x.txt'), mode: 'permanent' },
        ctx(root, false, [outside]),
      );
      expect(res.ok).toBe(true);
      expect(existsSync(join(outside, 'x.txt'))).toBe(false);
    } finally {
      rmSync(outer, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// untrusted input shapes
// ---------------------------------------------------------------------------

describe('untrusted input shapes', () => {
  it('every tool refuses wrong JSON honestly — never a crash', async () => {
    const root = tempRoot();
    try {
      expect((await listDirTool.run('x', ctx(root))).summary).toContain('input must be an object');
      expect((await listDirTool.run({ path: 42 }, ctx(root))).summary).toContain(
        'path must be a non-empty string',
      );
      expect((await listDirTool.run([], ctx(root))).summary).toContain('input must be an object');
      expect((await createDirTool.run({}, ctx(root))).summary).toContain(
        'missing required field "path"',
      );
      expect((await createDirTool.run({ path: '' }, ctx(root))).summary).toContain(
        'path must be a non-empty string',
      );
      expect((await moveTool.run({ from: 'a' }, ctx(root))).summary).toContain(
        'missing required field "to"',
      );
      expect((await moveTool.run({ from: 1, to: 'b' }, ctx(root))).summary).toContain(
        'from must be a non-empty string',
      );
      expect((await copyTool.run({ to: 'b' }, ctx(root))).summary).toContain(
        'missing required field "from"',
      );
      expect((await copyTool.run({ from: 'a', to: true }, ctx(root))).summary).toContain(
        'to must be a non-empty string',
      );
      expect((await removeTool.run({ path: null }, ctx(root))).summary).toContain(
        'path must be a non-empty string',
      );
      expect((await removeTool.run({ path: 'x', mode: 'shred' }, ctx(root))).summary).toContain(
        "mode must be 'trash' or 'permanent'",
      );
      expect((await removeTool.run(null, ctx(root))).summary).toContain('input must be an object');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('permission labels show the raw input paths', () => {
    expect(listDirTool.permissionLabel({ path: 'src' })).toBe('list_dir(src)');
    expect(listDirTool.permissionLabel({})).toBe('list_dir(<invalid path>)');
    expect(createDirTool.permissionLabel({ path: '~/Projects' })).toBe('create_dir(~/Projects)');
    expect(moveTool.permissionLabel({ from: 'a', to: 'b' })).toBe('move(a → b)');
    expect(removeTool.permissionLabel({ path: 'x'.repeat(80) })).toBe(`remove(${'x'.repeat(60)}…)`);
  });
});
