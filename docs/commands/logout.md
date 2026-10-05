# `selora logout [--revoke] [--yes]`

Clears the locally stored API key. With `--revoke`, it also deletes the
matching server-side key.

## Local only (default)

```
$ selora logout
✓ Logged out
```

The `apiKey` field is removed from `config.json` (other fields, like your
default model, are preserved). If `SELORA_API_KEY` is set in your
environment, logout notes that it still overrides stored keys — it cannot
touch your environment.

```
$ selora logout
✓ Logged out
· SELORA_API_KEY is set in your environment — it still overrides stored keys.
```

With no stored key: `· No stored API key — nothing to log out.` (not an error).

## `--revoke`: also delete the server key

Revocation matches the stored key by its **last 4 characters** against the
`key_hint` of your server-side keys — the CLI never has more of the key than
that, so this is an honest match, not an exact one:

- **Zero matches** — nothing revoked, local key still cleared:
  `· No key on the server matches …ABCD — nothing revoked.`
- **Multiple matches** — the CLI refuses to guess; nothing revoked, local key
  still cleared.
- **One match** — `DELETE /v1/me/keys/:id` runs, then the local key is
  cleared:
  ```
  ✓ Revoked "selora-cli-laptop" (…ABCD) from the server
  ✓ Logged out
  ```

Confirmation is a y/N prompt on a TTY; non-interactive use requires `--yes`
(otherwise: `✗ Refusing to revoke without confirmation.` with a `--yes` hint,
and the key stays stored). If the stored key is already dead server-side
(401), logout still clears it locally and says so. A 404 from the server
reads `· That key was already gone from the server — nothing to revoke.`

`--revoke` without a stored key behaves like plain logout (nothing to match).

## Flags

`--revoke`, `--yes`, plus globals `--debug`, `--json`, `--api-url <url>`.

## `--json`

```json
{
  "ok": true,
  "loggedOut": true,
  "revoked": true,
  "keyName": "selora-cli-laptop",
  "keyHint": "ABCD"
}
```

All outcomes are `{ok:true}` with honest fields: `revoked: false` plus a
`note` explaining why (declined, no match, ambiguous hint, already gone,
key invalid server-side).
