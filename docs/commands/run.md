# `selora run "<prompt>" [--model <id>] [--session <name>] [--safe] [--yes] [--max-turns <n>]`

One-shot streaming completion — the same pipeline as `chat`
(`POST /v1/chat/completions`, SSE deltas, usage chunk, `gateway.charge`)
but with **no REPL** — and, since v0.2, a real **agent**: the request
carries the tool definitions, and when the model actually requests tools on
the wire, each call goes through the permission gate before it executes.
See [docs/agent.md](../agent.md) for the full sandbox and permission model.

```
$ selora run "what does src/index.ts do?"
→ read_file(src/index.ts)
┌─ read_file(src/index.ts)
│   1 line, 20 B
└─ Allow? [y]es / [n]o / [a]lways this session
y
· read src/index.ts (1 line, 20 B)
It exports a single constant…
  Tokens: 240 · Cost: $0.002
  Tokens: 6,055 · Cost: $0.018
  Agent totals: 2 turns · Tokens: 6,295 · Cost: $0.020
```

- Content deltas stream to **stdout** the moment they arrive (no buffering).
  `reasoning_content` deltas (when the model sends them) stream dim-gray to
  **stderr**, so piping stdout still yields clean reply text.
- Tool activity renders as gray `→ tool(...)` lines on stderr — the same
  live-progress contract, plus the permission boxes.
- Per-turn footers and a cumulative `Agent totals` line appear **only if the
  usage chunks actually arrived** — real numbers only, never invented.
- A missing prompt exits 1 with `✗ Usage: selora run "<prompt>"`.

## The agent loop

Tool execution is triggered by **real wire tool calls only**
(`delta.tool_calls` / `finish_reason: "tool_calls"`) — never by sniffing the
prompt text. Each call: permission prompt (dry-run preview → y/n/a[/e for
`run_command`]) → execute → the result is appended as a `tool` message →
the model streams again. Bounded by the turn cap (25 by default), with a
3-consecutive-failure circuit breaker (exit 1) and the budget guard above.

### Flags

- `--safe` — restrict the agent to the read-only tools (`read_file`,
  `list_dir`, `glob`, `grep`, `web_search`, `web_fetch`, `git_status`,
  `git_diff`, `git_log`). Write/exec tools are not even offered to the model.
- `--yes` — auto-approve every tool the (possibly `--safe`) toolset allows,
  non-interactively (including implicit in-memory grants for outside-root
  paths). Without a TTY and without `--yes`, prompts deny safely.
- `--max-turns <n>` — turn cap, 1–200 (default: the project `selora.json`
  `agent.maxTurns`, else 25). Invalid values exit 1 with the exact rule.
- `--session <name>` — resume/create a named conversation session (below).

## v0.3 display

On a TTY, `run` renders tool calls the rich way — `● Name(args)` headers,
indented `⎿` result lines with content collapsed to 5 lines, colored
red/green diffs for `edit_file` (also inside the permission prompt), and the
arrow-key permission menu. Non-TTY (pipes, CI) keeps the v0.2 gray
`→ tool(...)` activity lines and the line-based prompt, byte-for-byte;
`--json` output is unchanged. The theme follows `selora theme` (galaxy by
default) and degrades honestly (NO_COLOR, 256/16-color terminals).

## Model resolution

`--model <id>` > the resumed session's model > the project's `selora.json`
model (from the current directory, see `selora init`) > the global default
model (`selora model <id>`) > `glm-5.3-flash`.

The hierarchy is resolved silently — nothing is printed about it unless
`--debug` (`· model: <id> (resolved from <source>)`). Unlike `chat`, `run`
does **not** pre-verify the model against `/v1/models/:id`; the gateway
rejects an unknown model at request time and that error is rendered verbatim.
The model that actually ran is saved into the session.

## Sessions

`--session <name>` persists the conversation in
`.selora/sessions/<name>.json` (project-local, atomic write). The session
**advances only on completed runs** — a run that dies mid-stream never
writes. The next `--session <name>` run resumes the full history, including
tool calls and results. Names are validated to a conservative slug set
(letters, digits, dash, underscore, dot; alphanumeric first; 1–64 chars).
Manage saved sessions with `selora sessions` (see
[sessions.md](sessions.md)).

## Errors

Same mapping as `chat`: the 402 window-exhausted message is passed through
**verbatim** (the reset time lives only inside the message text), 429 shows
the backend message plus a wait hint, 401 exits 1 with login guidance
(`/v1/chat/completions` is API-key-only — with no stored key:
`✗ You are not logged in. Run: selora login`). In-band stream errors (sent
as data events after the headers) render their backend message verbatim. All
failures exit 1. A tool that fails is NOT a CLI error — the failure text
goes back to the model; only 3 consecutive tool failures abort (exit 1).

## `--json`

Streaming text and machine output do not mix: in `--json` mode the reply is
**buffered** (no streaming display) and printed as ONE object on stdout:

```json
{
  "ok": true,
  "model": "glm-5.3-flash",
  "content": "Hello, world!",
  "finishReason": "stop",
  "turns": 2,
  "tools": [
    {
      "tool": "read_file",
      "label": "read_file(src/index.ts)",
      "ok": true,
      "summary": "read src/index.ts (1 line, 20 B)"
    }
  ],
  "usage": { "promptTokens": 5021, "completionTokens": 1274, "totalTokens": 6295 },
  "charge": "0.020234"
}
```

`usage` and `charge` appear only when a turn actually carried them (the raw
scale-6 decimal string is preserved for `charge`); `charge` is the
**cumulative** cost across all turns. `tools` lists every tool event with
its outcome. JSON mode cannot prompt: without `--yes` every tool is denied
and the denial is fed back to the model; with `--yes` tools execute. A run
stopped by the failure breaker adds `"stopped": "tool-failures"` and exits 1.
Errors use the shared `{ok:false, error:{…}}` envelope.
