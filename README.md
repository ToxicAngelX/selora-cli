# selora

Open-source command-line client for the [Selora API gateway](https://api.selora.lol).
Log in, check your balance and usage, list models, manage API keys, chat
with models — streaming — and run a **permission-gated agent** that reads,
writes, moves, and removes your files, runs commands, drives git, and
searches the web, straight from the terminal. It is an independent codebase:
no website or IDE required.

v0.5 gives the CLI a **galaxy-themed terminal UI** (Claude-Code-style): an
animated starfield logo pinned at the top of the screen (per-character
gradient sweep + a starfield that keeps twinkling at a slow ambient rate),
a `❯` prompt with context and permission-mode status lines (shift+tab cycles
manual → accept-edits → auto → plan), streaming markdown rendering, `● / ⎿`
tool-call display, colored diffs, a shimmering spinner (thinking is shown as
an animation, never printed as text), and an arrow-key permission menu — with
four themes (`galaxy`, `nebula`, `aurora`, `mono`) and honest
NO_COLOR/non-TTY/`--json` fallbacks.

v0.6 adds **crash-safe sessions and image input**: chat auto-saves after
every completed turn and offers to resume on the next launch
(`selora resume [name]` reopens any saved session, `run --session` survives a
Ctrl+C mid-run with the completed turns intact), and `@<path>` attaches
images (png/jpg/webp/gif) to any chat or run message.

v0.7 adds the **command palette**: typing `/` at the chat prompt opens an
inline menu of the slash commands — arrow keys (or a few more keystrokes:
the filter is fuzzy) pick one, Tab/Enter runs it, Esc dismisses. `@` gets the
same treatment for file paths (dirs deepen with a trailing `/`, images are
highlighted), and `/model` with no arguments becomes an arrow-key model
picker. All of it is TTY-only — piped stdin, `--json`, and NO_COLOR behave
exactly as before.

v0.8 adds the **workspace trust screen**: the first time you run
`selora chat` in a folder, a one-time arrow-key check asks whether you trust
it (persisted per folder; `selora trust` manages the list; pipelines and
`--yes`/`--json` never see it).

v0.9 is the **power-user release**: `Ctrl+R` searches your prompt history
(past sessions included — Enter inserts, never sends), `! <cmd>` runs a
one-shot shell command without leaving chat (folded output, exit code shown,
never sent to the model), **plan mode** joins the shift+tab cycle (reads run,
every mutation is recorded as a proposal instead of executing — `/plan`
reviews the list), the mid-turn input queue is capped at one (a second
typed-ahead line is discarded, never silently stacked), and a renderer
exception can no longer kill the REPL.

Ask it things like _"create a folder called Projects on my desktop"_ and it
does it, no shell required.

## Requirements

- Node.js ≥ 20
- Linux, macOS, or Windows

## Install

```sh
npm i -g selora
```

Run it once without installing:

```sh
npx selora --help
```

From source:

```sh
git clone https://github.com/ToxicAngelX/selora-cli.git
cd selora-cli
npm ci && npm run build
npm i -g .
```

## Quickstart

```sh
selora login            # email + password (see below for Google-only accounts)
selora balance          # wallet + rolling spend windows
selora chat             # streaming REPL (Ctrl+C aborts a reply, Ctrl+D exits)
selora run "fix the TODO in src/api.ts"   # the agent: tools, permission-gated
```

`selora login` prompts for your email and password, then creates a **dedicated
CLI API key** named `selora-cli-<hostname>` on the server and stores only that
key locally — your password is never stored, and the login session token is
used in memory only and discarded. See [docs/commands/login.md](docs/commands/login.md).

**Google-only accounts** (no password) can't use that flow: the gateway
returns the same "Invalid email or password" for Google-only accounts as for
wrong passwords, so the CLI cannot detect it directly. Instead, create a key
in the Selora web console (selora.lol → Keys) and log in with it:

```sh
selora login --key      # prompts for the key (or pipe it: echo "$KEY" | selora login --key)
```

The key is validated against the API **before** anything is stored.

## Commands

| Command                               | Description                                                                   | Docs                                         |
| ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------- |
| `selora login`                        | log in with email + password (creates a CLI key), or validate an existing key | [login.md](docs/commands/login.md)           |
| `selora logout`                       | clear the stored API key (optionally revoke it server-side)                   | [logout.md](docs/commands/logout.md)         |
| `selora whoami`                       | show the account, plan, trial, and wallet for the stored key                  | [whoami.md](docs/commands/whoami.md)         |
| `selora balance`                      | show wallet balance, plan term, and rolling spend windows                     | [balance.md](docs/commands/balance.md)       |
| `selora usage`                        | show request/token/spend usage (today, this week, or this month)              | [usage.md](docs/commands/usage.md)           |
| `selora models`                       | list available models with pricing                                            | [models.md](docs/commands/models.md)         |
| `selora model [id]`                   | show the default model, or set it to `<id>`                                   | [model.md](docs/commands/model.md)           |
| `selora keys [list\|create\|revoke]`  | manage API keys (default: list)                                               | [keys.md](docs/commands/keys.md)             |
| `selora chat`                         | interactive agent REPL: tools, galaxy UI, permission menus, images            | [chat.md](docs/commands/chat.md)             |
| `selora run "<prompt>"`               | one-shot streaming completion with the agent tool loop (permissions gated)    | [run.md](docs/commands/run.md)               |
| `selora resume [name]`                | reopen a saved conversation in the chat REPL (default: the most recent)       | [resume.md](docs/commands/resume.md)         |
| `selora sessions [list\|show\|rm]`    | manage agent conversation sessions                                            | [sessions.md](docs/commands/sessions.md)     |
| `selora init`                         | write a project-local selora.json (model + agent context globs)               | [init.md](docs/commands/init.md)             |
| `selora theme [name]`                 | show or set the UI theme (galaxy, nebula, aurora, mono)                       | [theme.md](docs/commands/theme.md)           |
| `selora trust [add\|remove] [<dir>]`  | manage trusted workspaces for the chat trust screen                           | [trust.md](docs/commands/trust.md)           |
| `selora completion [bash\|zsh\|fish]` | print a shell completion script                                               | [completion.md](docs/commands/completion.md) |

Global flags on every command: `--json` (machine-readable output only),
`--debug` (request/response details, always redacted), `--api-url <url>`
(gateway base URL for this invocation).

## How Selora billing maps to this CLI

Selora's money model has two parts, and `selora balance` shows exactly that
split — it never merges them:

- **Wallet balance.** What `selora balance` calls `Wallet (plan purchases)`.
  Wallet funds exist to buy **plans** — they can _never_ pay for inference. A
  402 from the gateway never means "your wallet is empty", so the CLI never
  presents it that way.
- **Rolling spend windows.** The spendable inference capacity: a 4-hour window
  and a weekly window, each capped by your plan. When a window is exhausted
  the gateway returns 402 (not 429) with the reset time inside the message
  text; the CLI passes that message through verbatim and never invents a
  countdown.

A spec-correction worth knowing: some Selora documentation describes an
"Available / API credits" balance split. **That split does not exist in the
API.** The real fields are the wallet and the spend windows, and this CLI
renders those — see [docs/api-gaps.md](docs/api-gaps.md) for every place the
CLI deliberately shows only what the backend returns. Payment-wise, Selora
sells **memberships** (30-day plan terms), not credits.

## Auth & key storage

- During `selora login`, the session JWT from `POST /v1/auth/login` is held
  **in memory only** — used to create the CLI key, then discarded. It is never
  written to disk and never printed.
- What persists is the `sk-gw-` API key, in `config.json` (mode 0600) under
  the XDG config dir. v0.1 does **not** use an OS keyring — that would require
  native dependencies; this is a documented trade-off, surfaced at login time
  (see [docs/api-gaps.md](docs/api-gaps.md)).
- `SELORA_API_KEY` in your environment overrides the stored key (and is never
  written to disk). If both exist, the CLI says so.
- `SELORA_API_URL` or `--api-url` overrides the gateway base URL (default
  `https://api.selora.lol`). This is what makes the CLI work against a fork or
  another instance of the gateway.

## Default model

New sessions default to `glm-5.3-flash` — the cheapest model by output price,
chosen because chat is output-heavy. Change it with:

```sh
selora model gpt-5.2-mini     # sets the stored default (verified against /v1/models/:id)
```

Per-invocation: `selora chat --model <id>`, `selora run --model <id>`, or a
project `selora.json` (see below) for `run`.

## Trusted workspaces

The first time you run `selora chat` in a folder, a quick safety check asks
whether you trust it — the agent can read, edit, and run commands there:

```
Accessing workspace:

 ~/project

 Quick safety check: is this a folder you created or one you trust? Selora will be able to
 read, edit, and run commands here.

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel
```

- **Asked once per folder.** Trusting persists to `trusted.json` (mode 0600)
  next to `config.json` in the config dir; paths are stored realpath-canonical,
  so `~/proj` and a symlinked spelling of it are the same folder.
- **Pipelines never block.** Non-TTY stdin, `--json`, `--yes`, NO_COLOR and
  TERM=dumb skip the screen entirely (`--yes` implies trust for the session
  and persists nothing).
- Manage the list by hand: `selora trust` (list), `selora trust add <dir>`,
  `selora trust remove <dir>`.
- Trust only skips the one-time question — the per-tool permission gates
  (prompts, modes, outside-root session grants) are unchanged.

## The chat REPL at a glance

`selora chat` permission modes, cycled with **shift+tab** at the prompt:

| Mode          | Reads & search | File edits   | Shell commands | Deletions | Outside the project |
| ------------- | -------------- | ------------ | -------------- | --------- | ------------------- |
| `manual`      | ask            | ask          | ask            | ask       | ask                 |
| `acceptEdits` | run            | run          | ask            | ask       | ask                 |
| `auto`        | run            | run          | run            | **ask**   | run (grants the dir) |
| `plan`        | run            | **proposed** | **proposed**   | **proposed** | ask              |

`plan` executes nothing that mutates: the tool call is recorded as a
numbered proposal (`/plan` shows the list, `/plan clear` empties it) and the
model is told to keep planning. Review the list, then shift+tab to
`acceptEdits`/`auto` and re-ask. Deletions ask in **every** mode.

While a reply streams, at most **one** typed-ahead line queues
(`· queued — runs when this turn finishes`); a second is discarded with a
notice (echoed dimly, never sent), and Ctrl+C aborting the turn drops the
queued line too.

Also at the prompt:

- **Ctrl+R** — search past prompts (this session + every saved session of the
  project, newest first, deduped). Type to filter, arrows to move, **Enter
  inserts** the pick at the prompt — it is never sent for you. Esc cancels
  and restores the line you were typing.
- **`! <cmd>`** — run a shell command right there (`! npm test`): the output
  renders as a dim folded block (last 40 lines + `… N more lines`) with the
  exit code, and **nothing is sent to the model**. No permission gate — you
  typed it, same trust as your own terminal. Mid-turn a `!` line is refused
  (never queued); `\!` escapes a literal leading `!`.

## Subagents (v1.0)

The model can delegate a self-contained task to a **helper agent** — a nested
agent loop with its own fresh context:

- it sees **only the task string** you (the model) hand it, works in the same
  directory, and returns its final report as text
- it goes through the **same permission prompts** — an `a` answer or an
  outside-root grant carries into the helper, so it never silently mutates
  anything you would have been asked about
- every spawn asks (even in `auto` mode), shows the exact task + tool list,
  and is capped at 12 turns
- its activity streams into your transcript (`· sub started: …`,
  `sub: → read_file(x)`, `· sub finished (N turns): …`), and its tokens fold
  into the session totals
- helpers cannot spawn helpers (one level of delegation)

## Privacy

- **Zero telemetry.** No analytics, no crash reporting, no usage pings. By
  default the CLI talks to exactly one host: the Selora gateway.
- **The web tools are the one deliberate exception, and they are opt-in.**
  `web_search` / `web_fetch` (agent tools) send your query or a URL to a
  search provider / the page's host — never the Selora gateway. They are
  disabled until you enable them (`SELORA_WEB_TOOLS=1`,
  `"agent": {"webTools": true}` in selora.json, or `"webTools": true` in the
  global config), and their first attempted use prints that notice with the
  enable instructions. The search provider is pluggable
  (`SELORA_SEARCH_PROVIDER`: `brave` or `tavily`, keys via
  `SELORA_SEARCH_API_KEY`; default is the keyless DuckDuckGo HTML endpoint).
  The CLI never sends your files, history, or keys anywhere else.
- **Keys are never logged.** All debug output passes through a single
  redaction chokepoint before printing; the Authorization header is never
  printed. The one deliberate exception is `selora keys create`, whose entire
  purpose is printing the one-time secret the backend returns exactly once.
- Conversation state is sent nowhere except as the `messages` array of the
  next request. Since v0.6 it is also **saved locally**:
  `selora chat` auto-saves after every completed turn and
  `selora run --session <name>` saves at every completed step — all under the
  project's `.selora/sessions/` (visible, gitignore-able, deletable via
  `selora sessions rm`; resume with `selora resume`). Agent tool results
  travel the same `messages` array — nothing else about your files is sent
  anywhere. Images you attach with `@<path>` are base64-encoded into the
  request (and the session file) — they leave the machine only as part of the
  chat request to the gateway.
- MIT license — see [LICENSE](LICENSE).

## Configuration

Global config (stored, mode 0600):

| Platform | Path                                                                       |
| -------- | -------------------------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/selora/config.json`, else `~/.config/selora/config.json` |
| macOS    | `~/.config/selora/config.json` (the CLI uses the XDG path on macOS too)    |
| Windows  | `%APPDATA%\selora\config.json`                                             |

Fields: `apiUrl`, `apiKey`, `defaultModel`, `theme` (`galaxy` |
`nebula` | `aurora` | `mono`), `webTools` (boolean) — all optional; environment
variables and flags override them.

Project config: `selora init` writes a `selora.json` in the current directory
with the project's default model plus `context.include`/`context.exclude`
globs. The agent enforces `context.exclude` for its read/search tools
(`context.include` stays advisory), and an optional hand-edited `"agent"`
section tunes the loop:

```json
{
  "agent": { "maxTurns": 25, "allowWindowsCmd": false, "webTools": true }
}
```

`maxTurns` caps the agent loop (1–200, default 25);
`allowWindowsCmd` opts `run_command` in on Windows (off by default). See
[docs/agent.md](docs/agent.md) for the full sandbox and permission model.

Shell completion:

```sh
eval "$(selora completion bash)"     # bash; also zsh and fish — see docs/commands/completion.md
```

## Development

```sh
git clone https://github.com/ToxicAngelX/selora-cli.git
cd selora-cli
npm ci
npm run lint          # eslint
npm run typecheck     # tsc --noEmit (strict)
npm test              # vitest
npm run build         # tsup → dist/
npm pack              # build the tarball
```

Runtime dependencies are exactly two: `commander` and `picocolors`. Adding
more is a deliberate decision, not a habit — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Repository

Issues and pull requests: <https://github.com/ToxicAngelX/selora-cli>

Security reports: see [SECURITY.md](SECURITY.md). Code of conduct:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Changelog: [CHANGELOG.md](CHANGELOG.md).
