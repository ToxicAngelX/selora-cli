/**
 * Permission gate tests: the prompt box rendering, answer parsing (y/n/a/e,
 * safe defaults on empty/unknown/closed stdin), the [e]dit replacement flow,
 * the auto/denying askers, and the session-scoped auto-allow memory (read
 * tools key by name; write/exec key by tool + label — and it lives in memory
 * only).
 */

import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  createAutoAsker,
  createDenyingAsker,
  createInteractiveAsker,
  SessionAllows,
  type PermissionRequest,
} from '../src/agent/permissions.js';

function askerWith(lines: string[]): {
  ask(req: PermissionRequest): Promise<string>;
  replacement(current: string): Promise<string | null>;
  errLines: string[];
} {
  const errLines: string[] = [];
  const asker = createInteractiveAsker({
    stdin: Readable.from(lines.map((l) => `${l}\n`)),
    isTTY: false,
    err: (s) => {
      errLines.push(s);
    },
  });
  return {
    ask: (req) => asker.ask(req) as Promise<string>,
    replacement: (c) => asker.replacement(c),
    errLines,
  };
}

const readReq: PermissionRequest = { label: 'read_file(src/index.ts)', kind: 'read' };
const writeReq: PermissionRequest = {
  label: 'write_file(out.txt)',
  kind: 'write',
  preview: 'write out.txt — full content:\nhello world',
};

describe('interactive asker', () => {
  it('renders the box: label, preview lines, the question WITHOUT [e] for non-exec tools', async () => {
    const a = askerWith(['y']);
    const decision = await a.ask(writeReq);
    expect(decision).toBe('allow');
    expect(a.errLines).toEqual([
      '┌─ write_file(out.txt)',
      '│   write out.txt — full content:',
      '│   hello world',
      '└─ Allow? [y]es / [n]o / [a]lways this session',
    ]);
  });

  it('exec tools get the [e]dit option; answers parse y/a/n/e; unknown and empty deny', async () => {
    const execReq: PermissionRequest = { label: 'run_command(ls)', kind: 'exec', offerEdit: true };
    expect(await askerWith(['y']).ask(execReq)).toBe('allow');
    expect(await askerWith(['yes']).ask(execReq)).toBe('allow');
    expect(await askerWith(['a']).ask(execReq)).toBe('allow-session');
    expect(await askerWith(['always']).ask(execReq)).toBe('allow-session');
    expect(await askerWith(['e']).ask(execReq)).toBe('edit');
    expect(await askerWith(['n']).ask(execReq)).toBe('deny');
    expect(await askerWith(['nope']).ask(execReq)).toBe('deny');
    expect(await askerWith(['']).ask(execReq)).toBe('deny');
  });

  it('closed stdin denies with the honest gray note (safe default)', async () => {
    const a = askerWith([]); // no lines: stdin closes immediately
    const decision = await a.ask(readReq);
    expect(decision).toBe('deny');
    expect(a.errLines.some((l) => l.includes('treating as no'))).toBe(true);
  });

  it('the replacement prompt returns the trimmed line, null on empty or closed stdin', async () => {
    expect(await askerWith(['ls -la']).replacement('ls')).toBe('ls -la');
    expect(await askerWith(['']).replacement('ls')).toBeNull();
    expect(await askerWith([]).replacement('ls')).toBeNull();
    const a = askerWith(['git status']);
    await a.replacement('ls');
    expect(a.errLines).toContain('│   current: ls');
    expect(a.errLines).toContain('└─ Replacement command (empty line cancels):');
  });

  it('buffered answers: lines queued before the prompt are consumed in order', async () => {
    const a = askerWith(['y', 'n']);
    expect(await a.ask(readReq)).toBe('allow');
    expect(await a.ask(readReq)).toBe('deny');
  });
});

describe('non-interactive askers', () => {
  it('auto asker allows everything and never prompts for a replacement', async () => {
    const auto = createAutoAsker();
    expect(await auto.ask(writeReq)).toBe('allow');
    expect(await auto.replacement('ls')).toBeNull();
  });

  it('denying asker denies everything', async () => {
    const deny = createDenyingAsker();
    expect(await deny.ask(readReq)).toBe('deny');
    expect(await deny.replacement('ls')).toBeNull();
  });
});

describe('SessionAllows — memory-only auto-allows', () => {
  it('read tools: "always" covers the tool name for the session', () => {
    const s = new SessionAllows();
    expect(s.check('read', 'read_file', 'read_file(a)')).toBe(false);
    s.remember('read', 'read_file', 'read_file(a)');
    expect(s.check('read', 'read_file', 'read_file(anything)')).toBe(true);
    // a different read tool is NOT covered
    expect(s.check('read', 'grep', 'grep(x)')).toBe(false);
  });

  it('write/exec tools: "always" covers only that exact label', () => {
    const s = new SessionAllows();
    s.remember('write', 'write_file', 'write_file(out.txt)');
    expect(s.check('write', 'write_file', 'write_file(out.txt)')).toBe(true);
    expect(s.check('write', 'write_file', 'write_file(other.txt)')).toBe(false);
    expect(s.check('write', 'edit_file', 'edit_file(out.txt)')).toBe(false);
  });

  it('two instances share nothing (memory is per-loop, never persisted)', () => {
    const a = new SessionAllows();
    a.remember('read', 'read_file', 'read_file(x)');
    expect(new SessionAllows().check('read', 'read_file', 'read_file(x)')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// v0.3 menu primitives
// ---------------------------------------------------------------------------

import { menuOptions, parseMenuKey, renderMenu, plainMenuStyle } from '../src/agent/permissions';

describe('permission menu primitives', () => {
  it('parseMenuKey: arrows, enter, shortcuts, escape (Ctrl+C/Esc/q)', () => {
    expect(parseMenuKey('\x1b[A')).toBe('up');
    expect(parseMenuKey('\x1bOA')).toBe('up');
    expect(parseMenuKey('\x1b[B')).toBe('down');
    expect(parseMenuKey('k')).toBe('up');
    expect(parseMenuKey('j')).toBe('down');
    expect(parseMenuKey('\r')).toBe('enter');
    expect(parseMenuKey('\n')).toBe('enter');
    expect(parseMenuKey('y')).toBe('y');
    expect(parseMenuKey('A')).toBe('a');
    expect(parseMenuKey('N')).toBe('n');
    expect(parseMenuKey('e')).toBe('e');
    expect(parseMenuKey('\x03')).toBe('escape'); // Ctrl+C
    expect(parseMenuKey('\x1b')).toBe('escape');
    expect(parseMenuKey('q')).toBe('escape');
    expect(parseMenuKey('x')).toBe('other');
    expect(parseMenuKey('')).toBe('other');
  });

  it('menuOptions: edit offered for exec; always dropped for neverAutoAllow tools', () => {
    expect(menuOptions(false, false)).toEqual(['Yes', 'Yes, always this session', 'No']);
    expect(menuOptions(true, false)).toEqual(['Yes', 'Yes, always this session', 'No', 'Edit command']);
    expect(menuOptions(false, true)).toEqual(['Yes', 'No']);
    expect(menuOptions(true, true)).toEqual(['Yes', 'No', 'Edit command']);
  });

  it('renderMenu marks exactly the selected option with the ❯ marker', () => {
    const style = plainMenuStyle();
    const opts = menuOptions(false, false);
    const lines = renderMenu(opts, 1, style);
    expect(lines[0]).toBe('  Yes');
    expect(lines[1]).toBe('❯ Yes, always this session');
    expect(lines[2]).toBe('  No');
    expect(renderMenu(opts, 0, style)[0]).toBe('❯ Yes');
  });
});
