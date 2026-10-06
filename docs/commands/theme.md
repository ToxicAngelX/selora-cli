# `selora theme [name]`

Show the CLI's UI theme, or set it. The theme is saved in the global config
(next to `defaultModel`) and applies to the galaxy UI: the chat startup
screen (including its sweep animation), prompt marker, spinner, markdown
rendering, tool display, and diffs.

```
$ selora theme
Theme       galaxy
Available:  galaxy, nebula, aurora, mono
Set one with: selora theme <name>

$ selora theme nebula
✓ Theme set to nebula
```

## The themes

| Name     | Look                                                                          |
| -------- | ----------------------------------------------------------------------------- |
| `galaxy` | the default — cyan → indigo → violet → magenta gradient over a starfield      |
| `nebula` | the warm sibling — magenta → pink → orange → amber                            |
| `aurora` | the cool sibling — emerald → teal → cyan → sky                                |
| `mono`   | no theme colors at all (structure stays: boxes, markers, diffs in plain text) |

## Color capability is detected honestly

- `NO_COLOR` (any value), `TERM=dumb`, and non-TTY streams disable **all**
  color, regardless of the theme — and with color goes the startup animation
  (the static screen prints instead).
- Truecolor terminals get truecolor; 256-color terminals get the nearest
  xterm-256 color; plain terminals get the nearest ANSI-16 color. Windows
  Terminal is detected via `WT_SESSION`.
- An unknown theme name fails with the available list; the config keeps its
  previous value.

## `--json`

`{ "ok": true, "theme": "galaxy", "available": ["galaxy", "nebula", "aurora", "mono"] }`
(or the shared `{ok:false, error:{…}}` envelope for an invalid name).
