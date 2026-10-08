import { describe, expect, it } from 'vitest';
import * as readline from 'node:readline';
import { PassThrough, Writable } from 'node:stream';
import { PromptRouter } from '../src/ui/promptmenu.js';
import { themeFor } from '../src/ui/theme.js';

describe('PromptRouter bracketed paste', () => {
  it('forwards multiline paste as text and submits only on the later Enter', () => {
    const stdin = new PassThrough();
    const wire = new PassThrough();
    const output = new Writable({ write(_chunk, _enc, cb) { cb(); } });
    const rl = readline.createInterface({ input: wire, output, terminal: true });
    rl.setPrompt('❯ ');
    const lines: string[] = [];
    rl.on('line', (line) => lines.push(line));
    const router = new PromptRouter({
      stdin,
      rl,
      wire,
      isPromptActive: () => true,
      slashCommands: () => [],
      cwd: process.cwd(),
      write: () => {},
      theme: () => themeFor('mono', false),
      cols: () => 100,
    });
    router.attach();
    stdin.write('\x1b[200~first\nsecond\x1b[201~');
    expect(rl.line).toContain('first');
    expect(rl.line).toContain('second');
    expect(lines).toEqual([]);
    stdin.write('\r');
    expect(lines).toEqual(['first⁣second']);
    router.detach();
    rl.close();
  });
});
