/**
 * Completion tests. The scripts are generated from the REAL program instance
 * (buildProgram — the exact object main() parses against), so registration
 * drift breaks these tests loudly: every command and every option registered
 * on the program must appear in every generated script.
 */

import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/program.js';
import {
  generateBashCompletion,
  generateFishCompletion,
  generateZshCompletion,
  runCompletion,
  shellFromEnv,
  shellScript,
  SUPPORTED_SHELLS,
} from '../src/commands/completion.js';
import { capturedIo, freshEnv, cleanup, type TempEnv } from './helpers/env.js';
import type { CliContext } from '../src/context.js';

let env: TempEnv;

it('the program registers the completion command like any other', () => {
  env = freshEnv();
  const { io } = capturedIo();
  const program = buildProgram(io);
  expect(program.commands.map((c) => c.name())).toContain('completion');
  cleanup(env.dir);
});

for (const [name, generate] of [
  ['bash', generateBashCompletion],
  ['zsh', generateZshCompletion],
  ['fish', generateFishCompletion],
] as const) {
  describe(`completion script (${name})`, () => {
    it('contains every registered command and option — no drift', () => {
      env = freshEnv();
      const { io } = capturedIo();
      const program = buildProgram(io);
      const script = generate(program);

      // every subcommand name appears
      for (const cmd of program.commands) {
        expect(script).toContain(cmd.name());
      }
      // the keys sub-actions appear
      expect(script).toContain('list');
      expect(script).toContain('create');
      expect(script).toContain('revoke');

      // every option token of the root program and of every subcommand
      // (fish spells long flags as `-l <name>` without the leading dashes)
      const longName = (long: string): string => (name === 'fish' ? long.replace(/^--/, '') : long);
      const allCommands = [program, ...program.commands];
      for (const cmd of allCommands) {
        for (const opt of cmd.options) {
          if (opt.long !== undefined && opt.long !== '') {
            expect(script).toContain(longName(opt.long));
          }
        }
      }
      // the global flags, explicitly
      expect(script).toContain(longName('--debug'));
      expect(script).toContain(longName('--json'));
      expect(script).toContain(longName('--api-url'));

      // shell-specific anchors
      if (name === 'bash') expect(script).toContain('complete -F _selora selora');
      if (name === 'zsh') expect(script).toContain('#compdef selora');
      if (name === 'fish') expect(script).toContain('complete -c selora');
      cleanup(env.dir);
    });
  });
}

describe('shellFromEnv', () => {
  it('derives the shell from the basename of $SHELL', () => {
    expect(shellFromEnv({ SHELL: '/bin/bash' })).toBe('bash');
    expect(shellFromEnv({ SHELL: '/usr/bin/zsh' })).toBe('zsh');
    expect(shellFromEnv({ SHELL: '/usr/local/bin/fish' })).toBe('fish');
    expect(shellFromEnv({ SHELL: '/bin/sh' })).toBeUndefined();
    expect(shellFromEnv({})).toBeUndefined();
    expect(shellFromEnv({ SHELL: '' })).toBeUndefined();
  });
});

describe('runCompletion', () => {
  it('prints the script for an explicit shell argument', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: false, apiUrl: undefined, io };
    process.exitCode = undefined;
    await runCompletion(ctx, 'fish', program);
    expect(cap.out.join('\n')).toContain('complete -c selora');
    expect(process.exitCode).toBeUndefined();
    cleanup(env.dir);
  });

  it('defaults from $SHELL when the argument is omitted', async () => {
    env = freshEnv();
    process.env['SHELL'] = '/bin/bash';
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: false, apiUrl: undefined, io };
    await runCompletion(ctx, undefined, program);
    expect(cap.out.join('\n')).toContain('complete -F _selora selora');
    cleanup(env.dir);
  });

  it('an explicit argument overrides $SHELL', async () => {
    env = freshEnv();
    process.env['SHELL'] = '/bin/zsh';
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: false, apiUrl: undefined, io };
    await runCompletion(ctx, 'fish', program);
    expect(cap.out.join('\n')).toContain('complete -c selora');
    expect(cap.out.join('\n')).not.toContain('#compdef');
    cleanup(env.dir);
  });

  it('unknown shell: honest error, exit 1, no script', async () => {
    env = freshEnv();
    process.env['SHELL'] = '/bin/bash';
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: false, apiUrl: undefined, io };
    process.exitCode = undefined;
    await runCompletion(ctx, 'powershell', program);
    expect(cap.err.join('\n')).toContain('Unknown shell: powershell');
    expect(cap.out).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    cleanup(env.dir);
  });

  it('no argument and unhelpful $SHELL: usage with the three shells', async () => {
    env = freshEnv();
    delete process.env['SHELL'];
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: false, apiUrl: undefined, io };
    process.exitCode = undefined;
    await runCompletion(ctx, undefined, program);
    const text = cap.err.join('\n');
    expect(text).toContain('Usage: selora completion <bash|zsh|fish>');
    expect(cap.out).toHaveLength(0);
    expect(process.exitCode).toBe(1);
    cleanup(env.dir);
  });

  it('--json wraps the script in a machine-readable object', async () => {
    env = freshEnv();
    const { io, cap } = capturedIo();
    const program = buildProgram(io);
    const ctx: CliContext = { debug: false, json: true, apiUrl: undefined, io };
    await runCompletion(ctx, 'bash', program);
    const parsed = JSON.parse(cap.out.join('\n')) as { ok: boolean; shell: string; script: string };
    expect(parsed.ok).toBe(true);
    expect(parsed.shell).toBe('bash');
    expect(parsed.script).toContain('complete -F _selora selora');
    cleanup(env.dir);
  });
});

describe('shellScript', () => {
  it('supports exactly bash, zsh, fish', () => {
    env = freshEnv();
    const { io } = capturedIo();
    const program = buildProgram(io);
    expect(SUPPORTED_SHELLS).toEqual(['bash', 'zsh', 'fish']);
    for (const shell of SUPPORTED_SHELLS) {
      expect(shellScript(shell, program)).not.toBe('');
    }
    cleanup(env.dir);
  });
});
