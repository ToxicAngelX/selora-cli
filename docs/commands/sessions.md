# `selora sessions [list|show|rm] [name]`

Manage the agent's project-local conversation sessions — the
`.selora/sessions/<name>.json` files written by `selora chat` (the
auto-saved `chat` session, since v0.6) and `selora run --session <name>`
(see [run.md](run.md) and [agent.md](../agent.md)). With no action, `list`.

Every listed session is resumable: `selora resume [name]` opens it in the
chat REPL with the full history restored (see [resume.md](resume.md)).

## list

```
$ selora sessions
Sessions in /home/you/proj/.selora/sessions (newest first):
work         glm-5.3-flash · 6 messages · updated 2026-10-05T17:43:12.314Z
scratch      glm-5.3 · 2 messages · updated 2026-10-05T09:02:44.001Z
```

An empty project prints the honest start hint:
`· no sessions in this project — start one: selora run --session <name> "<prompt>"`.

## show `<name>`

Renders the stored conversation: the header (name, model, created, updated,
message count), then each message as a role-labeled block. Assistant
tool-call messages render as `name(arguments)`; tool results render with
their call id (`[call_…]`). Image turns (session format v2) render their text
plus an `[image attached]` marker — a data URL's base64 never prints.

- Each message is **truncated to 400 characters for display** — the full
  history stays in the file (and in `--json`).
- Display text passes through the **redaction chokepoint**: key material an
  agent read into a conversation prints as `sk-gw-…redacted`, never raw.

Unknown or malformed session files are reported and skipped — never a crash.
The same goes for a file with a NEWER format version than this CLI knows
(v2 is the current format; v1 files load unchanged).

## rm `<name>`

Deletes the session file. Interactively it asks `Delete session "<name>"?`
(y/N); when stdin is not a TTY it refuses with
`✗ confirmation required — pass --yes`. `--yes` confirms non-interactively
(and is required for `--json`).

## `--json`

`list` prints `{ok, sessions:[{name, model, updatedAt, messages, resumable}]}`
(`resumable` is `true` for every stored session — a forward-compat marker);
`show` prints the **full** stored session (`{ok, version, name, model,
createdAt, updatedAt, messages}`) — untruncated, like chat/run content: it
is data the user's own key fetched. `rm` prints `{ok, deleted: true, name}`
and requires `--yes`. Errors use the shared `{ok:false, error:{…}}`
envelope.
