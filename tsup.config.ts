import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the CLI (index) and the diff subsystem's programmatic API
  // (diff/index — `npm run demo:diff` imports it). ESM code-splitting shares
  // the common chunks, so the diff code ships once. The diff entry's d.ts is
  // NOT published (package.json files): it keeps the CLI's type surface small.
  entry: { index: 'src/index.ts', 'diff/index': 'src/diff/index.ts' },
  format: ['esm'],
  target: 'node20',
  bundle: true,
  minify: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
  clean: true,
  dts: true,
});
