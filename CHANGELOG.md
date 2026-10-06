# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
