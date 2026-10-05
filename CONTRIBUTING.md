# Contributing to selora-cli

Thanks for wanting to help. This file is the short version of what a good
contribution looks like here.

## Setting up

```sh
git clone https://github.com/ToxicAngelX/selora-cli.git
cd selora-cli
npm ci
```

Node ≥ 20 required. Runtime dependencies are exactly `commander` and
`picocolors` — keep it that way (see below).

## The gates

Every change must pass all of these, and every PR is expected to arrive with
them green:

```sh
npm run lint        # eslint
npm run typecheck   # tsc --noEmit, strict — this is the lint that matters
npm test            # vitest
npm run build       # tsup → dist/
npm pack            # then: node scripts/check-pack-size.mjs selora-*.tgz
```

Formatting is Prettier (`npm run format`); run it before committing so review
doesn't turn into whitespace.

## What we look for in a PR

- **Tests first.** A bug fix comes with a test that fails before the fix and
  passes after. A feature comes with tests for the happy path and the honest
  failure paths. The suite already covers wire-shape decoding, money
  arithmetic (BigInt, never floats), redaction, and command behavior against
  a local mock gateway — extend those rather than testing around them.
- **No new runtime dependencies without discussion first.** Open an issue
  before a PR that adds one. Two runtime deps is a feature of this project,
  not an accident. Dev dependencies are still worth a sentence of
  justification.
- **No telemetry, no analytics, no phone-home — ever.** If a change sends
  anything anywhere other than the Selora gateway, it will not be merged.
- **No secrets in tests or fixtures.** Fake keys use the `sk-gw-TEST` prefix
  only; a real-looking key in a fixture is a rejected PR. The `no-leak` test
  suite enforces this — keep it passing.
- **Wire shapes are facts, not suggestions.** The gateway reference
  (`docs/api-gaps.md` and the internal wire notes) is authoritative: decode
  defensively, guard `Record` lookups, never invent fields, and when the API
  disagrees with a wish, update the docs rather than the wire.
- **Honesty over polish.** If a feature can't be finished, say so in the PR
  and in the docs (see `docs/agent.md` for the house style of stating what
  does not exist).

## Where things live

```
src/index.ts          entry point; argv → program
src/program.ts        commander program: every command registration
src/commands/         one file per command
src/api/              client (the single HTTP chokepoint), endpoints, SSE, redaction
src/auth/             key storage, prompts, key-name suggestion
src/config/           XDG config + project selora.json
src/agent/            the agent: loop, permissions, sandbox, tools, sessions
docs/                 per-command reference, api-gaps.md, agent.md
tests/                vitest suites + a mock gateway
```

Command docs (`docs/commands/*.md`) ship in the npm tarball — if you change a
command's behavior, change its doc in the same PR.

## Publishing

Publishing to npm is **owner-only** — it is gated behind a protected
environment in the release workflow and requires manual approval. Never
attempt to publish from a PR or a fork; the workflow won't let you, by
design.

## Issues

Use GitHub issues on this repository. For security reports, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
