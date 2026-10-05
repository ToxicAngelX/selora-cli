# `selora models`

Lists the gateway's models with pricing. Sorted by id; the display name is
shown under each row; models with `supports_1m_context: true` get a `1m` tag
next to the id.

```
SELORA MODELS
──────────────────────────────────────
ID                       PROVIDER    $/M IN  $/M OUT  STATUS
claude-haiku-4.5         anthropic    $1.00     $5.00  active
  Claude Haiku 4.5
glm-5.3-flash 1m         openai       $0.30     $0.60  active
  GLM 5.3 Flash
gpt-5.2-mini             openai       $0.40     $1.60  active
  GPT 5.2 Mini
kimi-k2                  openai       $0.60     $2.50  inactive
  Kimi K2
```

## No context-length / vision columns

The backend exposes neither (see `docs/api-gaps.md`); the CLI shows neither.
Pricing is USD per 1M tokens, from the wire's scale-6 decimal strings.

## Auth note

The request is sent with **no Authorization header** — this is load-bearing:
the gateway only returns the internal flavor (the only one WITH pricing) to
unauthenticated callers. This is pinned by a test.

## Flags

Global: `--debug`, `--json`, `--api-url <url>`.

## `--json` shape

```json
{
  "ok": true,
  "models": [
    {
      "id": "glm-5.3-flash",
      "provider": "openai",
      "status": "active",
      "pricing": { "input_per_1m": "0.300000", "output_per_1m": "0.600000" },
      "display_name": "GLM 5.3 Flash",
      "supports_1m_context": true
    }
  ]
}
```

The raw decoded list; `supports_1m_context` is only present for models that
carry it.
