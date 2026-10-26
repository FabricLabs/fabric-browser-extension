#!/usr/bin/env node
'use strict';

/**
 * Publish Fabric Passport store zips into the Hub Documents catalog (playnet).
 *
 * Usage:
 *   npm run package
 *   npm run publish:builds -- [--dry-run] [--production] [--price N]
 *
 * Env: FABRIC_HUB_RPC_URL / FABRIC_HUB_URL (default http://127.0.0.1:8080)
 *      FABRIC_HUB_ADMIN_TOKEN (optional Bearer for hardened Hubs)
 *      FABRIC_PLAYNET_PRODUCTION=1 same as --production
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  listBuildArtifacts,
  pickPrimaryZip,
  hubBase,
  publishArtifact
} = require('./lib/publishPassportBuilds.cjs');

const root = path.resolve(__dirname, '..');

function printHelp () {
  console.log(`Usage:
  npm run publish:builds -- [options]

  Publish zip/fabric-passport-v*.zip into the Hub Documents catalog so playnet
  peers see it on inventory / Documents. Requires a reachable Hub JSON-RPC
  surface (local desktop Hub or --production hub.fabric.pub).

  --dry-run          List artifacts; do not POST
  --package          Run npm run package first (bundle + zip)
  --production       Target https://hub.fabric.pub (or FABRIC_HUB_RPC_URL)
  --latest-only      Publish only the newest zip (default: all matching zips)
  --all              Publish every fabric-passport-v*.zip under zip/
  --price <sats>     purchasePriceSats on PublishDocument (default free)
  --host <url>       Hub HTTP origin (overrides --production / env)

Env: FABRIC_HUB_RPC_URL, FABRIC_HUB_URL, FABRIC_HUB_ADMIN_TOKEN,
     FABRIC_PLAYNET_PRODUCTION, FABRIC_HUB_RPC_TIMEOUT_MS

  On a loopback Hub with FABRIC_HUB_ADMIN_TOKEN (or ~/.fabric/hub-admin-token),
  CreateDocument uses filePath ingest (no multi-MiB base64). A remote Hub, or no
  token, gets contentBase64, which needs @fabric/http JSON body limit ≥12mb
  (default after RSI cut); remote Hubs only see FABRIC_HUB_ADMIN_TOKEN.
`);
}

function parsePrice (v) {
  const n = Number(v);
  if (v == null || String(v).trim() === '' || !Number.isFinite(n)) {
    throw new Error('invalid --price value: ' + v);
  }
  return Math.max(0, Math.floor(n));
}

function parseArgs (argv) {
  const opts = {
    dryRun: false,
    doPackage: false,
    production: false,
    latestOnly: true,
    price: null,
    host: null
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--package') {
      opts.doPackage = true;
    } else if (a === '--production') {
      opts.production = true;
    } else if (a === '--latest-only') {
      opts.latestOnly = true;
    } else if (a === '--all') {
      opts.latestOnly = false;
    } else if (a === '--price' || a === '--purchasePriceSats') {
      opts.price = parsePrice(argv[++i]);
    } else if (a === '--host') {
      opts.host = argv[++i];
    } else if (a.startsWith('--price=')) {
      opts.price = parsePrice(a.slice('--price='.length));
    } else if (a.startsWith('--host=')) {
      opts.host = a.slice('--host='.length);
    } else if (a.startsWith('-')) {
      throw new Error('unknown flag: ' + a);
    } else {
      throw new Error('unexpected argument: ' + a);
    }
  }
  return opts;
}

function runPackage () {
  console.log('[PUBLISH:PASSPORT] npm run package…');
  const r = spawnSync('npm', ['run', 'package'], {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error('npm run package failed with status ' + r.status);
  }
}

async function main () {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (opts.doPackage) runPackage();

  let artifacts = listBuildArtifacts(root, { zip: true });
  if (opts.latestOnly) {
    const primary = pickPrimaryZip(artifacts);
    artifacts = primary ? [primary] : [];
  }

  if (!artifacts.length) {
    console.error('[PUBLISH:PASSPORT] no zip/fabric-passport-v*.zip — run npm run package (or --package)');
    return 1;
  }

  const host = hubBase({ host: opts.host, production: opts.production });
  console.log('[PUBLISH:PASSPORT] hub', host);
  for (const row of artifacts) {
    console.log('[PUBLISH:PASSPORT]', row.kind, row.name, row.size + 'B', row.path);
  }

  if (opts.dryRun) {
    console.log('[PUBLISH:PASSPORT] dry-run — ' + artifacts.length + ' file(s)');
    return 0;
  }

  const published = [];
  for (const row of artifacts) {
    const pubOpts = { host, production: opts.production };
    if (opts.price != null) pubOpts.purchasePriceSats = opts.price;
    const doc = await publishArtifact(row, pubOpts);
    published.push(doc);
    console.log(
      '[PUBLISH:PASSPORT] published',
      [doc.name, doc.id, doc.size + 'B', doc.via, (doc.document && doc.document.purchasePriceSats != null)
        ? (doc.document.purchasePriceSats + ' sats')
        : null].filter(Boolean).join(' ')
    );
  }
  console.log('[PUBLISH:PASSPORT] done — ' + published.length + ' document(s) on Hub');
  return 0;
}

main().then((code) => {
  process.exit(code || 0);
}).catch((err) => {
  console.error('[PUBLISH:PASSPORT]', err && err.message ? err.message : err);
  process.exit(1);
});
