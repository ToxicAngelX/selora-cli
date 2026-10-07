# `selora chat [--model <id>] [--safe] [--yes]`

Interactive streaming chat session with a model — and, since v0.3, the agent
REPL: every message runs the full tool loop (permission-gated) with a
galaxy-themed UI. `run`'s one-shot pipeline, but conversational. Since v0.6
the conversation is **crash-safe** (saved after every completed turn) and
messages can carry **images**.

```
✓ Connected to glm-5.3-flash (GLM 5.3 Flash)
glm-5.3-flash · ~/project
⏸ manual mode on · ? for shortcuts
❯ create a folder called Projects on my desktop
● CreateDir(desktop/Projects)
┌─ create_dir(desktop/Projects)
│   outside the project root:
│   /Users/ada/Desktop/Projects
│   create /Users/ada/Desktop/Projects — recursive
└─ Allow? [y]es / [n]o / [a]lways this session
y
  · outside access granted for this session: /Users/ada/Desktop
  ⎿ created /Users/ada/Desktop/Projects
Done — the folder is on your desktop.
  Tokens: 6,055 · Cost: $0.018
❯ /exit
· Session: 1m 12s · 1 request · 6,055 tokens · $0.018 · 1 file change
✓ Session ended
```

## Workspace trust (v0.8)

The first time chat starts in a folder that is not yet trusted, a one-time
safety check runs before the banner and the REPL (see
[trust.md](trust.md) for the screen and the `selora trust` command). Trusting
persists (`trusted.json`, mode 0600, in the config dir) — asked once per
folder. Non-TTY stdin, `--json`, `--yes`, NO_COLOR and TERM=dumb skip it
entirely; `--yes` implies trust for the session without persisting anything.
Trust skips the question only — every per-tool permission gate below is
unchanged.

## The UI (v0.5)

- **Startup screen** (interactive terminals only — never `--json`, never
  non-TTY): the SELORA logo in a per-character sweep of the theme gradient,
  surrounded by a sparse twinkling starfield (different every launch), plus
  tips (two pinned, one rotating per launch). The v0.4 info box
  (version/model/cwd/plan) is gone — the prompt's status lines carry that
  context. Set `SELORA_NO_ANIMATE` (any value) to skip the animation; it
  also skips automatically on NO_COLOR/TERM=dumb/non-TTY/`mono` and on
  terminals too short to redraw. Under 60 columns the block logo collapses
  to a compact one-liner.
- **Pinned ambient banner**: on a color-capable TTY with enough rows, the
  logo/starfield is pinned to the TOP of the screen — the transcript scrolls
  in a region below it (DECSTBM) while the banner keeps twinkling forever at
  a slow ambient rate (one redraw every 1.6s: a rotating third of the stars
  goes bright, and the gradient drifts a full cycle in about two minutes).
  Honest tradeoff: lines that scroll out of the region are NOT added to the
  terminal's scrollback (the conversation itself is safe — it auto-saves to
  `.selora/sessions/chat.json`, see [History](#history-v06-crash-safe)). Opt out with `SELORA_NO_ANIMATE` (or `mono` /
  NO_COLOR) for the classic inline screen that leaves scrollback intact.
  On exit the banner stays as a closing card — the session summary prints
  below it and the shell prompt follows clean (a bare DECSTBM reset homes the
  cursor per spec, which would overprint the art).
- **Prompt**: a dim context line (`model · cwd · tokens`), a dim mode line
  (`⏸ manual mode on · ? for shortcuts`), and a gradient `❯` marker. An
  empty Enter reprompts with the bare marker — the status lines print once
  per real turn, never duplicated.
- **Permission modes**: shift+tab at the prompt cycles `manual` (every tool
  call asks) → `acceptEdits` (reads and project file edits run without
  asking; shell commands and outside-root access still ask) → `auto` (every
  tool runs — except deletions, which always ask, in every mode) → `plan`
  (v0.9: reads run; every mutating call is denied and recorded as a proposal
  instead — see [Plan mode](#plan-mode-v09)). `--safe`
  pins a read-only `safe` display mode (write/exec tools don't exist, so
  there is nothing to cycle); `--yes` starts in `auto`. `?` at the prompt
  lists the shortcuts.
- **Thinking**: reasoning deltas are never printed as text — while the model
  thinks, the spinner shows a shimmering `✦ Thinking…`; the reply streams
  live as soon as content starts. Streamed text always stops the spinner
  outright, and UI lines (footers, tool rows, notices) erase its row first
  and let it redraw below — the two can never glue together on one line.
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
- **Command menu (v0.7)**: typing `/` at the prompt opens an inline menu of
  the slash commands right under the input line — `↑`/`↓` move the highlight,
  more keystrokes filter it (prefix first, then substring, case-insensitive:
  `/cl` narrows to `/clear`), `Tab`/`Enter` runs the highlighted command, and
  `Esc` (or `Ctrl+C`) dismisses the menu and leaves the typed text alone, so
  blind-typing a full command always works. An exact match + Enter runs the
  typed command directly. The menu, `/help`, and dispatch share one command
  registry — they cannot drift apart.
- **`@` path completion (v0.7)**: the same engine completes file paths after
  `@` — entries from the project root (or the typed subdirectory) filtered as
  you type, directories offered with a trailing `/` (selecting one lists one
  level deeper), image files highlighted, the listing capped at 12 rows with
  a `+N more — keep typing` hint. `Tab`/`Enter` completes — completing an
  already-complete path (the typed token IS the file) submits as usual, so a
  fully typed path never eats an Enter — and paths with spaces are inserted
  backslash-escaped so the image tokenizer reads them as one token.
- **`/model` picker (v0.7)**: `/model` with no arguments lists the available
  models as an arrow-key menu (current model pre-selected); Enter verifies
  and switches exactly like `/model <id>`, Esc keeps the current model. On a
  non-raw stdin it stays the plain current-model line.
- All of the v0.7 menu machinery is **TTY-only**: piped stdin, `--json`,
  NO_COLOR, and TERM=dumb never open a menu — typing full commands behaves
  exactly as it always has.
- **History search (v0.9)**: `Ctrl+R` at the prompt opens a search over this
  session's sent prompts plus every persisted session of the project (the
  same store `selora resume` reads) — newest first, deduped, filtered as you
  type (case-insensitive substring), `↑`/`↓` to move. `Enter` **inserts** the
  pick at the prompt (never sends), `Esc` cancels and restores the line you
  were typing. Same TTY-only gates as the menu; with no history the key is
  inert.
- **`!` shell escape (v0.9)**: `! <cmd>` runs the command in the project root
  without leaving chat — output folds to a dim block (last 40 lines +
  `… N more lines`), the exit code prints (non-zero highlighted), and nothing
  is ever sent to the model. No permission gate: you typed it — same trust as
  your own terminal. While a turn streams a `!` line is refused with a
  one-line notice (never queued); `\!` escapes a literal leading `!`;
  Ctrl+C while a `!` command runs kills the command, not the session.
- **Queued prompt cap (v0.9)**: at most ONE line queues while a turn streams
  (`· queued — runs when this turn finishes`); a second is discarded with
  `· one prompt already queued — it runs next` and a dim echo of the dropped
  line. Aborting the turn (Ctrl+C) clears the queued line too. Typing
  mid-turn never echoes onto the spinner's row — when the queued line runs it
  is replayed as a `❯ …` row, so the transcript shows exactly what was sent.
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
`--safe` restricts the toolset to read-only tools; `--yes` starts the session
in `auto` mode (every tool runs without asking — except deletions, which
always ask). Turn cap: the project `selora.json` `agent.maxTurns`, else 25. The permission memory
("always this session", outside-root directory grants) lives in the session
process only. See [docs/agent.md](../agent.md) for the full sandbox model.

## Model resolution

`--model <id>` > the resumed session's model (an accepted resume offer, or
`selora resume`) > the configured default model (`selora model <id>`) >
`glm-5.3-flash`.

The model is **verified** via the public `GET /v1/models/:id` route (no auth
header — the pricing-bearing internal flavor) before the REPL starts. An
unknown id prints the backend's honest 404 message (`Model not available`)
plus a `selora models` hint and exits 1 — the REPL never opens on a bad
model.

Chat authenticates with the **stored API key only**. With no stored key the
command exits 1 with `You are not logged in. Run: selora login`.

## Images (v0.6)

Type `@<path>` in a message to attach a local image — or drag a file onto the
terminal (both drag shapes work: `@"C:\my dir\a.png"` quoted and
`@/tmp/my\ shot.png` backslash-escaped). On a TTY, `@` also opens path
completion as you type (v0.7 — see [The UI](#the-ui-v05)):

```
❯ what is in @screenshot.png compared to @mockup.webp
[image: screenshot.png, 212.8 KB]
[image: mockup.webp, 96 KB]
```

- Formats: **png, jpg, jpeg, webp, gif** (the extension decides — a token
  counts as an image reference only when it starts with `@` and ends in one of
  these; `@channel` and `@notes.md` stay literal text, and `\@` types a
  literal `@`).
- Each file must exist and be at most **4 MB** (checked before encoding — a
  bigger file would only 413 at the gateway). At most **4 images** per
  message.
- The image is base64-encoded as a `data:` URL and sent as an `image_url`
  content part alongside your text. The transcript shows only the
  `[image: name, KB]` marker — base64 never prints.
- A bad reference (missing file, too large, too many) is a friendly error and
  **nothing is sent** — fix the line and retype it.

## Slash commands

Type `/` at the prompt for the interactive menu (v0.7 — see above), or just
type the command:

| Command         | Effect                                                                        |
| --------------- | ----------------------------------------------------------------------------- |
| `/help`         | list the slash commands                                                       |
| `/model`        | show the current model (on a TTY: the arrow-key model picker)                 |
| `/model <id>`   | verify `<id>` via `/v1/models/:id`, then switch (404 keeps the current model) |
| `/theme`        | show the current theme                                                        |
| `/theme <name>` | switch (galaxy, nebula, aurora, mono) — saved to the global config            |
| `/clear`        | clear the conversation history                                                |
| `/tools`        | list the tools available this session (and the permission mode)               |
| `/permissions`  | show what is auto-allowed this session (memory-only state)                    |
| `/plan`         | show the plan-mode proposal list (numbered, newest last)                      |
| `/plan clear`   | empty the proposal list                                                       |
| `/cost`         | session totals: requests, tokens, cost                                        |
| `/exit`         | end the session (Ctrl+D at the prompt also works)                             |

Empty lines re-prompt with the bare `❯` marker (the status lines print once
per real turn). `?` at the prompt lists the keyboard shortcuts. Unknown slash
commands print a hint.

## Plan mode (v0.9)

The fourth permission mode (`◈ plan mode on · ? for shortcuts`): the agent
explores freely — read/search/web tools run without asking — but **nothing
mutating executes**. Every write/edit/exec/remove call the model attempts is
denied before even its dry run, recorded as a numbered proposal, and the
model is told `plan mode: proposal recorded — switch modes (shift+tab) to
execute` so the conversation continues as a planning session.

- `/plan` prints the proposals (numbered, newest last); `/plan clear` empties
  the list. The list survives mode switches — plan, review, then shift+tab to
  `acceptEdits` or `auto` and re-ask to execute.
- Plan denials are not failures: the 3-consecutive-failure circuit breaker
  never counts them, and the run never stops early because of a proposal.
- Deletions keep their always-ask behavior in every mode; plan mode simply
  never gets that far (the proposal is recorded instead).

## Per-reply footer

After each turn, a gray footer appears **only if the usage chunk actually
arrived** — real numbers only, never invented: `  Tokens: 6,055 · Cost: $0.018`.
Sub-dime costs keep 3 decimals. No usage chunk → no footer.

## Ctrl+C behavior

- **During a stream**: aborts the in-flight request, prints
  `· Request cancelled — session kept`, drops the queued prompt (v0.9), and
  returns to the prompt. The aborted turn is dropped from the history
  entirely (retry starts clean) and never reaches the session file.
- **During a `!` command** (v0.9): kills the command (SIGINT, SIGKILL if it
  lingers) and returns to the prompt.
- **At the prompt** (nothing in flight): exits the session cleanly. If a
  menu/search is open, Ctrl+C only closes it (same as Esc) — the next Ctrl+C
  exits.

Failed turns (429 / 402 / network / in-band stream errors) are likewise
dropped from history; the error is rendered (`✗ <backend message verbatim>`)
and the REPL stays alive. The one fatal case is authentication (401
revoked/invalid key): the session exits 1 with the backend's verbatim
rotation message.

## Non-interactive use

`selora chat` needs an interactive terminal. With non-TTY stdin it prints
`✗ selora chat needs an interactive terminal — use: selora run "<prompt>"`
and exits 1. Scripted one-shot use belongs to `selora run` ([run.md](run.md)).

## History (v0.6: crash-safe)

The conversation is **saved after every completed turn** to the project-local
`.selora/sessions/chat.json` (atomic tmp+rename write — a kill mid-write can
never corrupt the previous save). A crash, a killed terminal, or a dead
laptop loses nothing that completed. Aborted and failed turns are still
dropped entirely — a half-finished turn would corrupt the wire history.

- **Resume offer**: a bare `selora chat` with a saved non-empty session asks
  once, `Resume the previous session? (N messages, updated …) [y/N]` — one
  keystroke, never a silent auto-resume. Any other answer starts fresh (the
  file is replaced on the next completed turn). The resumed session's model
  is used unless `--model` overrides it.
- **`selora resume [name]`** is the explicit form — any saved session
  (including `selora run --session <name>` ones), no question asked. See
  [resume.md](resume.md).
- `/clear` clears the saved file too — a cleared conversation is not offered
  again.
- The exit summary points at the save when there is one:
  `· Conversation saved — resume it with: selora resume`.

Each turn still sends the full history (user + assistant + tool messages of
prior turns) as the `messages` array of the request — nothing else leaves the
machine.

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
