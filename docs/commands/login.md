# `selora login [--key [value]]`

Log in. Two paths, depending on how your Selora account authenticates.

## Path A (default): email + password

```
$ selora login
Email: you@example.com
Password: ········
✓ Logged in as you@example.com
✓ CLI key created: selora-cli-laptop
· API key stored at ~/.config/selora/config.json (chmod 600; v0.1 has no OS
  keyring). It is shown once and never printed again.
· Your session token was used in memory only — nothing else was written to disk.
```

What happens, in order:

1. `POST /v1/auth/login` with the email + password you typed. The response's
   session token (a JWT) stays **in memory only** — it is never written to
   disk and never printed.
2. That token authorizes `POST /v1/me/keys` to create a **dedicated CLI key**
   named `selora-cli-<hostname>` (sanitized, capped at the backend's 120-char
   name limit). The one-time secret is captured — never printed.
3. The secret is validated with `GET /v1/me` before anything is stored.
4. Only then is it written to the 0600 config file.

A 401 from the backend cannot distinguish a wrong password from a Google-only
account (the gateway returns the identical response), so the CLI shows the
message plus a heuristic hint pointing at Path B:

```
✗ Login failed: Invalid email or password.
· If your account uses Google sign-in, create a key at selora.lol → Keys, then run: selora login --key
```

A 403 means the account is not active; 429 shows the backend's rate-limit
message (login is limited to 10 attempts/min per email, 120/min per IP).
Nothing is stored on failure.

## Path B: `selora login --key`

For Google-only accounts (or any existing `sk-gw-` key):

1. Create a key in the Selora web console (selora.lol → Keys).
2. `selora login --key` — prompts for the key (hidden input on a TTY), or
   reads it from piped stdin: `echo "$KEY" | selora login --key`.
   `selora login --key sk-gw-…` also accepts the value directly.
3. The key is validated with `GET /v1/me` **before** it is stored.

```
$ selora login --key
API key: ········
✓ Logged in as you@example.com
✓ Key validated — stored locally
· API key stored at ~/.config/selora/config.json (chmod 600; v0.1 has no OS keyring).
```

An invalid key is not stored: `✗ That key was not accepted by the Selora API.`
(exit 1).

## Where the key lives

- Stored in `config.json` (mode 0600) under the XDG config dir —
  see the README's configuration section. v0.1 has **no OS keyring** (that
  would need native dependencies); this is a documented trade-off, not a
  hidden one.
- `SELORA_API_KEY` set in your environment **overrides** the stored key and is
  never written to disk — login says so when both exist.

## Non-interactive use

With non-TTY stdin, Path A reads two plain lines (email, then password) from
the pipe; Path B reads the key as one line. Empty input cancels
(`✗ Cancelled.`, exit 1).

## Flags

`--key [value]`, plus globals `--debug`, `--json`, `--api-url <url>`.

## `--json`

Path A:

```json
{ "ok": true, "email": "you@example.com", "keyName": "selora-cli-laptop", "keyStored": true }
```

Path B:

```json
{ "ok": true, "email": "you@example.com", "keyValidated": true, "keyStored": true }
```

Failures use the shared `{ok:false, error:{kind:"auth", message, hint}}`
envelope. The key secret never appears in JSON output — the only command that
prints a secret is `keys create`, whose purpose is exactly that one-time
print.
