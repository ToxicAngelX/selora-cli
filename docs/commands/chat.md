# `selora chat [--model <id>] [--safe] [--yes]`

Interactive streaming chat session with a model — and, since v0.3, the agent
REPL: every message runs the full tool loop (permission-gated) with a
galaxy-themed UI. `run`'s one-shot pipeline, but conversational.

```
✓ Connected to glm-5.3-flash (GLM 5.3 Flash)
❯ create a folder called Projects on my desktop
● CreateDir(desktop/Projects)
┌─ create_dir(desktop/Projects)
│   outside the project root:
│   /Users/ada/Desktop/Projects
│   create /Users/ada/Desktop/Projects — recursive
└─ Allow? [y]es / [n]o / [a]lways this session
y
  ⎿ created /Users/ada/Desktop/Projects
Done — the folder is on your desktop.
  Tokens: 6,055 · Cost: $0.018
❯ /exit
· Session: 1m 12s · 1 request · 6,055 tokens · $0.018 · 1 file change
✓ Session ended
```

## The v0.3 UI

- **Startup screen** (interactive terminals only — never `--json`, never
  non-TTY): the SELORA logo in a per-character sweep of the theme gradient,
  surrounded by a sparse twinkling starfield (different every launch), and a
  rounded box with the CLI version, the current model, the working directory,
  your plan, and tips (two pinned, one rotating per launch). On a
  color-capable TTY the screen plays as a ~0.6s animation — the gradient
  sweeps in while stars twinkle — landing exactly on the static frame. Set
  `SELORA_NO_ANIMATE` (any value) to skip it; it also skips automatically on
  NO_COLOR/TERM=dumb/non-TTY/`mono` and on terminals too short to redraw.
  Under 60 columns the block logo collapses to a compact one-liner.
- **Prompt**: a dim status line (`model · cwd · permission mode · tokens`)
  above a gradient `❯` marker.
- **Replies** stream through the markdown renderer: completed lines render
  live; fenced code blocks render as dim boxed units with a language label
  once they close. Headings, bold, inline code, and bullets are styled.
- **Tool calls** render as `● Read(src/api.ts)` with an indented `⎿` result
  line; long tool outputs collapse to 5 lines with `… +N lines`; edits show a
  colored red/green diff with line numbers and 3 context lines.
- **Permission menu**: on a TTY the prompt is an arrow-key menu
  (❯ Yes / Yes, always this session / No, plus Edit command for exec tools);
  a "No" may carry a typed reason that goes back to the model. Piped stdin
  keeps the line-based y/n/a/e box. `Esc` = No. Raw mode is held only while
  the menu is open.
- **Spinner**: `✦ Warping… 12s · 1.4K tokens · ctrl+c to interrupt` while a
  reply streams (galaxy frames + a shimmering gradient word rotating through
  ten phrases, real elapsed time, honest token counts — never under
  NO_COLOR/non-TTY). Ctrl+C stops a reply cleanly.
- **Exit summary**: duration, requests, tokens, cost, files changed.

## Themes

`selora theme galaxy|nebula|aurora|mono` (or `/theme <name>` in the REPL)
picks the palette — saved in the global config, and applied live (the spinner
follows too). `mono` disables all theme colors. NO_COLOR, TERM=dumb, and
non-TTY streams disable color regardless, and truecolor degrades honestly to
256/16-color terminals.

## The agent

Every message runs the same loop as `selora run`: the request carries the 18
tool definitions; when the model actually requests tools on the wire, each
call is permission-gated (dry-run preview → menu), executed, and its result
feeds back. One readline drives both the prompt and the permission menu.
`--safe` restricts the toolset to read-only tools; `--yes` auto-approves
(then outside-root access is granted implicitly, in memory). Turn cap: the
project `selora.json` `agent.maxTurns`, else 25. The permission memory
("always this session", outside-root directory grants) lives in the session
process only. See [docs/agent.md](../agent.md) for the full sandbox model.

## Model resolution

`--model <id>` > the configured default model (`selora model <id>`) >
`glm-5.3-flash`.

The model is **verified** via the public `GET /v1/models/:id` route (no auth
header — the pricing-bearing internal flavor) before the REPL starts. An
unknown id prints the backend's honest 404 message (`Model not available`)
plus a `selora models` hint and exits 1 — the REPL never opens on a bad
model.

Chat authenticates with the **stored API key only**. With no stored key the
command exits 1 with `You are not logged in. Run: selora login`.

## Slash commands

| Command         | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `/help`         | list the slash commands                                                       |
| `/model`        | show the current model                                                        |
| `/model <id>`   | verify `<id>` via `/v1/models/:id`, then switch (404 keeps the current model) |
| `/theme`        | show the current theme                                                        |
| `/theme <name>` | switch (galaxy, nebula, mono) — saved to the global config                    |
| `/clear`        | clear the conversation history                                                |
| `/tools`        | list the tools available this session (and the permission mode)               |
| `/permissions`  | show what is auto-allowed this session (memory-only state)                    |
| `/cost`         | session totals: requests, tokens, cost                                        |
| `/exit`         | end the session (Ctrl+D at the prompt also works)                             |

Empty lines just re-prompt. Unknown slash commands print a hint.

## Per-reply footer

After each turn, a gray footer appears **only if the usage chunk actually
arrived** — real numbers only, never invented: `  Tokens: 6,055 · Cost: $0.018`.
Sub-dime costs keep 3 decimals. No usage chunk → no footer.

## Ctrl+C behavior

- **During a stream**: aborts the in-flight request, prints
  `· Request cancelled — session kept`, and returns to the prompt. The
  aborted turn is dropped from the history entirely (retry starts clean).
- **At the prompt** (no stream in flight): exits the session cleanly.

Failed turns (429 / 402 / network / in-band stream errors) are likewise
dropped from history; the error is rendered (`✗ <backend message verbatim>`)
and the REPL stays alive. The one fatal case is authentication (401
revoked/invalid key): the session exits 1 with the backend's verbatim
rotation message.

## Non-interactive use

`selora chat` needs an interactive terminal. With non-TTY stdin it prints
`✗ selora chat needs an interactive terminal — use: selora run "<prompt>"`
and exits 1. Scripted one-shot use belongs to `selora run` ([run.md](run.md)).

## History

Conversation state is **in-memory only** — never written to disk, never sent
anywhere except as the `messages` array of the next request. Each turn sends
the full in-memory history (user + assistant + tool messages of prior turns).

## Flags

`--model <id>`, `--safe`, `--yes`, plus globals `--debug`, `--json`,
`--api-url <url>`.

## `--json` caveat

A streaming REPL is not machine-readable by nature. `--json` applies only to
the pre-REPL failure paths (non-TTY stdin, model verification errors) — the
REPL itself is always human-formatted (stderr carries the UI; stdout stays
reply text). Scripted one-shot use belongs to `selora run --json`
([run.md](run.md)).

## `--debug`

Debug mode logs the request line (`→ POST /v1/chat/completions …`) and the
response status through the redacting printer; the Authorization header is
never printed, and the request body carries no secrets.
