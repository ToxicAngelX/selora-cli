# `selora init [--model <id>] [--force]`

Write a project-local `selora.json` in the **current directory** — distinct
from the global XDG config (`~/.config/selora/config.json`), which keeps the
API key and the global default model. `selora.json` is the *project's*
configuration: its model choice and the context globs for the future agent.

```
✓ Wrote selora.json (model: glm-5.3-flash)
· v0.1 stores this config only — context globs are saved for the future
  agent and are NOT read yet (see docs/agent.md)
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
Authorization header (the pricing-bearing internal flavor) *before* anything
is written. An unknown id prints the backend's honest 404 message
(`Model not available`) plus a `selora models` hint and exits 1 — **no file
is written**.

## Honesty notes

- **v0.1 stores this config only.** The `model` field is read by
  `selora run`; the `context` globs are saved for the future agent and are
  **NOT read yet** (see [docs/agent.md](../agent.md)).
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
