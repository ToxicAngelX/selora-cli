# `selora resume [name] [--model <id>] [--safe] [--yes]`

Reopen a saved conversation in the [chat REPL](chat.md) — with the full
history restored: user, assistant, and tool messages, images included.

- **No name** → the most recently updated session in the project's
  `.selora/sessions/` that has messages. After a crashed or `/exit`ed
  `selora chat` that is the auto-saved `chat` session.
- **`selora resume <name>`** → exactly that session — the same files
  `selora run --session <name>` writes (see [run.md](run.md)).

The REPL opens with the history seeded and keeps **auto-saving under the same
name** after every completed turn. The session's model is used unless
`--model` overrides it; `--safe` and `--yes` behave exactly as in
`selora chat`.

```
$ selora resume
✓ Connected to gpt-5.2-mini (GPT 5.2 Mini)
· Resumed session "work" — 12 messages restored
gpt-5.2-mini · ~/project
⏸ manual mode on · ? for shortcuts
❯
```

There is deliberately no picker and no silent auto-resume: bare
`selora chat` asks the one-line `Resume the previous session? [y/N]`
question, and `selora resume` is the explicit form.

## Errors

- No sessions at all (or all empty): exit 1 with
  `no sessions in this project — start one: selora chat, or selora run --session <name> "<prompt>"`.
- Unknown or malformed name: `no session named "<name>" in this project`,
  resp. the session-name rule — exit 1.
- Non-interactive stdin cannot host a REPL: the same honest
  `selora chat needs an interactive terminal — use: selora run "<prompt>"`
  as chat, exit 1.

## `--json`

Only the pre-REPL failures are machine-readable (the shared
`{ok:false, error:{…}}` envelope). The REPL itself is human-formatted —
see [chat.md](chat.md#--json-caveat).
