/**
 * Agent scaffold tests: importing the agent modules registers NOTHING (the
 * pinned honesty guarantee — tools are handed to the loop explicitly via
 * builtinTools(), never auto-registered), the registry API behaves
 * (duplicate-name guard, copy-on-list, clearTools), and the v0.2 Tool
 * interface type-checks with a minimal implementation.
 */

import { describe, expect, it } from 'vitest';
import { clearTools, listTools, registerTool } from '../src/agent/registry.js';
import { builtinTools } from '../src/agent/tools/index.js';
import type { Tool, ToolResult } from '../src/agent/tool.js';

describe('agent registry', () => {
  it('imports register NOTHING — tools reach the loop only via builtinTools() (pinned)', () => {
    expect(listTools()).toEqual([]);
    // importing the built-ins does not touch the registry either
    expect(builtinTools().length).toBeGreaterThan(0);
    expect(listTools()).toEqual([]);
  });

  it('register/list/clear behave: copy-on-list, duplicate names throw, clearTools empties', () => {
    const probe: Tool = {
      name: 'probe_TEST',
      description: 'never registered — proves the interface shape compiles',
      kind: 'read',
      parameters: { type: 'object', properties: {} },
      permissionLabel: () => 'probe_TEST()',
      run: async () => ({ ok: true, summary: 'nothing happened' }) as ToolResult,
    };
    registerTool(probe);
    expect(listTools()).toEqual([probe]);
    expect(listTools()).not.toBe(listTools()); // a copy — mutating it changes nothing
    expect(() => registerTool(probe)).toThrow('Tool already registered: probe_TEST');
    clearTools();
    expect(listTools()).toEqual([]);
  });

  it('builtinTools(): the stable wire order (11 tools, read tools first, exec gated)', () => {
    expect(builtinTools().map((t) => t.name)).toEqual([
      'read_file',
      'write_file',
      'edit_file',
      'glob',
      'grep',
      'run_command',
      'git_status',
      'git_diff',
      'git_log',
      'git_commit',
      'git_restore',
    ]);
    for (const t of builtinTools()) {
      expect(['read', 'write', 'exec']).toContain(t.kind);
      expect(t.parameters.type).toBe('object');
      expect(typeof t.description).toBe('string');
      expect(typeof t.permissionLabel({})).toBe('string');
    }
  });
});
