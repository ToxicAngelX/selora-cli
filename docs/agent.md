# The selora agent (v0.3)

`selora run` and `selora chat` are real agents: they read, write, move, and
remove your files, run commands, drive git, and search the web — **every
action gated by a permission prompt you answer interactively**. This page
documents exactly what exists, how the sandbox and permission model work,
and what deliberately does not.

## How the loop works

```
selora run "<task>"        (or a message in selora chat)
  └─ stream a completion, the 18 tool definitions attached
       └─ the model requests tools on the wire (finish_reason "tool_calls")
            └─ decode the calls → permission gate (dry-run preview → y/n/a[/e])
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

Nothing executes without your answer. On a TTY the prompt is an **arrow-key
menu** (❯ Yes / Yes, always this session / No, plus **Edit command** for
exec tools) rendered on stderr — stdout stays clean reply text:

```
┌─ write_file(out.txt)
│   write out.txt — full content:
│   hello world
└─ Allow?
  ❯ Yes
    Yes, always this session
    No
  ↑/↓ or j/k to choose · Enter to confirm · Esc = No
```

- Choosing **No** (or pressing `n`/`Esc`) may be followed by an optional
  typed **reason** — it goes back to the model as
  `Permission denied by user. Reason: <your reason>`, so the agent can adapt.
  Without a reason the denial text is exactly `Permission denied by user.`
- Piped stdin keeps the v0.2 line-based box (answers read as lines:
  y/a/n/e; anything unrecognized denies; closed stdin denies safely).
- **Read tools** (`read_file`, `list_dir`, `glob`, `grep`, `web_search`,
  `web_fetch`, `git_status`, `git_diff`, `git_log`) prompt y/n/a with a
  one-line preview.
- **Write tools** (`write_file`, `edit_file`, `create_dir`, `move`, `copy`,
  `git_commit`, `git_restore`) show the **exact change** first: the full
  content to write, or a **colored diff** (red/green, line numbers, 3 context
  lines) for `edit_file`.
- **`remove`** never offers "always this session" — every delete asks, every
  time (see below).
- **`run_command`** additionally offers **Edit command** — you replace the
  command line before it runs; the replacement is re-prompted.
- **`a` (always this session)** lives in the running process's memory ONLY.
  It is never written to disk, never persists across runs, and for write/exec
  tools it covers exactly the same label. Read tools key by tool name.
- **A denied tool is not an error.** The denial goes back to the model as
  the tool result and the conversation continues.
- Every first execution is a **dry run**: the tool reports what would happen
  (the preview above); only your approval triggers the real execution. A dry
  run that already fails (bad path, missing file) never prompts.

### Outside the project root (v0.3)

File tools resolve paths through a small expansion layer first: `~`,
`$VAR`/`${VAR}`/`%VAR%`, and the aliases **desktop**, **downloads**,
**documents** (on Windows the OneDrive Desktop redirect wins when it exists;
a real project-relative folder of the same name is never shadowed).

A path that resolves OUTSIDE the project root is not a hard refusal anymore
— it is a permission:

```
┌─ create_dir(desktop/Projects)
│   outside the project root:
│   /Users/ada/Desktop/Projects
│   create /Users/ada/Desktop/Projects — recursive
└─ Allow? [y]es / [n]o / [a]lways this session
```

- `y` allows exactly this one operation.
- `a` grants exactly **one directory** — the target's parent (or the target
  itself when it is an existing directory) — for the session. Access to
  anything outside that directory still prompts.
- `--yes` implies the grant (in memory) for everything the toolset allows.
- Symlinks are always resolved first, so the prompt shows the real
  destination and a link cannot smuggle a path past a grant.
- `glob`/`grep` stay project-root-scoped (documented limit, below).

### Non-interactive modes

- `--yes` auto-approves everything the toolset allows — combine with `--safe`
  to auto-approve reads only.
- `--safe` restricts the agent to the read-only tools; write/exec tools are
  not even offered to the model.
- `--json` cannot prompt: without `--yes` every tool is denied (the denial
  is fed back so the model can answer without tools); with `--yes` tools
  execute and the JSON output includes a `tools` array with each event.

## The tools

Inside the project root, all filesystem tools keep the v0.2 sandbox: paths
resolve and re-check containment (`..` climbs and symlinked escapes are
refused), files over **256 KB** are refused by read/search tools, and the
project's `context.exclude` globs are enforced.

| Tool                                  | What it really does                                                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `read_file`                           | Reads a text file — `start_line`/`max_lines` line ranges (default first 200 lines). ~, env vars, and aliases expand; outside-root paths need permission.                                                                                                           |
| `write_file`                          | Writes a file, creating parent directories. The prompt shows the full content.                                                                                                                                                                                     |
| `edit_file`                           | Replaces a find string that must match **UNIQUELY** (ambiguous matches are refused with the count). The prompt shows a colored diff.                                                                                                                               |
| `list_dir`                            | Directory listing, dirs first, with file sizes. 500-entry cap.                                                                                                                                                                                                     |
| `create_dir`                          | Recursive mkdir (the desktop-folder tool). Refuses system folders.                                                                                                                                                                                                 |
| `move`                                | `rename` with an EXDEV fallback (copy+remove across devices). Moves into an existing directory keep the basename. Refuses moving a dir into itself.                                                                                                                |
| `copy`                                | File copy or recursive directory copy, same into-dir semantics.                                                                                                                                                                                                    |
| `remove`                              | Delete a file or folder — see the safety section below.                                                                                                                                                                                                            |
| `glob`                                | Finds files by fnmatch-style pattern (`*`, `**`, `?`, `[...]`), no dependencies. Walk capped at 5000 entries, results at 500. **Project-root-scoped.**                                                                                                             |
| `grep`                                | Line regex search (`path:line:text`), optional glob filter. 200-match cap; binary and >256 KB files are skipped (counted). **Project-root-scoped.**                                                                                                                |
| `run_command`                         | Runs a command — `spawn` with `shell:false` ALWAYS, arguments from a quote-aware tokenizer (no shell ever runs, metacharacters are literal). 60s timeout default (up to 300s), output capped at 8 KB per stream. Non-zero exits are honest results the model sees. |
| `web_search`                          | Opt-in web search (see below). Returns title/URL/snippet; the model is instructed to cite URLs.                                                                                                                                                                    |
| `web_fetch`                           | Opt-in fetch of one web page as readable text (HTML stripped, ~40 KB cap).                                                                                                                                                                                         |
| `git_status` / `git_diff` / `git_log` | Read-only git views via `spawn("git", args)`.                                                                                                                                                                                                                      |
| `git_commit`                          | Stages the listed files and commits — the message is an argv element, never shell text.                                                                                                                                                                            |
| `git_restore`                         | `git checkout -- <path>` for exactly one path.                                                                                                                                                                                                                     |

**Windows:** `run_command` refuses by default — opt in per project with
`"agent": {"allowWindowsCmd": true}` in `selora.json` (it then spawns
`cmd.exe /d /s /c` with `shell:false`). All other tools work everywhere and
use `node:fs` only — never a shell.

**git and the network:** there is deliberately NO tool that can push, pull,
fetch, or touch remotes — no flag, no escape hatch.

## remove safety

`remove` is the one tool that can destroy work, so it carries extra rules:

- **It always asks.** "Always this session" is not offered for `remove`; the
  loop never remembers an approval for it. (`--yes` auto-approves it like
  every other tool — but the preview still shows exactly what will be
  deleted, and the hard refusals below still apply.)
- **The preview shows the stakes**: the absolute path, the item count and
  total size of a folder, and whether it goes to the trash.
- **Trash when possible, without dependencies**: Linux moves to the XDG
  trash (`~/.local/share/Trash`, with a `.trashinfo`), macOS to `~/.Trash`.
  Windows has no shell-free trash — a shell would violate the no-shell rule —
  so deletes are **permanent** there, and both the preview and the result say
  so loudly. Pass `mode: "permanent"` for a permanent delete on any platform.
- **Hard refusals** (before any prompt): drive roots (`/`, `C:\`, `D:`), the
  home directory itself, and system folders — `C:\Windows`, `C:\Program
Files`, `C:\Program Files (x86)`, `C:\ProgramData`, `C:\System` on Windows;
  `/etc`, `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/boot`, `/dev`,
  `/proc`, `/sys`, `/System` on POSIX. Deleting _inside_ your home is allowed
  (that is where your files live) — deleting home itself is not.
- The same system-folder guard also protects `create_dir`, `move`, and
  `copy` targets: the agent cannot create or move things into `C:\Windows`.

## web_search / web_fetch (opt-in)

These tools talk to hosts **other than the Selora gateway**, so they are
off by default. The first attempt explains itself:

```
web_search: web tools are off — they send your query to a non-Selora host.
Enable: SELORA_WEB_TOOLS=1, or "agent": {"webTools": true} in selora.json,
or "webTools": true in the global config.
```

Providers (pluggable, native `fetch` only, 20s timeout):

- `SELORA_SEARCH_PROVIDER=brave` — Brave Search API (needs
  `SELORA_SEARCH_API_KEY`).
- `SELORA_SEARCH_PROVIDER=tavily` — Tavily (needs the key).
- default: **DuckDuckGo** (the no-key HTML endpoint) — works out of the box
  once the tools are enabled.

Results are title + URL + snippet (up to 8); `web_fetch` returns one page as
readable text (scripts/styles removed, entities decoded, ~40 KB cap).
`web_fetch` refuses non-http(s) URLs and non-text content types. See the
README's Privacy section for what leaves the machine.

## The exclude globs are read

`selora init` writes `context.include`/`context.exclude` globs into the
project `selora.json`. The agent enforces **`context.exclude`** for
read/search tools on paths inside the project (with the shipped defaults
`**/node_modules/**` and `**/dist/**` when there is no file).
`context.include` stays advisory — a hint of what matters, never a whitelist,
so the agent can still read `package.json` or `README.md`.

## Sessions

`selora run --session <name> "<prompt>"` keeps the conversation:

- State lives in `<project>/.selora/sessions/<name>.json` — project-local,
  visible, gitignore-able, written atomically (tmp + rename).
- A session **advances only on completed runs** — a run that dies mid-stream
  never writes.
- The next `--session <name>` run resumes the full wire-shaped history
  (including tool calls and results); the session's model is used unless
  `--model` overrides it.
- `selora sessions list` / `show <name>` / `rm <name>` manage them. `show`
  renders through the redaction chokepoint — key material an agent read into
  a conversation never prints.

## A sample session

```
$ selora chat
  ███████ ██████  ██       █████  ██    ██ ███████      ✦
  ██      ██   ██ ██      ██   ██  ██  ██  ██         ˚
  ...
  ╭──────────────────────────────────────────────────╮
  │ version  0.3.0                                   │
  │ model    glm-5.3-flash (GLM 5.3 Flash)           │
  │ cwd      ~/projects/website                     │
  │ plan     Supernova                              │
  │                                                  │
  │ /help for commands · Ctrl+C to stop a reply      │
  ╰──────────────────────────────────────────────────╯
✓ Connected to glm-5.3-flash (GLM 5.3 Flash)

❯ create a folder called Projects on my desktop
● CreateDir(desktop/Projects)
┌─ create_dir(desktop/Projects)
│   outside the project root:
│   /Users/ada/Desktop/Projects
│   create /Users/ada/Desktop/Projects — recursive
└─ Allow? [y]es / [n]o / [a]lways this session
  ❯ Yes
  ⎿ created /Users/ada/Desktop/Projects
Done — the `Projects` folder is on your desktop.

❯ make a file notes.md inside it with a short intro
● Write(desktop/Projects/notes.md)
┌─ write_file(desktop/Projects/notes.md)
│   outside the project root:
│   /Users/ada/Desktop/Projects/notes.md
│   write /Users/ada/Desktop/Projects/notes.md — full content:
│   # Project notes
│   ...
└─ Allow? [y]es / [n]o / [a]lways this session
  ❯ Yes, always this session
  · outside access granted for this session: /Users/ada/Desktop/Projects
  ⎿ wrote /Users/ada/Desktop/Projects/notes.md (128 B)

❯ read it back to me
● Read(desktop/Projects/notes.md)
  ⎿ read /Users/ada/Desktop/Projects/notes.md (5 lines, 128 B)
      # Project notes
      ...

❯ change the heading to say "Launch log"
● Edit(desktop/Projects/notes.md)
┌─ edit_file(desktop/Projects/notes.md)
│   1     1   # Project notes
│   2         -
│   3     2   - # Launch log
│   4     3   ...
└─ Allow? [y]es / [n]o / [a]lways this session
  ❯ Yes
  ⎿ edited /Users/da/Desktop/Projects/notes.md: replaced 1 occurrence

❯ remove the folder now
● Remove(desktop/Projects)
┌─ remove(desktop/Projects)
│   outside the project root:
│   /Users/ada/Desktop/Projects
│   remove /Users/ada/Desktop/Projects — 2 items · 2.1 KB
│   moves to trash (~/.Trash)
└─ Allow? [y]es / [n]o
  ❯ No
  └─ Reason (optional — sent to the model; empty line = none): keep it, I still need it
  ⎿ denied by user
Understood — I left `/Users/ada/Desktop/Projects` in place.

❯ search the web for the mdn markdown guide
● Search(mdn markdown guide)
  ⎿ searched the web (duckduckgo): 8 results
      Markdown Guide
        https://www.markdownguide.org
        ...
Here's the Markdown Guide: https://www.markdownguide.org — MDN's markdown
reference is at https://developer.mozilla.org/en-US/docs/…

❯ /cost
· Requests: 5 · Tokens: 41,204 · Cost: $0.119

❯ /exit
· Session: 4m 02s · 5 requests · 41,204 tokens · $0.119 · 2 file changes
✓ Session ended
```

(This transcript is illustrative — the starfield is random each launch, and
your terminal renders the theme's colors; here it is shown as plain text.)

## What deliberately does NOT exist

- **No auto-allow persistence.** "Always" answers and outside-root directory
  grants are session-scoped memory only; nothing permission-related is ever
  written to disk.
- **No network git** (push/pull/fetch/remote) — not behind a flag.
- **No web tools by default** — they are opt-in and name their hosts.
- **No prompt telemetry.** Nothing about your prompts, replies, or files is
  sent anywhere except the chat request itself (model + messages + tool
  definitions/results).
- **No OS keyring, no shell** — the key stays in the 0600 config file;
  commands run without a shell, always.
- **No tool result tampering.** Tool results go to the model verbatim (or as
  the honest failure text); the CLI never edits them.
- **glob/grep are project-root-scoped** — outside-root search is not offered
  (the outside-root permission model covers the file tools).
