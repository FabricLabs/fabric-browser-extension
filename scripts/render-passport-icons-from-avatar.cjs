'use strict';

/**
 * Toolbar / store icons are the canonical Fabric lettermark (serif lowercase f).
 * Prefer `@fabric/http` `npm run make:icons` (syncs this tree). This script copies
 * from a local fabric-http checkout when you only have this repo open.
 *
 *   npm run icons:from-avatar
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

function fabricHttpRoot () {
  if (process.env.FABRIC_HTTP) return path.resolve(process.env.FABRIC_HTTP);
  const linked = path.join(ROOT, 'node_modules', '@fabric', 'http');
  const sibling = path.join(ROOT, '..', 'fabric-http');
  if (fs.existsSync(path.join(linked, 'assets', 'icons', 'icon-128.png'))) return linked;
  if (fs.existsSync(path.join(sibling, 'assets', 'icons', 'icon-128.png'))) return sibling;
  return null;
}

const MAP = [
  ['icon-16.png', 'icon16.png'],
  ['icon-24.png', 'icon24.png'],
  ['icon-32.png', 'icon32.png'],
  ['icon-48.png', 'icon48.png'],
  ['icon-128.png', 'icon128.png'],
  ['icon-192.png', 'icon192.png'],
  ['icon-128.png', 'logo.png'],
  ['icon-128.png', 'chrome-store-icon-128.png']
];

function main () {
  const httpRoot = fabricHttpRoot();
  if (!httpRoot) {
    throw new Error('Fabric lettermark PNGs not found. Run `npm run make:icons` in fabric-http (or set FABRIC_HTTP).');
  }
  const srcDir = path.join(httpRoot, 'assets', 'icons');
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const [fromName, toName] of MAP) {
    const src = path.join(srcDir, fromName);
    const dest = path.join(OUT_DIR, toName);
    fs.copyFileSync(src, dest);
    console.log('Wrote', path.relative(ROOT, dest));
  }
  const store128 = path.join(ROOT, 'store', 'icons', 'icon-128.png');
  const store512 = path.join(ROOT, 'store', 'icons', 'icon-512.png');
  fs.mkdirSync(path.dirname(store128), { recursive: true });
  fs.copyFileSync(path.join(srcDir, 'icon-128.png'), store128);
  fs.copyFileSync(path.join(srcDir, 'icon-512.png'), store512);
  console.log('Wrote', path.relative(ROOT, store128));
  console.log('Wrote', path.relative(ROOT, store512));
}

main();
