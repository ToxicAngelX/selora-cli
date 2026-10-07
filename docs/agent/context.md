# Context meter + auto-compaction (v1.2)

Long sessions die when the context window fills. The CLI now shows it and
fixes it.

## The meter

Every prompt block carries a live estimate:

```
glm-5.3-flash · ~/proj · 6,055 tokens
⏸ manual mode on · ? for shortcuts
ctx ▰▰▱▱▱▱▱▱ 25% · 7,500/30,000
❯
```

- **Estimate** between usage chunks: ~4 chars/token for text, plus tool-call
  JSON skeletons. When the gateway's usage chunk arrives, real numbers win.
- **Colors**: gradient fill while healthy, warning at ≥75%, error at ≥90%.
- **Budget**: 30,000 tokens default — set `agent.contextTokens` in
  `selora.json` (1,000–1,000,000) to match your model's window.

## Auto-compaction

When the estimate crosses **90%**, the CLI folds the oldest turns into a
single summary message and keeps going — you see:

```
⏳ compacting context ⠳ — summarizing earlier turns…
· context compacted — 48 messages folded into a summary (≈21,000 tokens reclaimed)
```

Rules that keep it safe:

- **Whole-turn folding** — an assistant tool-call message always folds
  together with its tool results; the wire shape stays valid.
- **The last 6 messages are never folded** — the live working set stays
  verbatim.
- **Fails soft** — if the summarizer model errors, the conversation is
  returned unchanged (compaction retries next turn).
- The summary carries goals, decisions, file paths, commands, errors — not
  chatter.

## Config (selora.json)

```json
{
  "agent": {
    "contextTokens": 60000,
    "compactModel": "glm-5.3-flash"
  }
}
```

- `contextTokens` — the budget both features key off (default 30000).
- `compactModel` — the model that summarizes folded turns (default: the
  session model). Point it at a cheap model to spend pennies on compaction.
