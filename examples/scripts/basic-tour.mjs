#!/usr/bin/env node
/**
 * basic-tour.mjs — a plain Node script (no dependencies) that shells out to
 * the `selora CLI and walks through its read-only surface:
 *
 *   version → models → (login --key, if SELORA_API_KEY is set) → balance
 *
 * Usage:
 *   SELORA_API_KEY=sk-gw-… node examples/scripts/basic-tour.mjs
 *
 * Configuration:
 *   SELORA_BIN     — the CLI binary to invoke (default: "selora"; set it to
 *                    "node /path/to/selora-cli/dist/index.js" to drive a
 *                    local build instead of an installed one)
 *   SELORA_API_URL — gateway base URL (default: https://api.selora.lol)
 *   SELORA_API_KEY — when set, the tour logs in with it (stored locally) so
 *                    the balance step can run; without it the tour stops
 *                    after models.
 *
 * Honest by design: any failing step prints the CLI's own stderr and the
 * script exits with that step's non-zero exit code — no errors are swallowed.
 * Requires Node ≥ 20. ESM only.
 */

import { spawnSync } from 'node:child_process';

const BIN = process.env.SELORA_BIN ?? 'selora';
const KEY = process.env.SELORA_API_KEY;

/** Run one CLI invocation; print its output under a section header. */
function step(title, args, { stdin } = {}) {
  console.log(`\n=== ${title} ===`);
  console.log(`$ ${[BIN, ...args].join(' ')}`);
  const res = spawnSync(BIN, args, {
    encoding: 'utf8',
    input: stdin,
    env: process.env,
  });
  if (res.stdout && res.stdout.length > 0) process.stdout.write(res.stdout);
  if (res.stderr && res.stderr.length > 0) process.stderr.write(res.stderr);
  if (res.status !== 0) {
    console.error(`\nbasic-tour: step "${title}" failed with exit code ${res.status}.`);
    process.exit(res.status ?? 1);
  }
}

step('CLI version', ['--version']);
step('Available models (no auth needed)', ['models']);

if (KEY === undefined) {
  console.log(
    '\nbasic-tour: SELORA_API_KEY is not set — skipping login and balance.' +
      '\nRe-run with SELORA_API_KEY=sk-gw-… to include the authenticated steps.',
  );
  process.exit(0);
}

// login --key reads the key from piped stdin when the value is omitted.
step('Login with SELORA_API_KEY', ['login', '--key'], { stdin: `${KEY}\n` });
step('Balance (wallet + spend windows)', ['balance']);

console.log('\nbasic-tour: done.');
