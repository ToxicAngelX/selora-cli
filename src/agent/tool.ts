/**
 * The Tool interface — the unit the v0.2 agent loop executes. Every tool is
 * REAL: its run() performs the actual filesystem/exec/git operation, and every
 * tool is exercised by tests. `input` is `unknown` on purpose: each tool
 * validates its own input defensively (Object.hasOwn guards) — the CLI never
 * trusts model-produced JSON.
 *
 * Contract (unchanged from v0.1, plus the fields the real loop needs):
 *  - `run` is NEVER called without the permission gate — the caller must have
 *    asked the user first (agent/permissions.ts).
 *  - First execution of an approved call is dryRun: true — the tool describes
 *    what WOULD happen (summary + preview). Only after approval does the real
 *    execution happen.
 *  - `kind` drives the permission model: read tools get y/n/a, write and exec
 *    tools additionally show a preview of the exact change.
 *  - `parameters` is the OpenAI-dialect JSON schema bridged onto the chat wire
 *    ({"type":"function","function":{name,description,parameters}}).
 */

/** Permission class — read tools are prompt-only, write/exec show previews. */
export type ToolKind = 'read' | 'write' | 'exec';

export interface ToolContext {
  /** The project root — also the sandbox root every path is contained in. */
  cwd: string;
}

export interface ToolResult {
  ok: boolean;
  /** What happened — or, in dry-run, what WOULD happen. One line, human. */
  summary: string;
  /**
   * The payload sent to the model as the tool message content. Omitted in
   * dry-run; when omitted on a real run, the summary is sent instead.
   */
  content?: string;
  /**
   * Extra display text for the permission prompt (write/exec tools: the exact
   * change about to happen — file content to write, find/replace with context,
   * commit message + staged files). Multi-line allowed; read tools usually
   * leave this to the summary line.
   */
  preview?: string;
}

export interface ToolParameters {
  type: 'object';
  properties: Record<string, { type: string; description: string; [k: string]: unknown }>;
  required?: readonly string[];
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly kind: ToolKind;
  /** JSON-schema shape of the input object, sent on the wire as-is. */
  readonly parameters: ToolParameters;
  /** Human label for the permission prompt, e.g. read_file(src/index.ts). */
  readonly permissionLabel: (input: unknown) => string;
  /**
   * Executes, or (dryRun) describes what would happen. Never called without
   * the permission gate — the caller must have asked the user first.
   */
  readonly run: (input: unknown, ctx: ToolContext & { dryRun: boolean }) => Promise<ToolResult>;
}
