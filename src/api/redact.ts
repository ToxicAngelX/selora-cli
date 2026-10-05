/**
 * THE redaction chokepoint. Every piece of debug/log output that could carry
 * credentials must pass through redact() before being written anywhere.
 *
 * The pattern intentionally also matches the fake test keys (sk-gw-TEST…) —
 * redaction is unconditional; the no-leak test additionally scans for
 * non-TEST prefixes to catch anything that slipped past this function.
 */

const KEY_RE = /sk-gw-[A-Za-z0-9_-]+/g;
const BEARER_RE = /Bearer [A-Za-z0-9._-]+/g;
const PASSWORD_RE = /"password"\s*:\s*"[^"]*"/g;
// Login responses carry the session JWT as `"token":"…"` — debug mode logs
// response bodies, so that field must never survive either.
const TOKEN_RE = /"token"\s*:\s*"[^"]*"/g;

/** Replace API keys, Bearer token values, passwords, and session tokens with placeholders. */
export function redact(s: string): string {
  // Bearer first: otherwise the key pass rewrites the token inside
  // "Bearer sk-gw-…" and the Bearer pass mangles the placeholder.
  return s
    .replace(BEARER_RE, 'Bearer …redacted')
    .replace(KEY_RE, 'sk-gw-…redacted')
    .replace(PASSWORD_RE, '"password":"…redacted"')
    .replace(TOKEN_RE, '"token":"…redacted"');
}
