/**
 * Tool registry — the library API for tool authors. v0.2's agent loop ships
 * its built-in tools via `builtinTools()` (agent/tools/index.ts) and passes
 * them to the loop explicitly, so fresh instances never share state across
 * runs or tests. This registry remains the extension point: register your
 * own Tool objects and hand `listTools()` to a custom loop.
 *
 * Nothing is auto-registered: importing this module registers nothing, and
 * the CLI never mutates it. The duplicate-name guard keeps a registry honest.
 */

import type { Tool } from './tool.js';

const tools: Tool[] = [];

/** Register a tool. Throws on a duplicate name (never silently replaces). */
export function registerTool(tool: Tool): void {
  if (tools.some((t) => t.name === tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  tools.push(tool);
}

/** The registered tools (a copy — mutating it changes nothing). */
export function listTools(): Tool[] {
  return [...tools];
}

/** Remove all registered tools (test isolation). */
export function clearTools(): void {
  tools.length = 0;
}
