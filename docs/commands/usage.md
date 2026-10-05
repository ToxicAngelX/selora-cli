# `selora usage`

Request/token/spend totals over the daily summary rows of
`GET /v1/me/usage?days=N`. All summation is BigInt — the wire numerics are
strings.

```
SELORA USAGE
──────────────────────────────────────
Today      183 requests · 2.8M in · 1.1M out · $1.42
This week  1,204 requests · 18.1M in · 7.2M out · $9.10
```

## Ranges

The API only supports fixed day windows (`days=N`, int 1–365) — there are no
arbitrary date ranges (see `docs/api-gaps.md`).

- no flag — fetches days=1 AND days=7 and shows both lines
- `--today` — days=1, labeled `Today`
- `--week` — days=7, labeled `This week`
- `--month` — days=30, labeled `This month`

Passing more than one range flag is an error.

## Honesty rules

- An empty summary is a real answer: `No usage recorded in this period.` —
  never a fabricated zero line.
- `--by-model` adds a separate table labeled exactly **`All-time by model`**,
  because the `by_model` field in the API response is all-time, NOT
  period-filtered. It is never summed into the range lines.

```
All-time by model
──────────────────────────────────────
MODEL            REQUESTS  SPEND
glm-5.3-flash        5,210  $40.12
gpt-5.2-mini           931  $3.05
```

## Flags

`--today`, `--week`, `--month`, `--by-model`, plus globals `--debug`,
`--json`, `--api-url <url>`.

## `--json` shape

With a range flag:

```json
{
  "ok": true,
  "days": 1,
  "totals": { "requests": "183", "input_tokens": "2800000", "output_tokens": "1100000", "spend": "1.420000" },
  "summary": [ { "date": "2026-10-05", "total_requests": "183", "...": "..." } ]
}
```

Without a flag (both ranges):

```json
{
  "ok": true,
  "ranges": [
    { "days": 1, "label": "Today", "totals": { "...": "..." }, "summary": [ ] },
    { "days": 7, "label": "This week", "totals": { "...": "..." }, "summary": [ ] }
  ]
}
```

With `--by-model`, a `by_model` array (and `by_model_scope: "all-time"`) is
included. Totals are strings (BigInt-safe); `spend` is a scale-6 decimal
string; `summary` holds the raw wire rows.
