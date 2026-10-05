# curl equivalents

What the CLI sends on the wire, as raw `curl` calls — for scripting, testing,
or understanding exactly what your terminal session does.

**`sk-gw-…` below is a redacted placeholder, not a real key.** Substitute your
own key (from `selora login` or selora.lol → Keys). Every request the CLI
makes also carries an `x-request-id` header (a UUID it generates; the gateway
echoes one back) — omitted here for readability; `curl` works without it.

Base URL: `https://api.selora.lol` (override with `SELORA_API_URL` or
`--api-url`).

## login (email + password)

```sh
curl -sS https://api.selora.lol/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-staple"}'
```

200 → `{"user":{…},"token":"<JWT>","expires_at":1760000000}` — `expires_at` is
Unix seconds (+12h). The CLI keeps the token **in memory only**, then uses it
once to create a dedicated key:

```sh
curl -sS https://api.selora.lol/v1/me/keys \
  -H 'Authorization: Bearer <JWT-from-login>' \
  -H 'Content-Type: application/json' \
  -d '{"name":"selora-cli-laptop"}'
```

201 → `{"api_key":{…},"secret":"sk-gw-…","note":"Store this secret now — it
cannot be retrieved again."}`. The secret is returned **exactly once**; the
CLI validates it (next call) before storing it.

## login --key (validate an existing key)

```sh
curl -sS https://api.selora.lol/v1/me \
  -H 'Authorization: Bearer sk-gw-…'
```

200 → the account/plan/wallet object (see below). 401 → invalid key. The CLI
runs exactly this before storing a `--key` login.

## balance

`selora balance` makes three GETs and merges the view (wallet + plan term +
windows):

```sh
# wallet (plan-purchase money — never funds inference)
curl -sS https://api.selora.lol/v1/me/balance \
  -H 'Authorization: Bearer sk-gw-…'

# rolling spend windows (the actual inference capacity)
curl -sS https://api.selora.lol/v1/me/windows \
  -H 'Authorization: Bearer sk-gw-…'

# plan term (for the "Plan — N days left" line)
curl -sS https://api.selora.lol/v1/me \
  -H 'Authorization: Bearer sk-gw-…'
```

- `/v1/me/balance` → `{"wallet":{"balance":"42.180000","credit_balance":"…","holds":"…","available":"…","credits_expires_at":null}}`
  — money is decimal strings at scale 6.
- `/v1/me/windows` → `{"session":{…4h window…},"week":{…}}`, each with
  `usedUsd/limitUsd/remainingUsd` (decimal strings), `startedAt/resetsAt`
  (ISO), `resetsInMs` (number), `requests`, `enforced/exhausted/unlimited`
  (booleans).

## windows

Same call, alone:

```sh
curl -sS https://api.selora.lol/v1/me/windows \
  -H 'Authorization: Bearer sk-gw-…'
```

## usage

```sh
curl -sS 'https://api.selora.lol/v1/me/usage?days=7' \
  -H 'Authorization: Bearer sk-gw-…'
```

`days` is an int 1–365 (default 30); `--today`/`--week`/`--month` map to
1/7/30. The CLI sums only `summary` rows — `by_model` is all-time and is
labeled that way. Summary numerics are strings; the CLI sums them with BigInt,
never floats.

## models

```sh
curl -sS https://api.selora.lol/v1/models
```

**No Authorization header — this is load-bearing.** The gateway negotiates
the response flavor by headers: `anthropic-version` present → Anthropic
envelope; `authorization` present → OpenAI envelope (no pricing); **neither**
→ the internal flavor, the only one with pricing. The CLI always calls this
route unauthenticated, and the same applies per-model:

```sh
curl -sS https://api.selora.lol/v1/models/glm-5.3-flash
```

## keys

List:

```sh
curl -sS https://api.selora.lol/v1/me/keys \
  -H 'Authorization: Bearer sk-gw-…'
```

Create (the response includes the one-time secret):

```sh
curl -sS https://api.selora.lol/v1/me/keys \
  -H 'Authorization: Bearer sk-gw-…' \
  -H 'Content-Type: application/json' \
  -d '{"name":"my-second-key"}'
```

Revoke:

```sh
curl -sS -X DELETE https://api.selora.lol/v1/me/keys/key_abc123 \
  -H 'Authorization: Bearer sk-gw-…'
```

→ `{"ok":true,"id":"key_abc123","deleted":true,"deletion":"soft"}` (`soft`
when the key has usage rows). The CLI resolves `selora keys revoke <id|…hint>`
arguments to the key id from the list first.

## chat / run (streaming)

```sh
curl -sS https://api.selora.lol/v1/chat/completions \
  -H 'Authorization: Bearer sk-gw-…' \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [{"role":"user","content":"explain this"}],
    "stream": true,
    "stream_options": {"include_usage": true}
  }'
```

Notes, exactly as the CLI observes them:

- This route is **API-key-only** — a session JWT from `/v1/auth/login` is
  refused with 401.
- The response is `text/event-stream`: `data: {JSON}` events, a first
  role-only chunk, `delta.content` deltas, a finish chunk
  (`finish_reason: "stop"`), then a usage chunk
  (`choices: []` + `usage` + `gateway.charge` — the decimal-USD **cost**;
  there is no field named `cost`), and the raw `data: [DONE]` sentinel.
- In-band errors arrive as `data: {"error":{…}}` events after the headers.
- The `messages` history the REPL sends grows turn by turn
  (user + assistant messages, in memory only).
