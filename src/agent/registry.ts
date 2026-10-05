/**
 * Tool registry for the future agent loop — EMPTY in v0.1 by design.
 *
 * The plan (docs/agent.md): when the agent loop lands, `selora run` will ask
 * this registry for the available tools, bridge them into the chat wire
 * format, render a permission prompt (Tool.permissionLabel), execute with
 * dryRun: true first, and only then run for real. The interface and registry
 * land NOW precisely so that loop can be added without touching the command
 * layer or the API client.
 *
 * Until a real tool exists, listTools() returns [] — pinned by test. There is
 * deliberately NO `selora agent` command: the CLI does not register commands
 * for features that do not exist.
 */

import type { Tool } from './tool.js';

const tools: Tool[] = [];

/** Register a tool for the future agent loop. No caller in v0.1. */
export function registerTool(tool: Tool): void {
  if (tools.some((t) => t.name === tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  tools.push(tool);
}

/** The registered tools — [] in v0.1 (nothing is registered). */
export function listTools(): Tool[] {
  return [...tools];
}
