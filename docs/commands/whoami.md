# `selora whoami`

Shows the account behind the stored key: one `GET /v1/me` call rendered as
plain lines.

```
selora — account
──────────────────────────────────────
Email       you@example.com
Name        Alex
Account     active
Plan        Nova — paid, ends 2026-10-16T12:00:00Z
Trial       active until 2026-09-12 · Telegram verified
Wallet      $42.18 (plan purchases)
```

- **Name** appears only when the account has one.
- **Account** is the user status from the wire (`active`, …); an empty wire
  value shows `unknown` rather than a blank.
- **Plan** — the plan term (`plan_name`, kind, `ends_at`); no term shows
  `none`.
- **Trial** — shown when the account has a `trial_until`; the Telegram
  verification state is stated plainly. Accounts with neither trial nor plan
  show `Trial none`.
- **Wallet** — the wallet balance, labeled `plan purchases` because that is
  all wallet money can ever buy — it never funds inference (see the README's
  money-model section).

A 401 (revoked or invalid key) renders the backend's verbatim message —
including the full key-rotation guidance — and exits 1.

## Flags

Global: `--debug`, `--json`, `--api-url <url>`.

## `--json` shape

```json
{
  "ok": true,
  "user": { "id": "usr_1", "email": "you@example.com", "plan_id": "nova", "...": "..." },
  "plan": { "id": "nova", "name": "Nova", "monthlyPrice": 5, "...": "..." },
  "plan_term": { "kind": "paid", "plan_name": "Nova", "started_at": "...", "ends_at": "..." },
  "wallet": { "balance": "42.180000", "credit_balance": "4.970000", "...": "..." }
}
```

The decoded wire objects, money as full-precision decimal strings. `plan` and
`plan_term` are `null` when absent; the `plan` object's numeric fields are
numbers (the wire sends them that way — see docs/api-gaps.md).
