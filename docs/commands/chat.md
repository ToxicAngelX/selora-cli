# `selora chat [--model <id>]`

Interactive streaming chat session with a model.

```
✓ Connected to glm-5.3-flash (GLM 5.3 Flash)
> hello
Hello, world!
  Tokens: 6,055 · Cost: $0.018
> /exit
✓ Session ended
```

Content deltas stream to stdout the moment they arrive (no buffering).
`reasoning_content` deltas (when the model sends them) stream dim-gray to
stderr, so piping stdout still yields clean reply text.

## Model resolution

`--model <id>` > the configured default model (`selora model <id>`) >
`glm-5.3-flash`.

The model is **verified** via the public `GET /v1/models/:id` route (no auth
header — the pricing-bearing internal flavor) before the REPL starts. An
unknown id prints the backend's honest 404 message (`Model not available`)
plus a `selora models` hint and exits 1 — the REPL never opens on a bad
model. The header shows the `display_name` too when the backend sends one.

Chat authenticates with the **stored API key only** — the gateway refuses
session JWTs on `/v1/chat/completions`. With no stored key the command exits
1 with `You are not logged in. Run: selora login`.

## Slash commands

| Command | Effect |
|---|---|
| `/model` | show the current model |
| `/model <id>` | verify `<id>` via `/v1/models/:id`, then switch (404 keeps the current model) |
| `/help` | list the slash commands |
| `/exit` | end the session (Ctrl+D at the prompt also works) |

Empty lines just re-prompt. Unknown slash commands print a hint.

## Per-reply footer

After each reply, a gray footer appears **only if the usage chunk actually
arrived** — real numbers only, never invented:

```
  Tokens: 6,055 · Cost: $0.018
```

- `Tokens` is `total_tokens` from the usage chunk, comma-grouped.
- `Cost` comes from `gateway.charge` (the wire's decimal USD string). Because
  a typical per-message charge is a fraction of a cent, sub-dime amounts show
  3 decimals (`0.018234` → `$0.018`, truncation toward zero); `$0.10` and up
  use the standard 2-decimal money format.
- If the stream ended without a usage chunk, **no footer is printed**.

## Ctrl+C behavior

- **During a stream**: aborts the in-flight request, prints
  `· Request cancelled — session kept`, and returns to the prompt. The
  aborted turn is dropped from the history entirely (retry starts clean).
- **At the prompt** (no stream in flight): exits the session cleanly.

Failed turns (429 / 402 / network / in-band stream errors) are likewise
dropped from history; the error is rendered (`✗ <backend message verbatim>`)
and the REPL stays alive. 402 window-exhausted messages contain the reset
time only inside the message text — it is passed through verbatim, never
re-formatted or counted down. The one fatal case is authentication
(401 revoked/invalid key): the session exits 1 with the backend's verbatim
rotation message.

## Non-interactive use

`selora chat` needs an interactive terminal. With non-TTY stdin it prints
`✗ selora chat needs an interactive terminal — use: selora run "<prompt>"`
and exits 1. Scripted one-shot use belongs to `selora run`
([run.md](run.md)).

## History

Conversation state is **in-memory only** — never written to disk, never
sent anywhere except as the `messages` array of the next request. Each turn
sends the full in-memory history (user + assistant messages).

## Flags

`--model <id>`, plus globals `--debug`, `--json`, `--api-url <url>`.

## `--json` caveat

A streaming REPL is not machine-readable by nature. `--json` applies only to
the pre-REPL failure paths (non-TTY stdin, model verification errors) — the
REPL itself is always human-formatted. Scripted one-shot use belongs to
`selora run --json` ([run.md](run.md)).

## `--debug`

Debug mode logs the request line (`→ POST /v1/chat/completions …`) and the
response status through the redacting printer; the Authorization header is
never printed, and the request body carries no secrets.
