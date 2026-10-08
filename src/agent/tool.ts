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

import { SeloraApiError } from '../api/errors.js';

/** Permission class — read tools are prompt-only, write/exec show previews. */
export type ToolKind = 'read' | 'write' | 'exec';

export interface ToolContext {
  /** The project root — also the sandbox root every path is contained in. */
  cwd: string;
  /**
   * v0.3: directories the user approved for OUTSIDE-the-project access this
   * session (absolute, realpath-resolved). A tool resolving a path outside
   * the project root may proceed only when the resolved path is inside one
   * of these; otherwise it returns `outside` from its dry run so the loop
   * can ask. Absent/empty = no outside access granted yet.
   */
  outsideDirs?: readonly string[];
  /** Abort signal for the current agent turn/tool sequence. */
  signal?: AbortSignal | undefined;
}

/** Throw the loop's canonical cancellation error when work should stop. */
export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new SeloraApiError({ kind: 'cancelled', message: 'Request cancelled.' });
  }
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
  /**
   * v0.3: the before/after of an edit, for a COLORED diff in the permission
   * prompt and the tool-result display. Dry runs of edit tools set this
   * (simulating the change); real runs may set it too.
   * v1.3: `path` (the tool's display path) rides along so the diff renderer
   * can title the box and pick syntax highlighting by extension; `kind`
   * ('created' | 'modified' | 'deleted') lets session history checkpoint the
   * change honestly (a create's undo deletes the file).
   */
  diff?: {
    before: string;
    after: string;
    path?: string | undefined;
    kind?: 'created' | 'modified' | 'deleted' | undefined;
  };
  /**
   * v0.3 (dry runs only): the tool resolved a path OUTSIDE the project root
   * and outside every session-allowed directory. The loop turns this into the
   * outside-access permission prompt (showing the absolute path) instead of
   * the normal tool prompt.
   */
  outside?: { abs: string };
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
   * v0.3: when true, an `a` (always this session) answer is NEVER remembered
   * for this tool — every call prompts, even in always-allow mode. Used by
   * destructive tools (remove) where one approval must not blanket the next.
   */
  readonly neverAutoAllow?: boolean;
  /**
   * Executes, or (dryRun) describes what would happen. Never called without
   * the permission gate — the caller must have asked the user first.
   */
  readonly run: (input: unknown, ctx: ToolContext & { dryRun: boolean }) => Promise<ToolResult>;
}
