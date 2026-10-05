# Security policy

## Supported versions

Only the latest released version of `selora-cli` receives security fixes.

## How the CLI handles your key

So you can evaluate the attack surface before reporting:

- **Storage.** The API key is stored in `config.json` under the XDG config
  dir, with mode 0600 (best-effort on Windows). v0.1 does not use an OS
  keyring — that would require native dependencies, and the trade-off is
  documented rather than hidden (`docs/api-gaps.md`). The login session JWT
  is held in memory only, used once, and never written to disk.
- **Environment override.** `SELORA_API_KEY` beats the file and is never
  written to disk by the CLI.
- **Logging.** All debug output passes through a single redaction chokepoint
  before printing; the Authorization header is never printed. The one
  deliberate exception is `selora keys create`, whose purpose is printing the
  one-time secret the backend returns exactly once — and that line never
  reaches debug logs or error paths.
- **Telemetry.** There is none. No analytics, no crash reporting, no
  version-check pings. The CLI's only network peer is the Selora gateway
  (plus whatever you point `SELORA_API_URL` at).

## Reporting a vulnerability

Report privately via **GitHub Security Advisories** on this repository
(<https://github.com/ToxicAngelX/selora-cli/security/advisories/new>). Please
include reproduction steps and the CLI version (`selora --version`). We have
no PGP key or dedicated security email — do not look for one, and please do
not open a public issue for security reports.

## What NOT to report here

- **The Selora gateway itself is a separate project.** API-side issues
  (rate limiting, billing, account security, anything at api.selora.lol
  beyond this CLI's HTTP behavior) are not handled in this repository.
- Compromise of your own machine or account (e.g. someone read your 0600
  config file with root access) — the file's permissions are the documented
  boundary.
