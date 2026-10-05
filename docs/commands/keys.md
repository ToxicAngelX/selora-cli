# `selora keys [list|create|revoke]`

API-key management. The default action is `list`. All subcommands require a
stored key (`selora login`) — there is no anonymous key access.

## `selora keys` / `selora keys list`

```
SELORA KEYS
──────────────────────────────────────
NAME      KEY    STATUS  CREATED    LAST USED  REQUESTS
laptop    …ABCD  active  2026-09-01 2026-10-04  42
—         …WXYZ  active  2026-09-02 never       0
old-laptop …DEAD  revoked 2026-08-01 2026-08-20  7
· 1 revoked key — revoked keys can no longer authenticate.
```

- `KEY` shows EXACTLY what the backend returns: the masked last-4 `key_hint`.
  The CLI never reconstructs more of the key.
- `CREATED`/`LAST USED` are date-only; a never-used key reads `never`.
- Revoked keys stay in the table (status says so) with a bullet noting it.
- `--json`: `{ "ok": true, "keys": [ ...raw decoded key objects... ] }`.

## `selora keys create [--name <name>]`

Creates a key via `POST /v1/me/keys`. The name comes from `--name` or, on a
TTY, a prompt whose default suggestion is `selora-cli-<hostname>`; without
either (non-interactive), the suggestion is used directly. Names are trimmed
and capped at 120 chars (the backend limit).

```
✓ Key created: selora-cli-laptop
✰ THIS IS THE ONLY TIME THE FULL KEY IS SHOWN — copy it now:
  sk-gw-… (green, the actual secret)
· Store this secret now — it cannot be retrieved again.
```

The one-time secret print is the single deliberate exception to the
never-print-keys rule — it is the command's purpose, the backend returns the
secret exactly once, and it appears in exactly one stdout line. It never
appears in debug logs (that channel is redacted) or any error path.

`409 key_limit_reached` → the backend message plus a hint to revoke an old
key at selora.lol (or `selora keys revoke`).

`--json`: `{ "ok": true, "key": {...}, "secret": "sk-gw-...", "note": "..." }`
— machine consumers need the secret, so it is included here.

## `selora keys revoke <id|…hint> [--yes]`

Resolves the argument to a key: a full id, or a `…abcd`/`abcd` value matching
a key's `key_hint` (revoked keys are excluded from hint matching). Ambiguous
hints list the matches and refuse. Zero matches fail honestly.

Confirmation is a y/N prompt on a TTY; non-interactive use requires `--yes`
(otherwise it refuses, like `logout --revoke`).

`DELETE /v1/me/keys/:id` → the result reports the deletion kind honestly:

```
✓ Deleted "laptop" (…ABCD) — soft delete
```

(`soft` when the key has usage rows, `hard` otherwise — the backend decides.)
`404` → `That key was already gone from the server — nothing to revoke.`

`--json`: `{ "ok": true, "id": "...", "deleted": true, "deletion": "soft" }`
(or `deleted: false, note: "Already gone..."` on 404).
