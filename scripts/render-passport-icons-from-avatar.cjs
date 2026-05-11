'use strict';

/**
 * Rasterize the Fabric `Avatar` type from **`@fabric/http`** (`types/avatar.js`, export
 * `@fabric/http/types/avatar`) to PNGs under `assets/icons/` for the Web Store (128×128)
 * and extension toolbar sizes.
 *
 * Fallback if the package is not installed: `FABRIC_HTTP=/path/to/fabric-http` or a sibling
 * `../fabric-http` checkout.
 *
 * Seed: `FABRIC_PASSPORT_AVATAR_SEED` (default `@fabric/passport`).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

function loadFabricAvatarClass () {
  try {
    return require('@fabric/http/types/avatar');
  } catch (primary) {
    const candidates = [];
    if (process.env.FABRIC_HTTP) {
      candidates.push(path.join(path.resolve(process.env.FABRIC_HTTP), 'types', 'avatar.js'));
    }
    candidates.push(path.join(__dirname, '..', 'node_modules', '@fabric', 'http', 'types', 'avatar.js'));
    candidates.push(path.join(__dirname, '..', '..', 'fabric-http', 'types', 'avatar.js'));
    for (const file of candidates) {
      if (file && fs.existsSync(file)) {
        try {
          return require(file);
        } catch (_) {
          /* continue */
        }
      }
    }
    const hint = 'npm install (needs @fabric/http) or set FABRIC_HTTP to a local fabric-http clone.';
    const err = new Error(`Could not load Fabric Avatar from @fabric/http. ${hint}`);
    err.cause = primary;
    throw err;
  }
}

const Avatar = loadFabricAvatarClass();

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'icons');

const SEED = process.env.FABRIC_PASSPORT_AVATAR_SEED || '@fabric/passport';

/** Each entry: output filename and square pixel size (Avatar SVG is rendered at this size). */
const OUTPUTS = [
  { file: 'icon16.png', size: 16 },
  { file: 'icon24.png', size: 24 },
  { file: 'icon32.png', size: 32 },
  { file: 'icon48.png', size: 48 },
  { file: 'icon128.png', size: 128 },
  { file: 'icon192.png', size: 192 },
  { file: 'logo.png', size: 128 },
  { file: 'chrome-store-icon-128.png', size: 128 }
];

async function main () {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  for (const { file, size } of OUTPUTS) {
    const avatar = new Avatar(SEED, { size, cells: 9, steps: 96 });
    const svg = Buffer.from(avatar.toSVG(), 'utf8');
    const outPath = path.join(OUT_DIR, file);
    await sharp(svg).resize(size, size).png().toFile(outPath);
    console.log('Wrote', path.relative(ROOT, outPath), `(${size}×${size})`);
  }
  console.log(`Done. Seed: ${JSON.stringify(SEED)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
