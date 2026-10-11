import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { Renderer, PALETTE, resolveColor, colorsEnabled } from '../src/terminal/render.js';
import { SeloraApiError } from '../src/api/errors.js';

describe('Renderer modern features and backward compatibility', () => {
  let savedNoColor: string | undefined;
  let savedTerm: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env['NO_COLOR'];
    savedTerm = process.env['TERM'];
    delete process.env['NO_COLOR'];
    process.env['TERM'] = 'xterm-256color';
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (savedNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = savedNoColor;

    if (savedTerm === undefined) delete process.env['TERM'];
    else process.env['TERM'] = savedTerm;

    process.exitCode = undefined;
  });

  function createHarness(opts: { color?: boolean; json?: boolean; debug?: boolean } = {}) {
    const outLines: string[] = [];
    const errLines: string[] = [];
    let rawOutText = '';
    let rawErrText = '';

    const r = new Renderer({
      out: (s) => outLines.push(s),
      err: (s) => errLines.push(s),
      rawOut: (s) => {
        rawOutText += s;
      },
      rawErr: (s) => {
        rawErrText += s;
      },
      ...opts,
    });

    return {
      r,
      out: outLines,
      err: errLines,
      rawOut: () => rawOutText,
      rawErr: () => rawErrText,
    };
  }

  describe('existing method signatures and behavior (plain / NO_COLOR)', () => {
    it('ok() emits checkmark and message', () => {
      const h = createHarness({ color: false });
      h.r.ok('all systems go');
      expect(h.out).toEqual(['✓ all systems go']);
    });

    it('fail() emits cross mark and message on stderr', () => {
      const h = createHarness({ color: false });
      h.r.fail('connection lost');
      expect(h.err).toEqual(['✗ connection lost']);
    });

    it('bullet() emits bullet and message on stderr', () => {
      const h = createHarness({ color: false });
      h.r.bullet('tip: use --force');
      expect(h.err).toEqual(['· tip: use --force']);
    });

    it('line() emits to stdout', () => {
      const h = createHarness({ color: false });
      h.r.line('hello');
      h.r.line();
      expect(h.out).toEqual(['hello', '']);
    });

    it('divider() emits 40 hairline characters', () => {
      const h = createHarness({ color: false });
      h.r.divider();
      expect(h.out).toEqual(['────────────────────────────────────────']);
    });

    it('field() emits label padded to width followed by value', () => {
      const h = createHarness({ color: false });
      h.r.field('Status', 'Active');
      h.r.field('LongLabelHere', 'Value', 10);
      expect(h.out[0]).toBe('Status      Active');
      expect(h.out[1]).toBe('LongLabelHereValue');
    });

    it('gray() emits text to stdout', () => {
      const h = createHarness({ color: false });
      h.r.gray('secondary text');
      expect(h.out).toEqual(['secondary text']);
    });

    it('green() emits text to stdout', () => {
      const h = createHarness({ color: false });
      h.r.green('secret-key-preview');
      expect(h.out).toEqual(['secret-key-preview']);
    });

    it('writeRaw() and writeRawGray() write to raw streams', () => {
      const h = createHarness({ color: false });
      h.r.writeRaw('stream chunk');
      h.r.writeRawGray('stream reason');
      expect(h.rawOut()).toBe('stream chunk');
      expect(h.rawErr()).toBe('stream reason');
    });

    it('jsonOut() outputs pretty JSON to stdout', () => {
      const h = createHarness({ color: false });
      h.r.jsonOut({ status: 'ok', count: 42 });
      expect(JSON.parse(h.out.join(''))).toEqual({ status: 'ok', count: 42 });
    });
  });

  describe('colors enabled', () => {
    it('ok() emits Mint Green checkmark', () => {
      const h = createHarness({ color: true });
      h.r.ok('success message');
      expect(h.out[0]).toContain('✓');
      expect(h.out[0]).toContain('success message');
      expect(h.out[0]).toContain('\x1b[');
    });

    it('fail() emits Coral Red cross mark', () => {
      const h = createHarness({ color: true });
      h.r.fail('error occurred');
      expect(h.err[0]).toContain('✗');
      expect(h.err[0]).toContain('error occurred');
      expect(h.err[0]).toContain('\x1b[');
    });

    it('divider() and gray() use slate gray escape sequence', () => {
      const h = createHarness({ color: true });
      h.r.divider();
      h.r.gray('dim info');
      expect(h.out[0]).toContain('─');
      expect(h.out[0]).toContain('\x1b[');
      expect(h.out[1]).toContain('dim info');
      expect(h.out[1]).toContain('\x1b[');
    });
  });

  describe('renderError()', () => {
    it('renders rounded box in Coral Red when color is enabled', () => {
      const h = createHarness({ color: true });
      const err = new SeloraApiError({
        kind: 'http_error',
        message: 'Invalid authorization token',
        hint: 'Run: selora login',
      });

      h.r.renderError(err);

      expect(process.exitCode).toBe(1);
      const combined = h.err.join('\n');
      expect(combined).toContain('╭─── Error');
      expect(combined).toContain('✗ Invalid authorization token');
      expect(combined).toContain('· Run: selora login');
      expect(combined).toContain('╰');
      expect(combined).toContain('\x1b[');
    });

    it('preserves plain fail/bullet output when color is disabled (NO_COLOR / non-TTY)', () => {
      const h = createHarness({ color: false });
      const err = new SeloraApiError({
        kind: 'http_error',
        message: 'Invalid authorization token',
        hint: 'Run: selora login',
      });

      h.r.renderError(err);

      expect(process.exitCode).toBe(1);
      expect(h.err[0]).toBe('✗ Invalid authorization token');
      expect(h.err[1]).toBe('· Run: selora login');
      expect(h.err.join('\n')).not.toContain('\x1b[');
    });

    it('handles generic non-SeloraApiError errors', () => {
      const h = createHarness({ color: false });
      h.r.renderError(new Error('something crashed'));

      expect(process.exitCode).toBe(1);
      expect(h.err[0]).toBe('✗ Unexpected CLI error.');
      expect(h.err[1]).toBe('· (run with --debug for details)');
    });

    it('preserves --json mode structure and exitCode', () => {
      const h = createHarness({ json: true });
      const err = new SeloraApiError({
        kind: 'auth',
        message: 'You are not logged in.',
      });

      h.r.renderError(err);

      expect(process.exitCode).toBe(1);
      const parsed = JSON.parse(h.out.join('')) as {
        ok: boolean;
        error: { kind: string; message: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.kind).toBe('auth');
      expect(parsed.error.message).toBe('You are not logged in.');
      expect(h.err).toHaveLength(0);
    });

    it('appends debug detail when debug is true', () => {
      const h = createHarness({ color: false, debug: true });
      const err = new SeloraApiError({
        kind: 'auth',
        message: 'Session expired',
        status: 401,
        reqId: 'req_xyz',
      });

      h.r.renderError(err);

      expect(process.exitCode).toBe(1);
      expect(h.err[0]).toBe('✗ Session expired');
      expect(h.err.join('\n')).toContain('kind: auth');
      expect(h.err.join('\n')).toContain('status: 401');
      expect(h.err.join('\n')).toContain('request_id: req_xyz');
    });
  });

  describe('new modern helper methods', () => {
    it('card() renders rounded card with title and aligned key-values', () => {
      const h = createHarness({ color: false });
      h.r.card('Deployment', [
        ['Status', 'Active'],
        ['Region', 'us-east-1'],
        ['Version', 'v1.4.0'],
      ]);

      const text = h.out.join('\n');
      expect(text).toContain('╭─── Deployment');
      expect(text).toContain('Status');
      expect(text).toContain('Active');
      expect(text).toContain('Region');
      expect(text).toContain('us-east-1');
      expect(text).toContain('╰');
    });

    it('panel() renders colored or plain box on out or err stream', () => {
      const hOut = createHarness({ color: false });
      hOut.r.panel('Notice', 'System maintenance scheduled.', 'info');
      expect(hOut.out.join('\n')).toContain('╭─── Notice');
      expect(hOut.out.join('\n')).toContain('System maintenance scheduled.');
      expect(hOut.out.join('\n')).toContain('╰');
      expect(hOut.err).toHaveLength(0);

      const hErr = createHarness({ color: false });
      hErr.r.panel('Alert', ['Disk full', 'Free up space'], 'error');
      expect(hErr.err.join('\n')).toContain('╭─── Alert');
      expect(hErr.err.join('\n')).toContain('Disk full');
      expect(hErr.err.join('\n')).toContain('Free up space');
      expect(hErr.out).toHaveLength(0);
    });

    it('step() renders status symbols and optional detail', () => {
      const h = createHarness({ color: false });
      h.r.step('done', 'Initialized repository', '12ms');
      h.r.step('running', 'Compiling bundle');
      h.r.step('failed', 'Type check failed', '1 error');
      h.r.step('pending', 'Deploying to cloud');

      expect(h.out[0]).toBe('✓ Initialized repository (12ms)');
      expect(h.out[1]).toBe('● Compiling bundle');
      expect(h.out[2]).toBe('✗ Type check failed (1 error)');
      expect(h.out[3]).toBe('○ Deploying to cloud');
    });

    it('badge() formats labels in brackets, with or without color', () => {
      const hNoColor = createHarness({ color: false });
      expect(hNoColor.r.badge('PRO', 'primary')).toBe('[PRO]');

      const hColor = createHarness({ color: true });
      const badge = hColor.r.badge('BETA', 'warning');
      expect(badge).toContain('BETA');
      expect(badge).toContain('\x1b[');
    });
  });

  describe('strict NO_COLOR and TERM=dumb compliance', () => {
    it('NO_COLOR environment variable disables color even if color:true was requested', () => {
      process.env['NO_COLOR'] = '1';
      const h = createHarness({ color: true });
      h.r.ok('no escapes');
      expect(h.out[0]).toBe('✓ no escapes');
      expect(h.out[0]).not.toContain('\x1b[');
    });

    it('TERM=dumb disables color', () => {
      process.env['TERM'] = 'dumb';
      const h = createHarness({ color: true });
      h.r.ok('dumb terminal');
      expect(h.out[0]).toBe('✓ dumb terminal');
      expect(h.out[0]).not.toContain('\x1b[');
    });

    it('colorsEnabled() function correctly checks NO_COLOR, dumb, and TTY', () => {
      delete process.env['NO_COLOR'];
      process.env['TERM'] = 'xterm-256color';
      expect(colorsEnabled(true)).toBe(true);
      expect(colorsEnabled(false)).toBe(false);

      process.env['NO_COLOR'] = '1';
      expect(colorsEnabled(true)).toBe(false);

      delete process.env['NO_COLOR'];
      process.env['TERM'] = 'dumb';
      expect(colorsEnabled(true)).toBe(false);
    });

    it('resolveColor() maps theme palette names and hex strings', () => {
      expect(resolveColor('primary')).toBe(PALETTE.primary);
      expect(resolveColor('secondary')).toBe(PALETTE.secondary);
      expect(resolveColor('success')).toBe(PALETTE.success);
      expect(resolveColor('warning')).toBe(PALETTE.warning);
      expect(resolveColor('error')).toBe(PALETTE.error);
      expect(resolveColor('dim')).toBe(PALETTE.slate);
      expect(resolveColor('#123456')).toBe('#123456');
      expect(resolveColor(undefined)).toBe(PALETTE.secondary);
    });
  });
});
