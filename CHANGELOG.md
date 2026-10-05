# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
