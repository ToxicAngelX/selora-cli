/**
 * The Tool interface for the future selora agent loop (docs/agent.md).
 *
 * This is architecture-only in v0.1: ZERO tools exist, nothing executes, and
 * no command uses this type. It lands now so the v0.2 agent loop can be built
 * WITHOUT touching the command layer or the API client — the loop will ask
 * the registry (agent/registry.ts), render permission prompts from
 * permissionLabel(), and call run() with dryRun: true BEFORE the real
 * execution. `input` is `unknown` on purpose: each tool validates its own
 * input schema defensively (Object.hasOwn guards) — the CLI never trusts
 * model-produced JSON.
 */

export interface ToolContext {
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  /** What happened — or, in dry-run, what WOULD happen. */
  summary: string;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  /** Human name for the permission prompt. */
  readonly permissionLabel: (input: unknown) => string;
  /**
   * Executes, or (dryRun) describes what would happen. Never called without
   * the permission gate — the caller must have asked the user first.
   */
  readonly run: (input: unknown, ctx: ToolContext & { dryRun: boolean }) => Promise<ToolResult>;
}
