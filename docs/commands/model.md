# `selora model [id]`

Shows or sets the CLI's configured default model (stored as
`defaultModel` in `config.json`).

## No argument — show the default

```
SELORA MODEL
──────────────────────────────────────
Default     glm-5.3-flash
· Set with: selora model <id> · clear with: selora model --unset
```

When nothing is configured, the display-time fallback `glm-5.3-flash` is
shown. It is never written to the config implicitly — only an explicit
`selora model <id>` (or `--unset`) touches the file.

## With an id — detail view + set

Fetches `GET /v1/models/:id` (no Authorization header — the pricing-bearing
internal flavor is unauthenticated only). Unknown ids surface the backend's
honest 404: `Model not available`.

```
SELORA MODEL
──────────────────────────────────────
ID          glm-5.3-flash
Name        GLM 5.3 Flash
Provider    openai
Status      active
$/M in      $0.30
$/M out     $0.60
Limits      —
✓ Default model set to glm-5.3-flash
```

`Limits` renders the backend's raw `limits` JSONB as `key: value` rows; on
the real gateway it is almost always `{}`, shown as `—`. There is no
context-length or vision field to show (see `docs/api-gaps.md`).

## `--unset`

Clears `defaultModel` from the config (other config fields are preserved).

## Flags

`--unset`, plus globals `--debug`, `--json`, `--api-url <url>`.

## `--json` shapes

No argument:

```json
{ "ok": true, "default_model": "glm-5.3-flash", "configured": false }
```

With an id (success):

```json
{
  "ok": true,
  "model": { "id": "glm-5.3-flash", "provider": "openai", "status": "active", "pricing": { "input_per_1m": "0.300000", "output_per_1m": "0.600000" }, "limits": {}, "metadata": {}, "display_name": "GLM 5.3 Flash" },
  "default_model_set": "glm-5.3-flash"
}
```

`--unset`: `{ "ok": true, "cleared": true }`.
