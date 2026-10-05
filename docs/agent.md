# Agent roadmap (v0.1 honesty document)

`selora` v0.1 is **not** an agent. This page states exactly what exists, what
a v0.2 agent loop needs, and what deliberately does not exist — so nobody has
to discover the gaps by being surprised.

## What exists today (v0.1)

- **The Tool interface** — `src/agent/tool.ts`:
  `Tool { name, description, permissionLabel(input), run(input, ctx) }` with
  `ToolContext { cwd }` and `ToolResult { ok, summary }`. `run` receives a
  `dryRun` flag: in dry-run it only *describes* what would happen.
- **The registry** — `src/agent/registry.ts`: `registerTool(tool)` /
  `listTools()`. It registers **NOTHING** in v0.1 (`listTools()` returns `[]`,
  pinned by test). It is library-only — there is deliberately **no
  `selora agent` command**, because the CLI does not register commands for
  features that do not exist.
- **Real tool-call detection in `selora run`** — the streaming decoder
  (`src/api/endpoints/chat.ts`) sets `toolCallsRequested` when the model
  *actually* requested tools on the wire: any delta carrying `tool_calls`, or
  a finish chunk with `finish_reason: "tool_calls"`. When that happens, `run`
  prints the honest gray line
  `· agent mode not implemented yet — see docs/agent.md`. This is wire-based
  detection — never prompt-text guessing (the CLI never sniffs your prompt
  for words like "file").
- **`selora init`** writes a project-local `selora.json` containing the
  project's model plus `context.include`/`context.exclude` globs. The globs
  are saved **for the future agent and are NOT read yet** — v0.1 stores this
  config only.

## What a v0.2 agent loop needs

1. **Tool bridging into the chat wire format.** `POST /v1/chat/completions`
   must carry the tool definitions and return tool calls the CLI can decode.
   The current wire reference documents `delta: {tool_calls}` and
   `finish_reason: "tool_calls"` arriving from the gateway, but a
   *request-side* tools parameter is **not yet verified** against the real
   gateway — that must be confirmed (read-only recon of `/root/backend`)
   before any client code is written. No fields may be invented.
2. **Permission prompt UI.** Before any tool executes, the user sees
   `Tool.permissionLabel(input)` and must approve. The `Tool.run` contract is
   "never called without the permission gate".
3. **The dry-run contract.** First execution is always `dryRun: true` — the
   tool reports what it *would* do (`ToolResult.summary`); only after the user
   approves does the real execution happen.
4. **File/exec tools with sandboxing.** Read/write/execute tools scoped to
   `ToolContext.cwd` and the `context.include`/`exclude` globs from
   `selora.json`, with a sandbox that refuses paths outside the project.
5. **The loop itself**: stream a completion → if `toolCallsRequested`, decode
   the calls, resolve names against the registry, prompt, dry-run, execute,
   append tool results to the message history, and stream again.

The interface and registry land in v0.1 precisely so this loop can be added
**without touching the command layer or the API client**: the loop asks the
registry, renders prompts, and calls `Tool.run`. Commands and client stay
untouched when the loop lands.

## What deliberately does NOT exist

- **No auto-execution.** v0.1 never runs a tool, never executes a shell
  command, never touches a file because a model asked it to.
- **No telemetry.** Nothing about your prompts, replies, or files is sent
  anywhere except the chat request itself (model + messages), exactly as in
  `chat`/`run`.
- **No `selora agent` command**, no hidden agent mode, no prompt sniffing.
- **No reading of the context globs.** They are stored, nothing more.
