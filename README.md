# selora

Open-source command-line client for the [Selora API gateway](https://api.selora.lol).
Log in, check your balance and usage, list models, manage API keys, and chat
with models — streaming — straight from the terminal. It is an independent
codebase: no website or IDE required, and nothing is sent anywhere except the
Selora API itself.

## Requirements

- Node.js ≥ 20
- Linux, macOS, or Windows

## Install

When the package is published:

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
| `selora chat`                         | chat with a model in an interactive streaming session                         | [chat.md](docs/commands/chat.md)             |
| `selora run "<prompt>"`               | one-shot streaming completion (no REPL)                                       | [run.md](docs/commands/run.md)               |
| `selora init`                         | write a project-local selora.json (model + future agent context globs)        | [init.md](docs/commands/init.md)             |
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

## Privacy

- **Zero telemetry.** No analytics, no crash reporting, no usage pings. The
  CLI talks to exactly one host: the Selora gateway.
- **Keys are never logged.** All debug output passes through a single
  redaction chokepoint before printing; the Authorization header is never
  printed. The one deliberate exception is `selora keys create`, whose entire
  purpose is printing the one-time secret the backend returns exactly once.
- Conversation state is in-memory only — never written to disk, never sent
  anywhere except as the `messages` array of the next request.
- MIT license — see [LICENSE](LICENSE).

## Configuration

Global config (stored, mode 0600):

| Platform | Path                                                                       |
| -------- | -------------------------------------------------------------------------- |
| Linux    | `$XDG_CONFIG_HOME/selora/config.json`, else `~/.config/selora/config.json` |
| macOS    | `~/.config/selora/config.json` (the CLI uses the XDG path on macOS too)    |
| Windows  | `%APPDATA%\selora\config.json`                                             |

Fields: `apiUrl`, `apiKey`, `defaultModel` — all optional; environment
variables and flags override them.

Project config: `selora init` writes a `selora.json` in the current directory
with the project's default model plus `context.include`/`context.exclude`
globs. The globs are saved for a future agent and are **not read yet** in
v0.1 — see [docs/agent.md](docs/agent.md) for what exists and what does not.

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
