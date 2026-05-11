'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');
const pkg = require(path.join(root, 'package.json'));
const semverish = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;
if (!pkg.version || !semverish.test(String(pkg.version))) {
  console.error('Invalid or missing package.json version (expected semver-like x.y.z).');
  process.exit(1);
}
const safeVer = String(pkg.version).replace(/[^0-9A-Za-z._-]/g, '_');
const zipDir = path.join(root, 'zip');
const zipPath = path.join(zipDir, `fabric-passport-v${safeVer}.zip`);

if (!fs.existsSync(dist)) {
  console.error('Missing dist/. Run: npm run bundle');
  process.exit(1);
}

fs.mkdirSync(zipDir, { recursive: true });
if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

try {
  execSync(`zip -r "${zipPath}" .`, { cwd: dist, stdio: 'inherit' });
} catch (err) {
  console.error('Failed to create ZIP archive. Is the zip CLI installed?', err);
  process.exit(1);
}
const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
console.log(`Packaged: ${zipPath} (${mb} MB)`);
