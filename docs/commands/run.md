# `selora run "<prompt>" [--model <id>]`

One-shot streaming completion — the same pipeline as `chat`
(`POST /v1/chat/completions`, SSE deltas, usage chunk, `gateway.charge`)
but with **no REPL**: the prompt is the argument, the reply streams once, the
process exits. Non-interactive by design; safe with a piped stdout.

```
$ selora run "explain this"
Hello, world!
  Tokens: 6,055 · Cost: $0.018
```

- Content deltas stream to **stdout** the moment they arrive (no buffering).
  `reasoning_content` deltas (when the model sends them) stream dim-gray to
  **stderr**, so piping stdout still yields clean reply text.
- The footer appears **only if the usage chunk actually arrived** — real
  numbers only, never invented (`Tokens` = `total_tokens` comma-grouped;
  `Cost` = `gateway.charge`, sub-dime amounts keep 3 decimals). It is the
  same footer implementation `chat` uses.
- A missing prompt exits 1 with `✗ Usage: selora run "<prompt>"`.

## Model resolution

`--model <id>` > the project's `selora.json` model (from the current
directory, see `selora init`) > the global default model
(`selora model <id>`) > `glm-5.3-flash`.

The hierarchy is resolved silently — nothing is printed about it unless
`--debug` (`· model: <id> (resolved from <source>)`). Unlike `chat`, `run`
does **not** pre-verify the model against `/v1/models/:id`; the gateway
rejects an unknown model at request time and that error is rendered verbatim.

## History

A **single user message**, in memory only — nothing is written to disk and
nothing from previous `run` invocations is remembered. Multi-turn
conversations belong to `selora chat`.

## Tool-call honesty

If the model _actually_ requested tools on the wire — any delta carrying
`tool_calls` or a finish chunk with `finish_reason: "tool_calls"` — the reply
is followed by a gray stderr line:

```
· agent mode not implemented yet — see docs/agent.md
```

This is real wire detection, never prompt-text guessing: the CLI never sniffs
your prompt for words like "file". The content that streamed before the tool
call is still shown. See [docs/agent.md](../agent.md) for what an agent loop
would need.

## Errors

Same mapping as `chat`: the 402 window-exhausted message is passed through
**verbatim** (the reset time lives only inside the message text), 429 shows
the backend message plus a wait hint, 401 exits 1 with login guidance
(`/v1/chat/completions` is API-key-only — with no stored key:
`✗ You are not logged in. Run: selora login`). In-band stream errors (sent
as data events after the headers) render their backend message verbatim. All
failures exit 1.

## Flags

`--model <id>`, plus globals `--debug`, `--json`, `--api-url <url>`.

## `--json`

Streaming text and machine output do not mix: in `--json` mode the reply is
**buffered** (no streaming display) and printed as ONE object on stdout:

```json
{
  "ok": true,
  "model": "glm-5.3-flash",
  "content": "Hello, world!",
  "finishReason": "stop",
  "usage": { "promptTokens": 4821, "completionTokens": 1234, "totalTokens": 6055 },
  "charge": "0.018234"
}
```

`usage` and `charge` appear only when the stream actually carried them (the
raw scale-6 decimal string is preserved for `charge`). A tool-call request is
signaled by `finishReason: "tool_calls"` — there is no separate flag, and the
gray agent-mode note is a human-mode-only stderr line. Errors use the shared
`{ok:false, error:{…}}` envelope.
