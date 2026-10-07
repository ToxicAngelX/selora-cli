# Changelog

## 1.2.0 — context meter + auto-compaction

- **Context meter** — a live `ctx ▰▰▱▱ 62% · 18,500/30,000` line in the prompt
  block: estimated tokens vs the budget, gradient fill that turns warning at
  75% and error at 90%.
- **Auto-compaction** — at 90% of the budget the oldest turns fold into ONE
  summary message (cheap summarizer call; `agent.compactModel` in selora.json
  picks the model). Whole-turn folding keeps the wire shape valid (tool calls
  keep their results); the last 6 messages are always kept verbatim; fails
  soft (a broken summarizer never eats the conversation). An animated
  `⏳ compacting context` pulse plays while it runs.
- Config: `agent.contextTokens` (default 30000), `agent.compactModel`.

## 1.1.0 — selora update

- **`selora update`** — self-update: reads npm's `latest` dist-tag, compares
  with the running version, and (with `--yes`) installs through your own npm.
  `--check` reports only. The default never installs — it prints the exact
  command, like every other permission-gated action in the CLI.

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-10-07

**Subagents.** The model can delegate self-contained tasks to helper agents —
nested agent loops with their own fresh context. Plus v0.9's stability fixes
landed from the pty harness findings. No new runtime dependencies.

### Added

- **`spawn_agent` tool**: the model delegates a task to a helper agent — a
  nested `runAgentLoop` with a fresh `[user: task]` history, the parent's
  toolset minus `spawn_agent` (no recursion), the same cwd, the SAME
  interactive permission gate and session memory (an `a` answer or an
  outside-dir grant carries into the helper). The task string is all the
  helper sees; its final report is the tool result fed back to the parent.
  Optional `tools: [...]` restricts the helper's toolset. Capped at 12 turns.
  `kind: exec` + always-asks (even in auto mode — a helper can do anything
  its tools allow). Activity lines (`· sub started: …`, `sub: → read_file(x)`,
  `· sub finished (N turns): …`) stream into the parent transcript; the
  helper's tokens fold into the session totals. `--safe` and `run --json`
  without `--yes` exclude it.

### Fixed (from the v0.9 pty harness)

- the trust screen's "No, exit" hung forever: `pickFromList` left raw stdin
  in flowing mode (a referenced tty handle) — cleanup now pauses stdin
- after trusting, the REPL was dead: the prompt router now resumes stdin on
  attach
- chat now wires the loop's `onActivity` lines (`· outside access granted
  for this session: …`) which printed nowhere in the REPL
- terminal width 0 (harness/CI ptys) falls back to 80 columns everywhere

## [0.9.0] - 2026-10-07

History search, the `!` shell escape, plan mode, a single queued prompt, and
a stability pass. No new runtime dependencies (still exactly `commander` +
`picocolors`).

### Added

- **Ctrl+R prompt-history search**: at the chat prompt, Ctrl+R opens an
  interactive search over this session's sent prompts PLUS every persisted
  session of the project (the same `.selora/sessions/` store `selora resume`
  reads) — newest first, deduped, case-insensitive substring filter, arrows
  to move. Enter (or Tab) **inserts** the pick at the prompt — it is never
  sent for you — and Esc cancels, restoring the line you were typing. Long
  prompts clamp to the terminal width in the list (the full text inserts).
  Non-TTY / `--json` / NO_COLOR / TERM=dumb: the key is inert, never blocks.
- **`!` one-shot shell escape**: `! npm test` at the chat prompt runs the
  command in the project root without leaving the session. Output renders as
  a dim folded block (the last 40 lines + `… N more lines`), the exit code is
  shown (non-zero highlighted), and the command + output are **never sent to
  the model**. Deliberately no permission gate — you typed it, same trust as
  your own terminal (unlike the agent's `run_command`, which executes
  model-chosen commands and keeps its gate). While a turn streams, a `!` line
  is refused with a one-line notice and never queued. `\!` escapes a literal
  leading bang. Ctrl+C mid-`!` kills the command (SIGINT, then SIGKILL if it
  lingers) instead of exiting the session.
- **Plan mode** — the 4th shift+tab mode (`manual → acceptEdits → auto →
  plan`, status line `◈ plan mode on · ? for shortcuts`). Read/search tools
  run normally; every mutating tool call is NOT executed — the loop denies it
  ("plan mode: proposal recorded — switch modes (shift+tab) to execute" goes
  back to the model) and records the tool's label as a proposal. `/plan`
  shows the numbered list (newest last), `/plan clear` empties it; the list
  survives mode switches so you can plan, review, then shift+tab to
  acceptEdits/auto and re-ask.

### Changed

- **The shift+tab cycle gained a fourth mode** (plan). The v0.5 cycle-order
  tests were updated for the new order — an intentional spec change, not a
  regression; manual/acceptEdits/auto semantics are unchanged.
- **The mid-turn input queue is capped at ONE** (was: unbounded). The first
  line typed while a turn streams queues with `· queued — runs when this turn
  finishes`; a second prints `· one prompt already queued — it runs next`,
  echoes the discarded line dimly, and drops it — never queued, never sent.
  Ctrl+C aborting a turn also clears the queued line.

### Fixed

- A renderer exception mid-turn can no longer kill the REPL: the turn
  degrades to raw unstyled text with a one-line notice and the session
  continues. A slash command that throws now fails with a `✗` line instead of
  crashing the session.
- Split multibyte keypresses (a UTF-8 character arriving across two stdin
  chunks) reassemble correctly in the prompt router instead of landing as
  replacement characters; partial/unknown escape tails are held briefly, then
  ignored gracefully.
- Killing the CLI mid-turn (SIGINT, and by extension SIGTERM: auto-save is an
  atomic tmp+rename after each COMPLETED turn) always leaves a valid,
  parseable session file containing exactly the completed turns — pinned by a
  test.

## [0.8.0] - 2026-10-07

The workspace trust screen, and the auto-mode outside-access fix. No new
runtime dependencies (still exactly `commander` + `picocolors`).

### Added

- **Workspace trust screen**: `selora chat` (and `selora resume`) in an
  untrusted folder now opens with a Claude-Code-style check before the REPL —
  the folder path, a one-line safety note, and an arrow-key menu (reusing the
  v0.7 picker engine): `1. Yes, I trust this folder` / `2. No, exit`. Enter
  trusts and continues; "No" or Esc prints one short line and exits 0.
  Trusting **persists** (`trusted.json`, mode 0600, in the config dir) — the
  question is asked once per folder, and paths are stored realpath-canonical
  so symlinked spellings recognize the same folder. Non-TTY, `--json`,
  `--yes`, NO_COLOR and TERM=dumb never see the screen (pipelines never
  block; `--yes` implies trust for the session and persists nothing).
- **`selora trust [add <dir> | remove <dir>]`**: manage the trusted list by
  hand — no args lists it, `add`/`remove` resolve the real absolute path
  first (missing folders get a friendly error). `--json` supported.

### Fixed

- **Auto mode could never touch paths outside the project root** (the Windows
  bug): the mode asker auto-answers outside-path requests with a plain
  `allow`, but the loop only granted the directory on `allow-session` — so
  every approved outside call then failed the real run with "outside the
  project root and access was not granted". Now ANY approved outside answer
  (a manual `y` included) grants the touched directory for the session before
  the real run, first touch printing
  `· outside access granted for this session: <dir>` — mirroring `--yes`.
  Deletions (`neverAutoAllow`) still ask every time, in every mode.
- Packaging: `prepublishOnly` builds before publish (a publish without a
  build can no longer ship a tarball missing `dist/index.js` — npm used to
  just warn `bin[selora] script name dist/index.js was invalid and removed`),
  and `repository` uses the object form (`npm pkg fix`).

## [0.7.0] - 2026-10-06

The command palette. No new runtime dependencies (still exactly `commander` +
`picocolors`).

### Added

- **Slash-command menu in chat**: typing `/` at the prompt opens an inline
  menu under the input line listing the slash commands with their
  descriptions, rendered in the active theme. `↑`/`↓` move the highlight,
  typing filters (prefix first, then substring, case-insensitive), `Tab` or
  `Enter` runs the highlighted command, `Esc` or `Ctrl+C` closes the menu and
  leaves the typed text untouched. An exact match + Enter runs the typed
  command directly.
- **`@` path completion**: after `@`, the same engine lists matching
  files/dirs from the project root — prefix+substring fuzzy, directories
  offered with a trailing `/` that completes one level deeper, image
  extensions highlighted, capped at 12 rows with a `+N more — keep typing`
  hint. Completions with spaces are inserted backslash-escaped so the image
  tokenizer reads them as one token.
- **`/model` picker**: `/model` with no arguments lists the available models
  as an arrow-key menu (current model pre-selected); Enter verifies and
  switches exactly like `/model <id>`, Esc keeps the current model.
- The menu, `/help`, and command dispatch now share **one slash-command
  registry** — the three cannot drift apart. Every command's output is
  byte-identical to v0.6.

### Fixed

- The prompt marker no longer turns into readline's default `> ` on the first
  backspace/edit (readline now knows the real prompt string, so its repaints
  redraw `❯ `).
- After a permission menu, the prompt returns to raw mode — per-key editing
  and history (arrow keys) kept degrading to cooked mode until the next
  permission prompt.

### Notes

- The menu machinery is TTY-only: piped stdin, `--json`, NO_COLOR, TERM=dumb,
  and raw-incapable stdin behave exactly as v0.6 (typing full commands always
  works). The menu also stays out of the way while a reply streams and while
  the permission menu or `/model` picker owns the keyboard.

## [0.6.0] - 2026-10-06

Crash-safe conversations and image input. No new runtime dependencies (still
exactly `commander` + `picocolors`).

### Added

- **Crash-safe chat sessions**: `selora chat` auto-saves the conversation to
  `.selora/sessions/chat.json` after every COMPLETED turn (atomic tmp+rename)
  — a crash, kill, or dead laptop loses nothing that completed. Aborted and
  failed turns are still dropped entirely (a half-finished turn would corrupt
  the wire history). `/clear` clears the saved file too.
- **`selora resume [name]`**: reopen a saved conversation in the chat REPL
  with the full history restored — the most recent session by default, or a
  named one (including `run --session` files). The REPL keeps auto-saving
  under the same name; the session's model is used unless `--model`
  overrides. Bare `selora chat` with a saved session asks once:
  `Resume the previous session? (N messages, updated …) [y/N]` — never a
  silent auto-resume.
- **`run --session` survives interruption**: the agent loop reports the
  history at every resumable checkpoint, so Ctrl+C (now a clean abort, exit 130) or a mid-run failure saves the turns completed so far — previously the
  session was written only on full completion and an interrupt lost
  everything.
- **Image input**: `@<path>` tokens in a chat message or a run prompt attach
  local images (png/jpg/jpeg/webp/gif, ≤4 MB each, max 4 per message) as
  OpenAI `image_url` data-URL parts. Drag-and-drop paths work
  (`@"C:\my dir\a.png"` quoted, `@/tmp/my\ shot.png` escaped); `@channel`
  stays literal text and `\@` escapes the marker. The transcript shows
  `[image: name, 12.4 KB]` — base64 never prints. A bad reference (missing,
  too large, too many) errors before anything is sent.
- **Session format v2**: user messages may carry the multimodal parts array.
  v1 files load unchanged and are rewritten as v2 on the next save; a file
  with a newer version is reported and skipped, never mangled.
  `selora sessions list --json` gains a `resumable: true` marker per session.
- `selora run` accepts a **variadic prompt** — `selora run check @img.png`
  works unquoted.

### Fixed

- **`selora run` never exited on a real TTY** (latent since v0.2): the
  interactive permission asker eagerly opened a readline over stdin and
  nothing ever closed it, so the event loop stayed alive after the run
  finished. The asker now has a `close()` and `run` calls it. (Invisible in
  tests — piped stdin EOFs on its own; caught by the v0.6 pty verification.)
- The agent loop's max-turns stop replaced the wrong history entry (the last
  tool result instead of the dangling assistant tool_calls message), which
  would have saved a wire-invalid session; the answered tool round is now
  kept intact so a saved session resumes cleanly. The 3-consecutive-failure
  breaker similarly backfills an honest "not executed" tool result for any
  parallel calls it skipped.
- `selora chat --json` no longer echoes input to stdout (the JSON channel
  carries reply text only).

## [0.5.0] - 2026-10-06

### Added

- **Pinned ambient banner**: on a color-capable TTY the SELORA logo/starfield
  is pinned to the top of the screen (a DECSTBM scroll region confines the
  transcript below it) and keeps animating forever — a slow star twinkle plus
  a very slow gradient drift, one redraw every 1.6s. `SELORA_NO_ANIMATE`,
  NO_COLOR/TERM=dumb, the `mono` theme, non-TTY streams and short terminals
  all fall back to the classic inline screen. Honest tradeoff: lines that
  scroll out of the region are not kept in the terminal's scrollback.
- **Permission modes with a status line**: the prompt now shows
  `⏸ manual mode on · ? for shortcuts` (or the current mode). Three modes —
  `manual` (every tool call asks), `acceptEdits` (reads and project file
  edits run without asking; shell commands and outside-root access still
  ask), `auto` (everything runs — except deletions, which always ask).
  shift+tab cycles at the prompt; `--safe` shows a read-only `safe` display
  mode; `--yes` starts in `auto`. `?` at the prompt lists the shortcuts.
- **Spinner "Thinking…"**: while the model streams reasoning, the spinner
  pins a shimmering `Thinking…` word instead of the rotating galaxy phrases.

### Changed

- **Thinking text is no longer printed**: reasoning deltas used to stream as
  dim gray text on stderr (and visually duplicated across tool-call rounds).
  The spinner carries the thinking state now; the reply itself is unchanged.
- **The startup info box is gone**: version/model/cwd/plan duplicated what
  the prompt's status lines already say. The startup screen is now the
  logo/starfield plus the tips (two pinned, one rotating) — nothing else.
  This also drops the startup `/v1/me` call, so chat starts faster.
- **No more duplicated prompt status lines**: an empty Enter reprompts with
  the bare `❯` marker instead of reprinting the whole status block.

### Fixed

- Queued empty lines (typed ahead while a reply streams or after an error)
  no longer flood the screen with repeated `model · cwd · mode` status lines.

## [0.4.0] - 2026-10-06

### Added

- **Per-character gradient logo with a twinkling starfield**: the startup
  logo is now colored cell-by-cell (a horizontal gradient sweep with a slight
  diagonal skew) instead of per line, and about a third of the stars render
  bright on a rotating schedule.
- **Animated startup reveal**: on a color-capable TTY the startup screen
  plays a ~0.6s intro — the gradient sweeps across the logo while the stars
  twinkle — landing exactly on the static frame. `SELORA_NO_ANIMATE` (any
  value) opts out; it also skips automatically under NO_COLOR/TERM=dumb,
  non-TTY streams, the `mono` theme, and terminals too short to redraw.
- **`aurora` theme**: the cool sibling — emerald → teal → cyan → sky
  (`selora theme aurora`, or `/theme aurora` in chat).
- **Spinner shimmer**: the spinner word sweeps the theme gradient
  (hue rotates as it spins), ten rotating phrases (up from six), and a
  `ctrl+c to interrupt` hint on the status line.
- **Rotating tips**: the startup screen shows the two pinned tips plus one
  rotating tip picked per launch.

### Fixed

- `/theme <name>` in the chat REPL rebuilt the theme from the OLD palette —
  colors never actually changed until restart. It now applies immediately.
- The spinner kept the pre-switch theme after `/theme`; it now follows the
  live theme.

## [0.3.0] - 2026-10-06

The galaxy release: a Claude-Code-style terminal UI, and an agent that can
really operate on your machine from natural language — `create a folder
called Projects on my desktop` just works, no shell involved. No new runtime
dependencies (still exactly `commander` + `picocolors`; the theme uses raw
ANSI truecolor with honest 256/16-color fallbacks).

### Added

- **The galaxy theme** (`src/ui/theme.ts`): palettes galaxy (default),
  nebula, and mono; per-character and per-line gradients across
  cyan → indigo → violet → magenta; color-level detection (NO_COLOR /
  TERM=dumb / non-TTY → plain, truecolor signals + Windows Terminal →
  truecolor, 256color → nearest xterm-256, plain TTY → nearest ANSI-16).
  New command `selora theme [name]` (saved in the global config).
- **The startup screen** (`src/ui/logo.ts`): the SELORA block logo in the
  theme gradient, surrounded by a sparse random starfield (never overlapping
  the logo, different each launch), above a rounded info box (version, model,
  cwd, plan, tips). Under 60 columns: a compact one-line logo.
- **The chat/agent UI**: `selora chat` is now the agent REPL — every message
  runs the tool loop. Gradient `❯` prompt with a status footer
  (model · cwd · permission mode · tokens), streaming markdown renderer
  (headings, bold, inline code, bullets, fenced code blocks in dim boxes
  with language labels), tool calls as `● Read(src/api.ts)` + indented `⎿`
  result lines with content collapsed to 5 lines, colored red/green diffs
  (line numbers, 3 context lines) for edits, a galaxy spinner
  (`✦ Warping… 12s · tokens`) with clean Ctrl+C abort, slash commands
  (`/help /model /theme /clear /tools /permissions /cost /exit`), and an
  exit summary (duration, tokens, cost, files changed).
- **The arrow-key permission menu**: ❯ Yes / Yes, always this session / No
  (plus Edit command for exec tools) on a TTY, with an optional typed reason
  on No that goes back to the model. Piped stdin keeps the v0.2 line-based
  box byte-for-byte. Raw mode is held only while the menu is open; the REPL
  and the asker share ONE readline.
- **Machine-wide tools** (`src/agent/tools/fs.ts`): `list_dir`, `create_dir`
  (recursive mkdir), `move` (rename + EXDEV fallback), `copy`, and `remove`
  — all node:fs, no shell, on every platform.
- **User path resolution** (`src/agent/userPaths.ts`): `~`, `$VAR`/`${VAR}`/
  `%VAR%`, and the desktop/downloads/documents aliases (Windows checks the
  OneDrive Desktop redirect; a real project-relative folder is never
  shadowed). Paths outside the project root are no longer hard refusals:
  they resolve (symlink-safe) and go through a dedicated permission prompt
  showing the absolute path; `a` grants exactly that directory for the
  session; `--yes` implies the grant in memory.
- **remove safety**: always prompts (never "always this session"); folder
  deletes show item count + total size; hard refusals for drive roots, the
  home directory itself, and system folders (C:\Windows, /etc, /usr, … — the
  same guard protects create_dir/move/copy targets); trash move on Linux
  (XDG trash + .trashinfo) and macOS (~/.Trash), permanent delete with a
  loud warning on Windows (no shell-free trash exists there).
- **web_search / web_fetch** (opt-in): pluggable providers — Brave Search
  API, Tavily (keys via SELORA_SEARCH_API_KEY), or the keyless DuckDuckGo
  HTML fallback (SELORA_SEARCH_PROVIDER). Native fetch, 20s timeout,
  title/URL/snippet results, pages stripped to readable text (~40 KB cap).
  Disabled by default — the first attempted use prints the enable
  instructions (SELORA_WEB_TOOLS=1, project selora.json `agent.webTools`, or
  global config `webTools`); README privacy section updated accordingly.
- `read_file` gains `start_line` (line ranges); `edit_file` now requires the
  find string to match **uniquely** (ambiguous matches refused with the
  count) and shows a colored diff before applying.

### Changed

- `edit_file` (breaking, tool-behavior): first-occurrence replacement →
  unique-match-only. The model gets an honest error with the occurrence
  count when the match is ambiguous.
- `--safe` now offers the larger read-only set: `read_file`, `list_dir`,
  `glob`, `grep`, `web_search`, `web_fetch`, `git_status`, `git_diff`,
  `git_log` (web tools still gated by their own opt-in).
- `selora run` on a TTY renders the rich tool display (`●`/`⎿`, colored
  diffs in permission prompts); non-TTY keeps the v0.2 gray `→` lines.
- The agent loop accepts an injected `SessionAllows` (the chat REPL shares
  permission memory across turns) and a `renderDiff` hook; `onActivity` is
  now optional alongside the new `onToolStart`/`onToolResult` callbacks.
- Version 0.3.0; new docs: `docs/commands/theme.md`, rewritten
  `docs/agent.md` (outside-root permissions, remove safety, web tools,
  sample session) and `docs/commands/chat.md`.

### Known limitations

- **glob/grep stay project-root-scoped** — the outside-root permission model
  covers the file tools, not the search tools.
- **No Windows trash** — a shell-free recycle-bin move does not exist, so
  `remove` on Windows is permanent (with a warning); Linux/macOS move to
  trash.
- The markdown renderer is line-buffered: a partial first line renders when
  it completes (fenced blocks render as a unit when they close).
- The arrow-key menu needs a raw-mode-capable TTY; piped stdin falls back to
  the line-based y/n/a/e box.

## [0.2.0] - 2026-10-05

The agent release. `selora run` becomes a real, permission-gated agent loop;
the v0.1 tool skeleton is filled in with no breaking changes.

### Added

- **The agent loop** (`src/agent/loop.ts`): `selora run` attaches the tool
  definitions to the chat request; when the model actually requests tools on
  the wire (wire-based detection, never prompt sniffing), each call is
  decoded, permission-gated, executed, and its result is appended to the
  history — then the model streams again. Turn cap (default 25, `--max-turns`
  or `agent.maxTurns` in selora.json, 1–200), a 3-consecutive-failure
  circuit breaker (exit 1), and cumulative BigInt token/cost budget lines
  across turns.
- **Tools** (`src/agent/tools/`): `read_file` (200 lines default), `write_file`
  (full-content preview), `edit_file` (first occurrence, find/replace with
  context), `glob` and `grep` (dependency-free matcher, 500/200-result caps,
  5000-entry walk cap), `run_command` (spawn shell:false + quote-aware
  tokenizer, 60s default timeout, 8 KB output caps; Windows opt-in via
  `agent.allowWindowsCmd`), and git tools (`git_status`, `git_diff`,
  `git_log`, `git_commit`, `git_restore` — argv-only git, message never shell
  text; deliberately no push/pull/remote tool, no flag).
- **Path sandbox** (`src/agent/paths.ts`): project-root containment on the
  resolved path (absolute-inside, `..` refusals, symlink realpath re-checks,
  new-files-through-symlinked-dirs), 256 KB file cap, and the project's
  `context.exclude` globs are now READ (v0.1 stored them only) —
  `context.include` stays advisory.
- **Permission gate** (`src/agent/permissions.ts`): the box prompt
  (y/n/a[/e] for exec tools) with dry-run previews; `a` (always) is
  session-scoped memory only, never persisted, and for write/exec tools keyed
  to the exact label; denial feeds `Permission denied by user.` back to the
  model and the run continues. `--safe` (read-only toolset), `--yes`
  (non-interactive auto-approve), and `--json` mode rules (deny unless `--yes`).
- **Sessions**: `selora run --session <name>` saves/resumes conversations in
  `.selora/sessions/<name>.json` (atomic write, advance-only-on-completed-runs,
  slug-validated names) and the `selora sessions list|show|rm` command
  (show renders through the redaction chokepoint; rm requires confirmation).
- **Wire bridge** (`src/api/endpoints/chat.ts`): request-side `tools` +
  `tool_choice: "auto"` passthrough and `delta.tool_calls` fragment
  accumulation (arguments concatenated across chunks, keyed by index);
  assistant `tool_calls` echo and `tool` message serialization — the
  round-trip shape verified live against the gateway.

### Fixed

- `microToWireString`: fractional micro-units pad **start**, not end —
  18234 micro is `0.018234`, not `0.182340` (caught by the cumulative agent
  cost display).

### Changed

- `selora init`'s gray bullet now states the v0.2 truth (exclude globs are
  enforced; the optional hand-edited `agent` section).
- `run`'s `--json` output adds `turns`, `tools`, cumulative `charge`, and
  `stopped` on non-clean stops; `agent.maxTurns`/`allowWindowsCmd` are read
  from selora.json; model resolution gains the resumed-session tier.
- The registry stays import-empty by design: tools reach the loop via
  `builtinTools()`, never auto-registration (still test-pinned).

## [0.1.0] - 2026-10-05

First public release.

### Added

- **Commands**: `login` (email + password flow that creates a dedicated
  `selora-cli-<hostname>` API key, or `--key` validation for existing keys,
  including Google-only accounts), `logout` (local clear, optional
  server-side revocation with key-hint matching), `whoami`, `balance`
  (wallet + plan term + rolling 4h/weekly spend windows), `usage`
  (today/week/month totals with BigInt summation, all-time by-model table),
  `models` (pricing table, unauthenticated internal flavor), `model`
  (default model get/set/unset with verification), `keys`
  (list/create/revoke, one-time secret print), `chat` (interactive streaming
  REPL with model switching, abort handling, and per-reply usage/cost
  footer), `run` (one-shot streaming completion with `--json` buffering),
  `init` (project-local `selora.json`), `completion` (bash/zsh/fish scripts
  generated from the live commander program).
- **API client** (`src/api/client.ts`): the single HTTP chokepoint —
  request/response timeouts, retries with backoff on 429/5xx (honoring
  `Retry-After`), error mapping to a shared error envelope, and a debug
  printer that is always redacted. SSE streaming with time-to-first-byte
  timeout and clean user abort.
- **Key redaction** chokepoint: `sk-gw-…` keys never appear in logs or error
  paths; the one deliberate exception is the `keys create` one-time secret
  line. Pinned by a no-leak test suite.
- **Agent scaffold** (`src/agent/`): the `Tool` interface and registry —
  library-only in v0.1, registering nothing, with wire-based tool-call
  detection in `run` pointing at `docs/agent.md`. No `selora agent` command,
  no auto-execution, no prompt sniffing.
- **Shell completion** (`selora completion [bash|zsh|fish]`): scripts
  generated from the live program — commands, flags, and the `keys`
  sub-actions — with `$SHELL`-based defaulting and drift-breaking tests.
- **CI**: lint, typecheck, tests, build, and a tarball size gate on
  Node 20 across Linux, Windows, and macOS. Release workflow publishes to
  npm only through a protected environment requiring owner approval.

### Known limitations

- **Not an agent.** v0.1 never executes tools; the scaffold exists so the
  loop can be added without touching the command layer. See
  [docs/agent.md](docs/agent.md) for exactly what exists and what a v0.2
  agent needs.
- **No OS keyring.** The key lives in a 0600 config file; `SELORA_API_KEY`
  overrides it. A documented trade-off, not a hidden one — see
  [docs/api-gaps.md](docs/api-gaps.md).
- **The gateway sets some spec boundaries the CLI mirrors honestly rather
  than papers over**: usage ranges are fixed day windows; there is no
  "Available / API credits" split (wallet + spend windows is the real
  model); models expose no vision or context-length fields; window
  exhaustion arrives as 402 with the reset time only in the message text.
  Full list: [docs/api-gaps.md](docs/api-gaps.md).
- `selora chat` requires an interactive terminal; scripted one-shot use is
  `selora run`.
