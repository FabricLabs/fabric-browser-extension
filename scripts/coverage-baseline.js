'use strict';

/**
 * Copies c8 `coverage-summary.json` into `reports/coverage-baseline.json` for diffing in CI.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const summary = path.join(root, 'coverage', 'coverage-summary.json');
const outDir = path.join(root, 'reports');
const outFile = path.join(outDir, 'coverage-baseline.json');

if (!fs.existsSync(summary)) {
  console.error('[coverage-baseline] Run `npm run coverage` first (missing coverage/coverage-summary.json).');
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(summary, outFile);
console.log('[coverage-baseline] Wrote', outFile);
