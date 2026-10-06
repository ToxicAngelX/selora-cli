/**
 * Permission-mode tests (v0.5): the cycle order, the status lines, and the
 * mode asker's auto-allow matrix — manual delegates everything; acceptEdits
 * auto-allows reads/writes inside the project but never exec, outside-root,
 * or neverAutoAllow (remove); auto allows everything EXCEPT neverAutoAllow.
 * The wrap is re-evaluated per request, so a mid-session mode change takes
 * effect on the very next call.
 */

import { describe, expect, it } from 'vitest';
import type { PermissionAsker, PermissionRequest } from '../src/agent/permissions.js';
import {
  createModeAsker,
  MODE_CYCLE,
  modeAutoAllows,
  modeStatusLine,
  nextMode,
  type PermissionMode,
} from '../src/agent/modes.js';

const WRITE_REQ: PermissionRequest = { label: 'write_file(out.txt)', kind: 'write' };
const READ_REQ: PermissionRequest = { label: 'read_file(src/index.ts)', kind: 'read' };
const EXEC_REQ: PermissionRequest = { label: 'exec(npm test)', kind: 'exec' };
const OUTSIDE_WRITE_REQ: PermissionRequest = {
  label: 'write_file(../out.txt)',
  kind: 'write',
  outsidePath: '/home/ada/out.txt',
};
const REMOVE_REQ: PermissionRequest = {
  label: 'remove(old.txt)',
  kind: 'write',
  neverAlways: true,
};

/** A recording base asker: every delegated ask is counted and answered. */
function recordingBase(decision: 'allow' | 'deny' = 'deny'): {
  base: PermissionAsker;
  asked: PermissionRequest[];
} {
  const asked: PermissionRequest[] = [];
  return {
    asked,
    base: {
      ask: async (req) => {
        asked.push(req);
        return decision;
      },
      askDetailed: async (req) => {
        asked.push(req);
        return { decision };
      },
      replacement: async () => null,
    },
  };
}

describe('mode cycle and status lines', () => {
  it('cycles manual → acceptEdits → auto → manual', () => {
    expect(MODE_CYCLE).toEqual(['manual', 'acceptEdits', 'auto']);
    let mode: PermissionMode = 'manual';
    mode = nextMode(mode);
    expect(mode).toBe('acceptEdits');
    mode = nextMode(mode);
    expect(mode).toBe('auto');
    mode = nextMode(mode);
    expect(mode).toBe('manual');
  });

  it('status lines: the exact prompt-block text per mode', () => {
    expect(modeStatusLine('manual')).toBe('⏸ manual mode on · ? for shortcuts');
    expect(modeStatusLine('acceptEdits')).toBe('⏵⏵ accept edits on · ? for shortcuts');
    expect(modeStatusLine('auto')).toBe('⏵⏵ auto mode on · ? for shortcuts');
    expect(modeStatusLine('safe')).toBe('⏸ safe mode on (read-only tools) · ? for shortcuts');
  });
});

describe('modeAutoAllows', () => {
  it('manual allows nothing by itself', () => {
    for (const req of [WRITE_REQ, READ_REQ, EXEC_REQ, OUTSIDE_WRITE_REQ, REMOVE_REQ]) {
      expect(modeAutoAllows('manual', req)).toBe(false);
    }
  });

  it('acceptEdits: reads and project writes run; exec, outside-root, remove ask', () => {
    expect(modeAutoAllows('acceptEdits', READ_REQ)).toBe(true);
    expect(modeAutoAllows('acceptEdits', WRITE_REQ)).toBe(true);
    expect(modeAutoAllows('acceptEdits', EXEC_REQ)).toBe(false);
    expect(modeAutoAllows('acceptEdits', OUTSIDE_WRITE_REQ)).toBe(false);
    expect(modeAutoAllows('acceptEdits', REMOVE_REQ)).toBe(false);
  });

  it('auto: everything runs EXCEPT neverAutoAllow deletions', () => {
    expect(modeAutoAllows('auto', READ_REQ)).toBe(true);
    expect(modeAutoAllows('auto', WRITE_REQ)).toBe(true);
    expect(modeAutoAllows('auto', EXEC_REQ)).toBe(true);
    expect(modeAutoAllows('auto', OUTSIDE_WRITE_REQ)).toBe(true);
    expect(modeAutoAllows('auto', REMOVE_REQ)).toBe(false);
  });
});

describe('createModeAsker', () => {
  it('auto-allowed requests never reach the base asker (both ask paths)', async () => {
    const { base, asked } = recordingBase();
    const asker = createModeAsker(base, () => 'auto');
    expect(await asker.ask(WRITE_REQ)).toBe('allow');
    expect(await asker.askDetailed!(EXEC_REQ)).toEqual({ decision: 'allow' });
    expect(asked.length).toBe(0);
  });

  it('manual mode delegates to the base asker verbatim', async () => {
    const { base, asked } = recordingBase('deny');
    const asker = createModeAsker(base, () => 'manual');
    expect(await asker.ask(WRITE_REQ)).toBe('deny');
    expect(await asker.askDetailed!(READ_REQ)).toEqual({ decision: 'deny' });
    expect(asked).toEqual([WRITE_REQ, READ_REQ]);
  });

  it('the mode is read PER REQUEST — a mid-session change bites immediately', async () => {
    const { base, asked } = recordingBase('deny');
    let mode: PermissionMode = 'manual';
    const asker = createModeAsker(base, () => mode);
    expect(await asker.ask(WRITE_REQ)).toBe('deny'); // manual: asked, denied
    mode = 'acceptEdits';
    expect(await asker.ask(WRITE_REQ)).toBe('allow'); // auto-allowed now
    expect(await asker.ask(EXEC_REQ)).toBe('deny'); // exec still asks
    mode = 'auto';
    expect(await asker.ask(EXEC_REQ)).toBe('allow'); // auto allows exec…
    expect(await asker.ask(REMOVE_REQ)).toBe('deny'); // …but remove asked, denied
    expect(asked.length).toBe(3);
  });

  it('without a base askDetailed, the wrap does not invent one', () => {
    const base: PermissionAsker = {
      ask: async () => 'deny',
      replacement: async () => null,
    };
    expect(createModeAsker(base, () => 'auto').askDetailed).toBeUndefined();
  });

  it('the replacement (edit-command) flow always delegates', async () => {
    let called = 0;
    const base: PermissionAsker = {
      ask: async () => 'deny',
      replacement: async (current) => {
        called += 1;
        return `${current} --fixed`;
      },
    };
    const asker = createModeAsker(base, () => 'auto');
    expect(await asker.replacement('npm test')).toBe('npm test --fixed');
    expect(called).toBe(1);
  });
});
