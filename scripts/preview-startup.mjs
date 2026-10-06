#!/usr/bin/env node
/**
 * Dev-only eyeball harness for the startup screen — never shipped (scripts/
 * is not in package.json "files"). Bundles src/ui/{logo,theme,animate}.ts
 * with the already-installed tsup JS API into node_modules/.cache, imports
 * the bundle, and plays the intro on the REAL stdout — the exact production
 * render + playback path, no login or API key needed.
 *
 * Usage: node scripts/preview-startup.mjs [theme] [--width N] [--frames N] [--static]
 *   theme       galaxy (default) | nebula | aurora | mono
 *   --width N   render as if the terminal were N columns (default: real width)
 *   --frames N  frame count (default: STARTUP_FRAME_COUNT = 9)
 *   --static    print only the final frame, no animation
 *
 * Try: NO_COLOR=1 node scripts/preview-startup.mjs   (zero escapes)
 */

import { build } from 'tsup';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
let themeName = 'galaxy';
let width;
let frames;
let staticOnly = false;
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if (a === '--width') width = Number.parseInt(args[++i] ?? '', 10);
  else if (a === '--frames') frames = Number.parseInt(args[++i] ?? '', 10);
  else if (a === '--static') staticOnly = true;
  else if (!a.startsWith('--')) themeName = a;
}
if (!Number.isFinite(width)) width = undefined;
if (!Number.isFinite(frames)) frames = undefined;

const outDir = join(process.cwd(), 'node_modules', '.cache', 'selora-preview');
mkdirSync(outDir, { recursive: true });
await build({
  entry: {
    'ui/logo': 'src/ui/logo.ts',
    'ui/theme': 'src/ui/theme.ts',
    'ui/animate': 'src/ui/animate.ts',
  },
  outDir,
  format: 'esm',
  silent: true,
});

const bust = `?t=${Date.now()}`;
const load = (p) => import(pathToFileURL(join(outDir, p)).href + bust);
const logo = await load('ui/logo.js');
const themeMod = await load('ui/theme.js');
const animate = await load('ui/animate.js');

const theme = themeMod.themeFor(themeName, process.stdout.isTTY === true);
const info = {
  version: '0.3.0-preview',
  model: 'glm-5.3-flash (GLM 5.3 Flash)',
  cwd: process.cwd(),
  plan: 'Supernova',
};
const w = width ?? process.stdout.columns ?? 80;
const all = logo.renderStartupFrames(info, theme, { width: w, frames });

if (staticOnly || process.stdout.isTTY !== true || theme.level === 0) {
  // The static path — exactly what chat prints when animation is off.
  process.stdout.write(`${all[all.length - 1].join('\n')}\n`);
} else {
  await animate.playFrames(all, {
    write: (s) => process.stdout.write(s),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
}
