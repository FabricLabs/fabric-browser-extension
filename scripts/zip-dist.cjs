'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const zipDir = path.join(root, 'zip');
const zipPath = path.join(zipDir, `fabric-passport-v${pkg.version}.zip`);

if (!fs.existsSync(dist)) {
  console.error('Missing dist/. Run: npm run bundle');
  process.exit(1);
}

fs.mkdirSync(zipDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

execSync(`zip -r "${zipPath}" .`, { cwd: dist, stdio: 'inherit' });
const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`Packaged: ${zipPath} (${mb} MB)`);
