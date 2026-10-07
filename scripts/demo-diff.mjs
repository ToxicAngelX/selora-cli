#!/usr/bin/env node
/**
 * scripts/demo-diff.mjs — a guided tour of the v1.3 diff subsystem.
 *
 * Runs against the BUILT bundle (npm run demo:diff builds first via
 * predemo:diff). Every scenario renders through the same renderFileDiff the
 * chat review UI uses, with a Theme forced to truecolor (level 3) so the
 * colors survive pipes, screenshots and CI logs — the app itself auto-detects
 * the color level from the terminal and degrades honestly (NO_COLOR, mono).
 */

import {
  Theme,
  GALAXY_PALETTE,
  computeFileDiff,
  pairRenames,
  renderFileDiff,
  renderChangeSetSummary,
} from '../dist/diff/index.js';

const theme = new Theme(GALAXY_PALETTE, 3); // forced truecolor
const WIDTH = 92;
const BASE = { width: WIDTH, scheme: 'dark' }; // pinned: deterministic output

let first = true;
function header(title) {
  const label = `── ${title} `;
  if (!first) console.log();
  first = false;
  console.log(theme.dim(label + '─'.repeat(Math.max(0, WIDTH - label.length))));
}

function show(diff, opts = {}) {
  for (const row of renderFileDiff(diff, theme, { ...BASE, ...opts })) console.log(row);
}

// ---------------------------------------------------------------------------
// The fixture: format.ts, edited in the middle of the file.
// ---------------------------------------------------------------------------

const formatBefore =
  [
    "import { getExchangeRate } from './rates.js';",
    "import { round } from './math.js';",
    '',
    '// Format a price for display in the storefront.',
    'export function formatPrice(price, currency) {',
    '  const rate = getExchangeRate(currency);',
    '  const total = price * rate;',
    '  return total.toFixed(2);',
    '}',
    '',
    'export function formatDate(d) {',
    '  return d.toISOString().slice(0, 10);',
    '}',
  ].join('\n') + '\n';

const formatAfter =
  [
    "import { getExchangeRate } from './rates.js';",
    "import { round } from './math.js';",
    '',
    '// Format a price for display in the storefront.',
    "export function formatPrice(price, currency = 'USD') {",
    '  const rate = getExchangeRate(currency);',
    '  const total = round(price * rate);',
    '  return `${total.toFixed(2)} ${currency}`;',
    '}',
    '',
    'export function formatDate(d) {',
    '  return d.toISOString().slice(0, 10);',
    '}',
  ].join('\n') + '\n';

const modifiedDiff = computeFileDiff({
  kind: 'modified',
  path: 'src/utils/format.ts',
  oldText: formatBefore,
  newText: formatAfter,
});

header('1 · modified file (word-level highlights)');
show(modifiedDiff);

// ---------------------------------------------------------------------------

const clampText =
  [
    '/** Clamp n into [lo, hi]. */',
    'export function clamp(n, lo, hi) {',
    '  return Math.min(hi, Math.max(lo, n));',
    '}',
  ].join('\n') + '\n';

const createdDiff = computeFileDiff({
  kind: 'created',
  path: 'src/utils/clamp.ts',
  newText: clampText,
});

header('2 · created file');
show(createdDiff);

// ---------------------------------------------------------------------------

const loggerText =
  [
    '// DEPRECATED — superseded by src/ui/log.ts',
    'export function log(msg) {',
    "  process.stderr.write('[legacy] ' + msg + '\\n');",
    '}',
  ].join('\n') + '\n';

const deletedDiff = computeFileDiff({
  kind: 'deleted',
  path: 'src/legacy/logger.ts',
  oldText: loggerText,
});

header('3 · deleted file');
show(deletedDiff);

// ---------------------------------------------------------------------------

const utilBefore =
  [
    'export function clamp(n, lo, hi) {',
    '  return Math.min(hi, Math.max(lo, n));',
    '}',
    'export function lerp(a, b, t) {',
    '  return a + (b - a) * t;',
    '}',
  ].join('\n') + '\n';

const utilsAfter =
  [
    'export function clamp(n: number, lo: number, hi: number): number {',
    '  return Math.min(hi, Math.max(lo, n));',
    '}',
    'export function lerp(a: number, b: number, t: number): number {',
    '  return a + (b - a) * t;',
    '}',
  ].join('\n') + '\n';

// pairRenames merges a deleted+created pair into ONE renamed change when the
// content similarity clears the threshold (default 0.6).
const [renamedChange] = pairRenames([
  { kind: 'deleted', path: 'src/util.js', oldText: utilBefore },
  { kind: 'created', path: 'src/utils.ts', newText: utilsAfter },
]);
const renamedDiff = computeFileDiff(renamedChange);

header('4 · rename + content change (paired by similarity)');
show(renamedDiff);

// ---------------------------------------------------------------------------

header('5 · split view (140 columns)');
show(modifiedDiff, { view: 'split', width: 140 });

// ---------------------------------------------------------------------------

const stepsBefore = [];
const stepsAfter = [];
for (let i = 1; i <= 40; i += 1) {
  stepsBefore.push(`export const step${i} = ${i};`);
  stepsAfter.push(
    i % 2 === 0 ? `export const step${i} = ${i * 100};` : `export const step${i} = ${i};`,
  );
}
const longDiff = computeFileDiff({
  kind: 'modified',
  path: 'src/generated/steps.ts',
  oldText: stepsBefore.join('\n') + '\n',
  newText: stepsAfter.join('\n') + '\n',
});

header('6 · long diff, capped by maxLines');
show(longDiff, { maxLines: 16 });

// ---------------------------------------------------------------------------

// String.fromCharCode(0) = the NUL byte — the engine's binary tell (a literal
// escape would survive here too, but this spelling greps better).
const NUL = String.fromCharCode(0);
const pngBefore = ['\x89PNG\r\n\x1a\n', NUL, 'IHDR', NUL, NUL, 'old pixels'].join('');
const pngAfter = ['\x89PNG\r\n\x1a\n', NUL, 'IHDR', NUL, NUL, 'new pixels, larger'].join('');
const binaryDiff = computeFileDiff({
  kind: 'modified',
  path: 'assets/logo.png',
  oldText: pngBefore,
  newText: pngAfter,
});

header('7 · binary change');
show(binaryDiff);

// ---------------------------------------------------------------------------

header('8 · the same diff, colorblind palette');
show(modifiedDiff, { palette: 'colorblind' });

// ---------------------------------------------------------------------------

header('change-set summary');
for (const row of renderChangeSetSummary(
  [modifiedDiff, createdDiff, deletedDiff, renamedDiff, binaryDiff],
  theme,
))
  console.log(row);

console.log();
console.log('(demo rendered with forced truecolor; your terminal auto-detects)');
