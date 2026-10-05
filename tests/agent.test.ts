/**
 * Agent scaffold tests: the v0.1 registry is EMPTY (pinned — this is the
 * honesty guarantee that no tool can silently appear) and the Tool interface
 * type-checks with a minimal implementation. Library-only: there is no
 * `selora agent` command.
 */

import { describe, expect, it } from 'vitest';
import { listTools, registerTool } from '../src/agent/registry.js';
import type { Tool, ToolResult } from '../src/agent/tool.js';

describe('agent registry', () => {
  it('listTools() returns [] — v0.1 registers NOTHING (pinned)', () => {
    expect(listTools()).toEqual([]);
  });

  it('the Tool interface is implementable (type-level contract, nothing registered)', () => {
    const probe: Tool = {
      name: 'probe_TEST',
      description: 'never registered — proves the interface shape compiles',
      permissionLabel: (input: unknown) => `probe ${String(input)}`,
      run: async (_input: unknown, _ctx: { dryRun: boolean }): Promise<ToolResult> => ({
        ok: true,
        summary: 'nothing happened',
      }),
    };
    expect(probe.name).toBe('probe_TEST');
    // still nothing registered — the probe was never passed to registerTool
    expect(listTools()).toEqual([]);
    expect(typeof registerTool).toBe('function');
  });
});
