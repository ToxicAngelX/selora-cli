#!/usr/bin/env node
// Fails if the npm tarball exceeds the size budget (default: 100 KB).
// Usage: node scripts/check-pack-size.mjs <path-to-tarball> [limitBytes]
import { statSync } from 'node:fs';

const tarball = process.argv[2];
if (!tarball) {
  console.error('Usage: node scripts/check-pack-size.mjs <tarball> [limitBytes]');
  process.exit(1);
}

const limit = Number(process.argv[3] ?? 100 * 1024);
if (!Number.isFinite(limit) || limit <= 0) {
  console.error(`Invalid size limit: ${String(process.argv[3])}`);
  process.exit(1);
}

const size = statSync(tarball).size;
const kb = (size / 1024).toFixed(1);

if (size > limit) {
  console.error(`FAIL: ${tarball} is ${kb} KB, over the ${(limit / 1024).toFixed(0)} KB budget.`);
  process.exit(1);
}

console.log(`OK: ${tarball} is ${kb} KB (limit ${(limit / 1024).toFixed(0)} KB).`);
