# `selora balance`

One view of the money model: wallet, plan term, and the two rolling spend
windows. Money is rendered via exact integer arithmetic on the wire's scale-6
decimal strings — never floats.

```
SELORA BALANCE
──────────────────────────────────────
Wallet (plan purchases)  $42.18
Plan                     Nova — 12 days left
4h window left           $8.20 of $10.00  (resets in 1h 12m)
Weekly window left       $47.00 of $60.00
Updated                  12:03:44
```

## What each line means

- **Wallet (plan purchases)** — `GET /v1/me/balance`. Wallet funds can only
  buy plans; they can never pay for inference.
- **Plan** — from `GET /v1/me`'s `plan_term`. Days left is computed from
  `ends_at` (ceil, real dates only); a missing `ends_at` shows the plan name
  alone, and no term shows `none`. A trial term reads `Trial — N days left`.
- **4h window left** — `GET /v1/me/windows` `session`. `resets in …` comes
  from the real `resetsInMs` field, shown only when > 0. An exhausted window
  reads `exhausted — resets in …`. `unlimited: true` reads `unlimited`;
  `enforced: false` still shows the numbers.
- **Weekly window left** — the `week` window, same rules, no countdown.
- **Updated** — your local clock when the responses arrived. The API sends no
  timestamp; the label says "Updated" for exactly that reason.

If a window's money fields come back empty (decode fallback), the CLI prints
`—` rather than a fake `$0.00`.

## Flags

Global: `--debug`, `--json`, `--api-url <url>`.

## `--json` shape

```json
{
  "ok": true,
  "wallet": { "balance": "42.180000", "credit_balance": "4.970000", "holds": "0.000000", "available": "42.180000", "credits_expires_at": null },
  "windows": { "session": { "usedUsd": "1.800000", "limitUsd": "10.000000", "remainingUsd": "8.200000", "...": "..." }, "week": { "...": "..." } },
  "plan": { "name": "Nova", "kind": "paid", "ends_at": "2026-10-16T12:00:00Z" },
  "fetched_at": "2026-10-05T12:03:44.000Z"
}
```

Raw wire strings are preserved (full precision). `plan` is `null` when there
is no term. `fetched_at` is an ISO timestamp from the client clock.
