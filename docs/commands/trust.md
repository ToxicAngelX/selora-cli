# `selora trust [add <dir> | remove <dir>]`

Manage the **trusted workspaces** list — the folders `selora chat` (and
`selora resume`) will not show the startup trust screen for. With no action
it lists the trusted folders.

```
$ selora trust
/home/ada/project
/home/ada/scratch

$ selora trust add .
✓ Trusted /home/ada/notes
· selora chat will not ask about this folder again

$ selora trust remove /home/ada/scratch
✓ Removed /home/ada/scratch from the trusted list
· selora chat will ask again in that folder
```

## The trust screen

The first time `selora chat` starts in a folder that is not on the list, it
asks once before the REPL opens:

```
Accessing workspace:

 ~/project

 Quick safety check: is this a folder you created or one you trust? Selora will be able to
 read, edit, and run commands here.

❯ 1. Yes, I trust this folder
  2. No, exit

Enter to confirm · Esc to cancel
```

Enter on option 1 trusts the folder (persists) and chat continues; option 2
or Esc prints `· not trusted — exiting` and exits 0.

## Notes

- The list lives in `trusted.json` (mode 0600) next to `config.json` in the
  config dir. Paths are stored **realpath-canonical** (symlinks resolved,
  on-disk casing on Windows), so every spelling of a folder recognizes it.
- `add` requires an existing directory; a missing folder is a friendly error,
  never a written entry.
- The screen never appears — and never blocks — on non-TTY stdin, `--json`,
  `--yes`, NO_COLOR, or TERM=dumb. `--yes` implies trust for the session and
  persists nothing.
- Trust skips the one-time question only. The agent's per-tool permission
  gates (prompts, permission modes, outside-root session grants) are
  unaffected.

## `--json`

List: `{ "ok": true, "trusted": ["/home/ada/project"] }`.
Add: `{ "ok": true, "trusted": "/home/ada/notes" }`.
Remove: `{ "ok": true, "removed": "/home/ada/scratch", "trusted": [...] }`.
Errors use the shared `{ok:false, error:{…}}` envelope.
