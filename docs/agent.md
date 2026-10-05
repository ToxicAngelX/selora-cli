# The selora agent (v0.2)

`selora run` is a real agent since v0.2: it can read, write, and edit your
files, run commands, and drive git — **every action gated by a permission
prompt you answer interactively**. This page documents exactly what exists,
how the sandbox and permission model work, and what deliberately does not.

## How the loop works

```
selora run "<task>"
  └─ stream a completion, the 11 tool definitions attached
       └─ the model requests tools on the wire (finish_reason "tool_calls")
            └─ decode the calls → permission gate (dry-run preview → y/n/a/e)
                 └─ execute → append the tool results to the history
                      └─ stream again … until the model answers without tools
```

- **Wire-based, never prompt-sniffing.** Tool execution starts only when the
  model actually requests tools on the wire (`delta.tool_calls` chunks or
  `finish_reason: "tool_calls"`). The CLI never guesses from your prompt text.
- **Turn cap.** The loop runs at most 25 turns (configurable: `--max-turns`
  or `agent.maxTurns` in the project `selora.json`, 1–200). Hitting the cap
  stops with an honest gray line — nothing is silently truncated.
- **Failure breaker.** A failed tool feeds its error text back to the model
  (it may retry differently). Three **consecutive** failures abort the run
  with exit 1; one success resets the counter.
- **Budget guard.** Usage and cost are summed across turns with BigInt math:
  a per-turn footer and a cumulative `Agent totals: N turns · Tokens · Cost`
  line — real numbers only, only when the gateway actually sent them.

## The permission gate

Nothing executes without your answer. The prompt renders on stderr (stdout
stays clean reply text):

```
┌─ read_file(src/index.ts)
│   48 lines, 1.2 KB
└─ Allow? [y]es / [n]o / [a]lways this session
```

- **Read tools** (`read_file`, `glob`, `grep`, `git_status`, `git_diff`,
  `git_log`) prompt y/n/a with a one-line preview.
- **Write tools** (`write_file`, `edit_file`, `git_commit`, `git_restore`)
  show the **exact change** first: the full content to write, the
  find/replace with context, or the commit message and staged files.
- **`run_command`** additionally offers **[e]dit command** — you replace the
  command line before it runs; the replacement is re-prompted.
- **`a` (always this session)** lives in the running process's memory ONLY.
  It is never written to disk, never persists across runs, and for write/exec
  tools it covers exactly the same label — "always" for one write never
  silently approves a different one. Read tools key by tool name.
- **A denied tool is not an error.** `Permission denied by user.` goes back
  to the model as the tool result and the conversation continues.
- Every first execution is a **dry run**: the tool reports what would happen
  (the preview above); only your approval triggers the real execution.
  A dry run that already fails (bad path, missing file) never prompts.

### Non-interactive modes

- `--yes` auto-approves everything the toolset allows — combine with `--safe`
  to auto-approve reads only.
- `--safe` restricts the agent to the read-only tools; write/exec tools are
  not even offered to the model.
- `--json` cannot prompt: without `--yes` every tool is denied (the denial
  is fed back so the model can answer without tools); with `--yes` tools
  execute and the JSON output includes a `tools` array with each event.

## The tools

All filesystem tools are scoped to the project root (the working directory
at launch). Paths are resolved and re-checked: an absolute path must already
be inside the root, `..` climbs that escape are refused, and symlinks are
realpath-resolved and re-contained — a link pointing outside the project is
refused rather than followed out. Files over **256 KB** are refused by
read/search tools (the size is reported).

| Tool | What it really does |
| --- | --- |
| `read_file` | Reads a file's first 200 lines (1–10000 via `max_lines`). |
| `write_file` | Writes a file, creating parent directories. Prompt shows the full content. |
| `edit_file` | Replaces the FIRST occurrence of a find string. Prompt shows find/replace with context. |
| `glob` | Finds files by fnmatch-style pattern (`*`, `**`, `?`, `[...]`), no dependencies. Walk capped at 5000 entries, results at 500. |
| `grep` | Line regex search (`path:line:text`), optional glob filter. 200-match cap; invalid regexes are reported honestly; binary and >256 KB files are skipped (counted). |
| `run_command` | Runs a command — `spawn` with `shell:false` ALWAYS, arguments from a quote-aware tokenizer (no shell ever runs, metacharacters are literal). 60s timeout default (up to 300s), stdout/stderr capped at 8 KB each. Non-zero exits are honest results the model sees. |
| `git_status` / `git_diff` / `git_log` | Read-only git views via `spawn("git", args)`. |
| `git_commit` | Stages the listed files and commits — the message is an argv element, never shell text. |
| `git_restore` | `git checkout -- <path>` for exactly one path. |

**Windows:** `run_command` refuses by default — opt in per project with
`"agent": {"allowWindowsCmd": true}` in `selora.json` (it then spawns
`cmd.exe /d /s /c` with `shell:false` and an explicit args array). All other
tools work everywhere.

**git and the network:** there is deliberately NO tool that can push, pull,
fetch, or touch remotes — no flag, no escape hatch. Network git operations
stay with the human.

### The exclude globs are read now

`selora init` writes `context.include`/`context.exclude` globs into the
project `selora.json`. The agent enforces **`context.exclude`** for
read/search tools (with the shipped defaults `**/node_modules/**` and
`**/dist/**` when there is no file). `context.include` stays advisory — a
hint of what matters, never a whitelist, so the agent can still read
`package.json` or `README.md`.

## Sessions

`selora run --session <name> "<prompt>"` keeps the conversation:

- State lives in `<project>/.selora/sessions/<name>.json` — project-local,
  visible, gitignore-able, written atomically (tmp + rename).
- A session **advances only on completed runs** — a run that dies mid-stream
  never writes (a half-finished turn would corrupt the history).
- The next `--session <name>` run resumes the full wire-shaped history
  (including tool calls and results), and the session's model is used unless
  `--model` overrides it.
- `selora sessions list` / `show <name>` / `rm <name>` manage them. `show`
  renders through the redaction chokepoint — key material an agent read into
  a conversation never prints.

## What deliberately does NOT exist

- **No auto-allow persistence.** "Always" answers are session-scoped memory
  only; nothing permission-related is ever written to disk.
- **No network git** (push/pull/fetch/remote) — not behind a flag.
- **No prompt telemetry.** Nothing about your prompts, replies, or files is
  sent anywhere except the chat request itself (model + messages + tool
  definitions/results), exactly as in `chat`/`run`.
- **No OS keyring, no shell** — the key stays in the 0600 config file;
  commands run without a shell, always.
- **No tool result tampering.** Tool results go to the model verbatim (or as
  the honest failure text); the CLI never edits them.
