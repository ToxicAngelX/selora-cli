import { describe, expect, it } from 'vitest';
import stringWidth from 'string-width';
import {
  renderBox,
  step,
  renderStep,
  renderSteps,
  renderBadge,
  renderTable,
  renderCard,
  STEP_COLORS,
} from '../src/ui/components.js';
import { GALAXY_PALETTE, MONO_PALETTE, Theme } from '../src/ui/theme.js';

describe('UI Component Toolkit', () => {
  const colorTheme = new Theme(GALAXY_PALETTE, 3);
  const monoTheme = new Theme(MONO_PALETTE, 3);
  const noColorTheme = new Theme(GALAXY_PALETTE, 0);

  describe('1. Rounded Unicode Box Builder (renderBox)', () => {
    it('renders a basic rounded box with consistent line widths', () => {
      const box = renderBox({
        content: ['Hello World', 'Secondary line of text'],
        theme: noColorTheme,
      });

      const lines = box.split('\n');
      expect(lines.length).toBe(4);
      expect(lines[0]!.startsWith('╭')).toBe(true);
      expect(lines[0]!.endsWith('╮')).toBe(true);
      expect(lines[3]!.startsWith('╰')).toBe(true);
      expect(lines[3]!.endsWith('╯')).toBe(true);

      // Verify every line has the exact same visual cell width
      const firstLineWidth = stringWidth(lines[0]!);
      for (const line of lines) {
        expect(stringWidth(line)).toBe(firstLineWidth);
      }
    });

    it('embeds title into top border without distorting width', () => {
      const box = renderBox({
        title: 'Status',
        content: 'System normal',
        theme: noColorTheme,
      });

      const lines = box.split('\n');
      expect(lines[0]).toMatch(/^╭─ Status ─+╮$/);
      const expectedWidth = stringWidth(lines[0]!);
      for (const line of lines) {
        expect(stringWidth(line)).toBe(expectedWidth);
      }
    });

    it('handles content with ANSI escape sequences without misaligning borders', () => {
      const ansiLine = colorTheme.cyan('Bright Cyan Text') + ' and normal text';
      const box = renderBox({
        title: colorTheme.bold('ANSI Box'),
        content: [ansiLine, 'Plain text line'],
        theme: colorTheme,
      });

      const lines = box.split('\n');
      const expectedWidth = stringWidth(lines[0]!);
      for (const line of lines) {
        expect(stringWidth(line)).toBe(expectedWidth);
      }
    });

    it('supports border styles: rounded, single, double, dim, hairline', () => {
      const rounded = renderBox({ content: 'Test', borderStyle: 'rounded', theme: noColorTheme });
      expect(rounded).toContain('╭');
      expect(rounded).toContain('╯');

      const single = renderBox({ content: 'Test', borderStyle: 'single', theme: noColorTheme });
      expect(single).toContain('┌');
      expect(single).toContain('┘');

      const double = renderBox({ content: 'Test', borderStyle: 'double', theme: noColorTheme });
      expect(double).toContain('╔');
      expect(double).toContain('╝');

      const dim = renderBox({ content: 'Test', borderStyle: 'dim', theme: noColorTheme });
      expect(dim).toContain('╭');

      const hairline = renderBox({ content: 'Test', borderStyle: 'hairline', theme: noColorTheme });
      expect(hairline).toContain('┌');
    });

    it('supports custom minWidth and padding', () => {
      const box = renderBox({
        content: 'Hi',
        minWidth: 20,
        padding: 2,
        theme: noColorTheme,
      });

      const lines = box.split('\n');
      for (const line of lines) {
        expect(stringWidth(line)).toBe(20);
      }
      expect(lines[1]).toBe('│  Hi              │');
    });

    it('splits multiline strings within content array or string', () => {
      const box = renderBox({
        content: 'Line 1\nLine 2\r\nLine 3',
        theme: noColorTheme,
      });

      const lines = box.split('\n');
      expect(lines.length).toBe(5); // top, 3 content, bottom
    });

    it('respects NO_COLOR / level 0 — no escape sequences produced', () => {
      const box = renderBox({
        title: 'Title',
        content: ['Row 1', 'Row 2'],
        borderColor: '#22d3ee',
        theme: noColorTheme,
      });

      expect(box).not.toContain('\x1b[');
    });

    it('respects mono theme — no escape sequences produced', () => {
      const box = renderBox({
        title: 'Title',
        content: ['Row 1', 'Row 2'],
        borderColor: '#22d3ee',
        theme: monoTheme,
      });

      expect(box).not.toContain('\x1b[');
    });
  });

  describe('2. Kinetic Step Indicators (step / renderStep / renderSteps)', () => {
    it('formats all 4 statuses with their respective icons', () => {
      const done = step('done', 'Finished', undefined, noColorTheme);
      expect(done).toBe('✔ Finished');

      const running = step('running', 'Processing', undefined, noColorTheme);
      expect(running).toBe('⏳ Processing');

      const failed = step('failed', 'Error occurred', undefined, noColorTheme);
      expect(failed).toBe('✖ Error occurred');

      const pending = step('pending', 'Queued', undefined, noColorTheme);
      expect(pending).toBe('✦ Queued');
    });

    it('formats details when present', () => {
      const doneWithDetail = step('done', 'Build completed', 'in 1.2s', noColorTheme);
      expect(doneWithDetail).toBe('✔ Build completed in 1.2s');
    });

    it('colors icons appropriately when theme is enabled', () => {
      const done = step('done', 'Done', undefined, colorTheme);
      // Mint green checkmark
      expect(done).toContain(colorTheme.wrap(STEP_COLORS.done, '✔'));

      const running = step('running', 'Run', undefined, colorTheme);
      // Electric cyan hourglass
      expect(running).toContain(colorTheme.wrap(STEP_COLORS.running, '⏳'));

      const failed = step('failed', 'Fail', undefined, colorTheme);
      // Coral red cross
      expect(failed).toContain(colorTheme.wrap(STEP_COLORS.failed, '✖'));

      const pending = step('pending', 'Wait', undefined, colorTheme);
      // Slate gray star
      expect(pending).toContain(colorTheme.wrap(STEP_COLORS.pending, '✦'));
    });

    it('supports custom spinnerFrame and pendingChar in options object', () => {
      const runningCustom = step({
        status: 'running',
        label: 'Spinning',
        spinnerFrame: '⠋',
        theme: noColorTheme,
      });
      expect(runningCustom).toBe('⠋ Spinning');

      const pendingCustom = step({
        status: 'pending',
        label: 'Dot pending',
        pendingChar: '·',
        theme: noColorTheme,
      });
      expect(pendingCustom).toBe('· Dot pending');
    });

    it('renderSteps formats multi-step task list', () => {
      const steps = renderSteps(
        [
          { status: 'done', label: 'Step 1', detail: 'done' },
          { status: 'running', label: 'Step 2' },
          { status: 'pending', label: 'Step 3' },
        ],
        noColorTheme,
      );

      const lines = steps.split('\n');
      expect(lines.length).toBe(3);
      expect(lines[0]).toBe('✔ Step 1 done');
      expect(lines[1]).toBe('⏳ Step 2');
      expect(lines[2]).toBe('✦ Step 3');
    });

    it('renderStep is an alias to step', () => {
      expect(renderStep).toBe(step);
    });

    it('respects mono theme and level 0', () => {
      const monoResult = step('done', 'Completed', '100ms', monoTheme);
      expect(monoResult).not.toContain('\x1b[');

      const noColorResult = step('done', 'Completed', '100ms', noColorTheme);
      expect(noColorResult).not.toContain('\x1b[');
    });
  });

  describe('3. Badges & Accents (renderBadge)', () => {
    it('renders bracket badge by default', () => {
      const badge = renderBadge('active', 'success', { theme: noColorTheme });
      expect(badge).toBe('[ active ]');
    });

    it('renders pill style badge', () => {
      const badge = renderBadge('running', 'cyan', { style: 'pill', theme: noColorTheme });
      expect(badge).toBe('( running )');
    });

    it('supports compact option', () => {
      const bracket = renderBadge('prod', 'violet', { compact: true, theme: noColorTheme });
      expect(bracket).toBe('[prod]');

      const pill = renderBadge('prod', 'violet', {
        style: 'pill',
        compact: true,
        theme: noColorTheme,
      });
      expect(pill).toBe('(prod)');
    });

    it('supports dimBrackets option', () => {
      const badge = renderBadge('test', 'warning', { dimBrackets: true, theme: colorTheme });
      expect(badge).toContain(colorTheme.dim('['));
      expect(badge).toContain(colorTheme.dim(']'));
      expect(badge).toContain(colorTheme.wrap(colorTheme.palette.warning, 'test', { bold: true }));
    });

    it('supports options object as first argument', () => {
      const badge = renderBadge({ text: 'error', color: 'error', theme: noColorTheme });
      expect(badge).toBe('[ error ]');
    });

    it('respects mono theme and level 0', () => {
      const mono = renderBadge('active', 'cyan', { theme: monoTheme });
      expect(mono).not.toContain('\x1b[');
      expect(mono).toBe('[ active ]');

      const noColor = renderBadge('active', 'cyan', { theme: noColorTheme });
      expect(noColor).not.toContain('\x1b[');
      expect(noColor).toBe('[ active ]');
    });
  });

  describe('4. Clean Aligned Table Formatter (renderTable)', () => {
    it('renders clean headers, subtle dividers, and properly aligned columns', () => {
      const table = renderTable({
        columns: [
          { header: 'Command', align: 'left' },
          { header: 'Status', align: 'left' },
          { header: 'Duration', align: 'right' },
        ],
        rows: [
          ['build', 'done', '1.2s'],
          ['test', 'running', '350ms'],
          ['deploy', 'pending', '-'],
        ],
        theme: noColorTheme,
      });

      const lines = table.split('\n');
      expect(lines.length).toBe(5); // Header, divider, 3 rows
      expect(lines[0]).toBe('Command  Status   Duration');
      expect(lines[1]).toBe('───────  ───────  ────────');
      expect(lines[2]).toBe('build    done         1.2s');
      expect(lines[3]).toBe('test     running     350ms');
      expect(lines[4]).toBe('deploy   pending         -');
    });

    it('supports explicit column widths', () => {
      const table = renderTable({
        columns: [
          { header: 'ID', width: 6, align: 'left' },
          { header: 'Score', width: 8, align: 'right' },
        ],
        rows: [
          [1, 99],
          [2, 100],
        ],
        theme: noColorTheme,
      });

      const lines = table.split('\n');
      expect(lines[0]).toBe('ID         Score');
      expect(lines[1]).toBe('──────  ────────');
      expect(lines[2]).toBe('1             99');
      expect(lines[3]).toBe('2            100');
    });

    it('retains alignment even when cells contain ANSI formatting', () => {
      const styledBadge = colorTheme.success('[ OK ]');
      const table = renderTable({
        columns: [
          { header: 'Service', align: 'left' },
          { header: 'Status', align: 'left' },
        ],
        rows: [
          ['Auth', styledBadge],
          ['Database', colorTheme.error('[ FAIL ]')],
        ],
        theme: colorTheme,
      });

      const lines = table.split('\n');
      expect(lines.length).toBe(4);
      // Overall line widths match
      expect(stringWidth(lines[2]!)).toBe(stringWidth(lines[3]!));
    });

    it('returns empty string when columns array is empty', () => {
      expect(renderTable({ columns: [], rows: [] })).toBe('');
    });

    it('respects mono theme and level 0', () => {
      const table = renderTable({
        columns: [{ header: 'Header' }],
        rows: [['Value']],
        theme: monoTheme,
      });
      expect(table).not.toContain('\x1b[');
    });
  });

  describe('5. Modern Key-Value Card Formatter (renderCard)', () => {
    it('renders aligned key-value pairs inside a rounded box', () => {
      const card = renderCard({
        title: 'Gateway Config',
        fields: [
          ['Model', 'gpt-4o'],
          ['Rate Limit', '1,000 req/min'],
          ['Status', 'active'],
        ],
        theme: noColorTheme,
      });

      const lines = card.split('\n');
      expect(lines[0]).toContain('Gateway Config');
      expect(lines[0]!.startsWith('╭')).toBe(true);
      expect(lines[lines.length - 1]!.startsWith('╰')).toBe(true);

      // Verify all lines have equal visual width
      const width = stringWidth(lines[0]!);
      for (const line of lines) {
        expect(stringWidth(line)).toBe(width);
      }
    });

    it('includes subtle divider and footer when footer is provided', () => {
      const card = renderCard({
        title: 'Service',
        fields: [['Port', '8080']],
        footer: 'Press ctrl+c to exit',
        theme: noColorTheme,
      });

      const lines = card.split('\n');
      expect(card).toContain('Press ctrl+c to exit');
      expect(card).toContain('──');

      const width = stringWidth(lines[0]!);
      for (const line of lines) {
        expect(stringWidth(line)).toBe(width);
      }
    });

    it('respects mono theme and level 0', () => {
      const card = renderCard({
        title: 'Title',
        fields: [['Key', 'Val']],
        footer: 'Footer',
        theme: monoTheme,
      });

      expect(card).not.toContain('\x1b[');
    });
  });
});
