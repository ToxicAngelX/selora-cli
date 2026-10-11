import { describe, expect, it } from 'vitest';
import { buildProgram, renderBanner } from '../src/program.js';
import { main } from '../src/index.js';
import { VERSION } from '../src/version.js';
import { capturedIo, cleanup, freshEnv, type TempEnv } from './helpers/env.js';

let env: TempEnv;

function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[\d*(;\d*)*m/g, '');
}

describe('CLI Help & Banner Modernization', () => {
  describe('renderBanner', () => {
    it('renders the stylized header with version', () => {
      const banner = stripAnsi(renderBanner(80));
      expect(banner).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);
    });

    it('renders the ASCII block logo when width >= 60', () => {
      const banner = stripAnsi(renderBanner(80));
      expect(banner).toContain('██████');
      expect(banner).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);
    });

    it('renders compact header without block logo when width < 60', () => {
      const banner = stripAnsi(renderBanner(50));
      expect(banner).not.toContain('██████');
      expect(banner).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);
    });
  });

  describe('program help structure & sections', () => {
    it('organizes commands into the four distinct logical groups', () => {
      env = freshEnv();
      const { io } = capturedIo();
      const program = buildProgram(io);
      const help = stripAnsi(program.helpInformation());

      // Banner is included
      expect(help).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);

      // All 4 groups are present in order
      const idxCore = help.indexOf('⚡ Core & Agent:');
      const idxAccount = help.indexOf('👤 Account & Usage:');
      const idxConfig = help.indexOf('⚙ Configuration & Models:');
      const idxUtils = help.indexOf('🛠 Utilities:');

      expect(idxCore).toBeGreaterThan(-1);
      expect(idxAccount).toBeGreaterThan(idxCore);
      expect(idxConfig).toBeGreaterThan(idxAccount);
      expect(idxUtils).toBeGreaterThan(idxConfig);

      // Verify commands inside Core & Agent
      const coreSection = help.slice(idxCore, idxAccount);
      expect(coreSection).toContain('chat');
      expect(coreSection).toContain('run [prompt...]');
      expect(coreSection).toContain('resume [name]');
      expect(coreSection).toContain('sessions [action] [name]');

      // Verify commands inside Account & Usage
      const accountSection = help.slice(idxAccount, idxConfig);
      expect(accountSection).toContain('login');
      expect(accountSection).toContain('logout');
      expect(accountSection).toContain('whoami');
      expect(accountSection).toContain('balance');
      expect(accountSection).toContain('usage');

      // Verify commands inside Configuration & Models
      const configSection = help.slice(idxConfig, idxUtils);
      expect(configSection).toContain('models');
      expect(configSection).toContain('model [id]');
      expect(configSection).toContain('keys [action] [arg]');
      expect(configSection).toContain('theme [name]');
      expect(configSection).toContain('init');
      expect(configSection).toContain('trust [action] [dir]');

      // Verify commands inside Utilities
      const utilsSection = help.slice(idxUtils);
      expect(utilsSection).toContain('completion [shell]');
      expect(utilsSection).toContain('update');

      // Clean command names without repeated [options]
      expect(coreSection).not.toContain('chat [options]');

      // No redundant implicit Commands: section
      expect(help).not.toContain('\nCommands:\n');

      cleanup(env.dir);
    });

    it('subcommand help does not display root banner', () => {
      env = freshEnv();
      const { io } = capturedIo();
      const program = buildProgram(io);
      const chatCmd = program.commands.find((c) => c.name() === 'chat')!;
      const chatHelp = stripAnsi(chatCmd.helpInformation());

      expect(chatHelp).not.toContain('✦ SELORA');
      expect(chatHelp).toContain('Usage: selora chat [options]');
      expect(chatHelp).toContain('--model <id>');
      expect(chatHelp).toContain('--safe');

      cleanup(env.dir);
    });
  });

  describe('main entry point help behavior', () => {
    it('renders modern help with banner when argv is empty (argv.length === 0)', async () => {
      env = freshEnv();
      const { io, cap } = capturedIo();

      await main([], io);

      const output = stripAnsi(cap.outText());
      expect(output).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);
      expect(output).toContain('⚡ Core & Agent:');
      expect(output).toContain('👤 Account & Usage:');
      expect(output).toContain('⚙ Configuration & Models:');
      expect(output).toContain('🛠 Utilities:');
      expect(process.exitCode).toBeFalsy();

      cleanup(env.dir);
    });

    it('renders modern help when --help flag is passed', async () => {
      env = freshEnv();
      const { io, cap } = capturedIo();

      await main(['--help'], io);

      const output = stripAnsi(cap.outText());
      expect(output).toContain(`✦ SELORA [v${VERSION}] · AI Gateway & Agent CLI`);
      expect(output).toContain('⚡ Core & Agent:');
      expect(process.exitCode).toBe(0);

      cleanup(env.dir);
    });
  });
});
