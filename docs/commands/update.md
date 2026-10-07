# `selora update`

Check for a newer `selora` on npm and install it.

```
selora update            # show current vs latest; tell you how to apply it
selora update --check    # report only — never install
selora update --yes      # install selora@latest right away
selora update --json     # machine-readable envelope
```

## What it does

1. Reads the npm registry's `latest` dist-tag for `selora` (10s timeout).
2. Compares it with the running version (semver triple, malformed versions
   never count as newer).
3. **Without `--yes`** it never installs — it prints the one command to run.
   This mirrors the permission philosophy of the whole CLI: the default is to
   tell you exactly what would happen and let you pull the trigger.
4. With `--yes` it spawns `npm install -g selora@<latest>` as a child process
   with your own npm, inheriting stdio — you see npm's own progress output.

## Exit codes

- `0` — up to date, update available (not a failure), or install succeeded.
- `1` — the registry could not be reached, or the install failed (the manual
  `npm install -g selora@<version>` line is printed in both cases).

## Notes

- A rollback on the registry (latest older than what you run) reports
  "up to date" — the CLI never downgrades.
- `selora --version` confirms what actually runs after an update.
