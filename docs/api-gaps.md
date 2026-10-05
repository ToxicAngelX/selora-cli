# API gaps and spec corrections

Differences between the original CLI spec and what the Selora gateway actually
exposes (verified against read-only backend recon, 2026-10-05 — see
`/tmp/selora-wire-reference.md`). The CLI shows only what the backend returns;
these are the places where it deliberately does NOT invent a field.

1. **Usage has no arbitrary date ranges.** `GET /v1/me/usage` accepts only
   `days=N` (int 1–365). The CLI's `--today`/`--week`/`--month` map to
   days=1/7/30; there is no `--from`/`--to`, and requesting more than one of
   them is an error rather than a silent last-one-wins.

2. **There is no "Available/API credits" split.** The original spec described a
   credits balance split; the real model is a **wallet** (plan-purchase funds
   — it can NEVER pay for inference) plus **rolling spend windows**
   (4h + weekly caps per plan). See the README's money-model section. The CLI
   renders wallet + windows (`selora balance`) and never merges the two.

3. **Models expose no vision flag and no context length.** `/v1/models` returns
   id, provider, status, pricing (per-1M in/out), display_name, and optionally
   `supports_1m_context: true`. There is no vision or context-length field, so
   the models table shows neither. The only context-related signal is the `1m`
   tag for models with `supports_1m_context`.

4. **Window exhaustion arrives as 402, not 429.** Code `insufficient_balance`;
   the reset time (`resetsAt`) appears ONLY inside the message text — it is
   stripped from the structured body. The CLI passes the message through
   verbatim and never fabricates a countdown from it. (429 is plain rate
   limiting with `retry_after_seconds`.)

5. **Login cannot distinguish Google-only accounts from wrong passwords.**
   Both produce the identical 401 `unauthorized` / "Invalid email or password".
   The CLI's Google sign-in hint is therefore a heuristic, not a fact the
   backend confirmed.

6. **`/v1/models` pricing requires the unauthenticated internal flavor.**
   Content negotiation: an `anthropic-version` header → Anthropic envelope;
   an `authorization` header → OpenAI envelope (no pricing); **neither** →
   the internal flavor, the only one with pricing. The CLI always calls
   `/v1/models` and `/v1/models/:id` with auth:'none' — pinned by a test that
   asserts no Authorization header is sent.

7. **OS keyring unavailable without native deps.** v0.1 stores the API key in
   a 0600 `config.json` under the XDG config dir; `SELORA_API_KEY` overrides
   it and is never written to disk. This is a documented trade-off surfaced at
   login time, not a hidden one.

Related honest-labeling decisions that follow from the wire shapes:

- `by_model` in the usage response is **all-time**, not period-filtered — it
  is never summed into range lines and appears only under the literal label
  `All-time by model`.
- The usage summary's numerics are **strings** on the wire; the CLI sums them
  with BigInt and never float-math.
- Money is scale-6 decimal strings everywhere except the `plan` object in
  `GET /v1/me` (numbers).
- Key creation returns the secret **exactly once**; `selora keys create`'s
  single green stdout line is the one deliberate print of it.
