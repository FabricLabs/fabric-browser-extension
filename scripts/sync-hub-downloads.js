#!/usr/bin/env node
'use strict';

/**
 * Copy packaged Passport zips into a sibling hub.fabric.pub `/downloads/extension/`.
 *
 * Usage:
 *   npm run sync:hub-downloads -- [--dry-run] [--hub-root ../hub.fabric.pub]
 *
 * Env: FABRIC_HUB_ROOT — absolute/relative path to hub.fabric.pub
 */

const fs = require('fs');
const path = require('path');
const { listBuildArtifacts, pickPrimaryZip } = require('./lib/publishPassportBuilds.cjs');

const root = path.resolve(__dirname, '..');

function printHelp () {
  console.log(`Usage:
  npm run sync:hub-downloads -- [options]

  Copy zip/fabric-passport-v*.zip into sibling Hub assets/downloads/extension/
  and regenerate that Hub's downloads index.json (without wiping mac/win/linux).

  --dry-run              List targets; do not copy
  --all                  Sync every matching zip (default: newest only)
  --hub-root <path>      hub.fabric.pub repo root (default FABRIC_HUB_ROOT or ../hub.fabric.pub)
`);
}

function parseArgs (argv) {
  const opts = {
    dryRun: false,
    latestOnly: true,
    hubRoot: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--all') {
      opts.latestOnly = false;
    } else if (a === '--latest-only') {
      opts.latestOnly = true;
    } else if (a === '--hub-root') {
      opts.hubRoot = argv[++i];
    } else if (a.startsWith('--hub-root=')) {
      opts.hubRoot = a.slice('--hub-root='.length);
    } else if (a.startsWith('-')) {
      throw new Error('unknown flag: ' + a);
    } else {
      throw new Error('unexpected argument: ' + a);
    }
  }
  return opts;
}

function resolveHubRoot (override) {
  const raw = override || process.env.FABRIC_HUB_ROOT || path.join(root, '..', 'hub.fabric.pub');
  return path.resolve(root, raw);
}

function main () {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  let artifacts = listBuildArtifacts(root, { zip: true });
  if (opts.latestOnly) {
    const primary = pickPrimaryZip(artifacts);
    artifacts = primary ? [primary] : [];
  }
  if (!artifacts.length) {
    console.error('[SYNC:HUB-DOWNLOADS] no zip — run npm run package first');
    return 1;
  }

  const hubRoot = resolveHubRoot(opts.hubRoot);
  const syncPath = path.join(hubRoot, 'libs', 'hub-operator', 'hubDownloadsIndex.js');
  if (!fs.existsSync(syncPath)) {
    console.error('[SYNC:HUB-DOWNLOADS] Hub downloads helper not found at', syncPath);
    console.error('[SYNC:HUB-DOWNLOADS] set --hub-root or FABRIC_HUB_ROOT to hub.fabric.pub');
    return 1;
  }

  console.log('[SYNC:HUB-DOWNLOADS] hub', hubRoot);
  for (const row of artifacts) {
    console.log('[SYNC:HUB-DOWNLOADS]', row.name, '→', 'assets/downloads/extension/' + row.name);
  }

  if (opts.dryRun) {
    console.log('[SYNC:HUB-DOWNLOADS] dry-run — ' + artifacts.length + ' file(s)');
    return 0;
  }

  const { syncPassportExtensionDownloads } = require(syncPath);
  const result = syncPassportExtensionDownloads({
    passportZipPaths: artifacts.map((a) => a.path),
    destDir: path.join(hubRoot, 'assets', 'downloads')
  });
  console.log('[SYNC:HUB-DOWNLOADS]', JSON.stringify(result));
  return 0;
}

try {
  process.exit(main() || 0);
} catch (err) {
  console.error('[SYNC:HUB-DOWNLOADS]', err && err.message ? err.message : err);
  process.exit(1);
}
