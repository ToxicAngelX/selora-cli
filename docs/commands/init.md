# `selora init [--model <id>] [--force]`

Write a project-local `selora.json` in the **current directory** — distinct
from the global XDG config (`~/.config/selora/config.json`), which keeps the
API key and the global default model. `selora.json` is the _project's_
configuration: its model choice and the context globs the agent enforces.

```
✓ Wrote selora.json (model: glm-5.3-flash)
· the agent enforces context.exclude for read/search tools; an optional
  "agent" section (maxTurns, allowWindowsCmd) can be hand-edited (see docs/agent.md)
```

The file content (2-space JSON, trailing newline):

```json
{
  "version": 1,
  "model": "glm-5.3-flash",
  "context": {
    "include": ["src/**/*", "docs/**/*.md"],
    "exclude": ["**/node_modules/**", "**/dist/**"]
  }
}
```

## Model resolution

`--model <id>` > the global default model (`selora model <id>`) >
`glm-5.3-flash`.

The model is **verified** via the public `GET /v1/models/:id` route with NO
Authorization header (the pricing-bearing internal flavor) _before_ anything
is written. An unknown id prints the backend's honest 404 message
(`Model not available`) plus a `selora models` hint and exits 1 — **no file
is written**.

## Honesty notes

- **What is read:** the `model` field (by `selora run`) and the
  `context.exclude` globs (by the agent's read/search tools — the shipped
  defaults apply when there is no file). `context.include` is advisory only,
  never a whitelist. The optional hand-edited `"agent"` section (`maxTurns`,
  `allowWindowsCmd`) is also read; `init` does not write it.
- An existing `selora.json` is never clobbered: without `--force` the command
  prints `selora.json already exists (use --force)` and exits 1.
- Reading is defensive: a malformed `selora.json` elsewhere on disk is
  ignored with a warning (`selora run` treats it as absent) — never a crash.

## Flags

`--model <id>`, `--force`, plus globals `--debug`, `--json`,
`--api-url <url>`.

## `--json`

One object on stdout; `created: true` for a fresh file, `overwritten: true`
when `--force` replaced an existing one:

```json
{ "ok": true, "path": "/path/to/selora.json", "model": "glm-5.3-flash", "created": true }
```

Failure shapes match the other commands: `--force` missing on an existing
file → `{ok:false, error:{kind:"internal", message:"selora.json already
exists (use --force)"}}`, exit 1; a 404 model →
`{ok:false, error:{kind:"http_error", message:"Model not available", …}}`,
exit 1, no file written.
