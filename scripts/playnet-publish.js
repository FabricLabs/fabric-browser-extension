#!/usr/bin/env node
'use strict';

/**
 * Generate the Passport store zip and publish it to local/production playnet.
 *
 *   npm run playnet:publish -- [--dry-run] [--production] [--no-downloads] [--no-documents]
 */

const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');

function printHelp () {
  console.log(`Usage:
  npm run playnet:publish -- [options]

  1) npm run package          → zip/fabric-passport-v*.zip
  2) npm run publish:builds   → Hub Documents (playnet inventory)
  3) npm run sync:hub-downloads → sibling Hub /downloads/extension/

  --dry-run          Forward to publish + sync (still runs package unless --skip-package)
  --skip-package     Assume zip/ already has a current artifact
  --production       Publish Documents to hub.fabric.pub
  --no-documents     Skip Hub CreateDocument / PublishDocument
  --no-downloads     Skip sibling Hub assets/downloads sync
  --price <sats>     Forward to publish:builds
  --host <url>       Forward to publish:builds
  --hub-root <path>  Forward to sync:hub-downloads
`);
}

function parseArgs (argv) {
  const opts = {
    dryRun: false,
    skipPackage: false,
    production: false,
    documents: true,
    downloads: true,
    forward: []
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') {
      opts.help = true;
    } else if (a === '--dry-run') {
      opts.dryRun = true;
      opts.forward.push(a);
    } else if (a === '--skip-package') {
      opts.skipPackage = true;
    } else if (a === '--production') {
      opts.production = true;
      opts.forward.push(a);
    } else if (a === '--no-documents') {
      opts.documents = false;
    } else if (a === '--no-downloads') {
      opts.downloads = false;
    } else if (a === '--price' || a === '--host' || a === '--hub-root') {
      opts.forward.push(a, argv[++i]);
    } else if (a.startsWith('--price=') || a.startsWith('--host=') || a.startsWith('--hub-root=')) {
      opts.forward.push(a);
    } else if (a.startsWith('-')) {
      throw new Error('unknown flag: ' + a);
    } else {
      throw new Error('unexpected argument: ' + a);
    }
  }
  return opts;
}

function run (label, args) {
  console.log('[PLAYNET:PASSPORT]', label, args.join(' '));
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: process.env
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(label + ' failed with status ' + r.status);
  }
}

function main () {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return 0;
  }

  if (!opts.skipPackage) {
    const r = spawnSync('npm', ['run', 'package'], { cwd: root, stdio: 'inherit', env: process.env });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error('npm run package failed with status ' + r.status);
  }

  if (opts.documents) {
    const args = [path.join(root, 'scripts', 'publish-build-documents.js')];
    if (opts.dryRun) args.push('--dry-run');
    if (opts.production) args.push('--production');
    // forward price/host only (hub-root is downloads-only)
    for (let i = 0; i < opts.forward.length; i++) {
      const a = opts.forward[i];
      if (a === '--hub-root' || a.startsWith('--hub-root=')) {
        if (a === '--hub-root') i++;
        continue;
      }
      args.push(a);
    }
    run('publish:builds', args);
  }

  if (opts.downloads) {
    const args = [path.join(root, 'scripts', 'sync-hub-downloads.js')];
    if (opts.dryRun) args.push('--dry-run');
    for (let i = 0; i < opts.forward.length; i++) {
      const a = opts.forward[i];
      if (a === '--price' || a.startsWith('--price=') || a === '--host' || a.startsWith('--host=') ||
          a === '--production') {
        if (a === '--price' || a === '--host') i++;
        continue;
      }
      args.push(a);
    }
    run('sync:hub-downloads', args);
  }

  console.log('[PLAYNET:PASSPORT] done');
  return 0;
}

try {
  process.exit(main() || 0);
} catch (err) {
  console.error('[PLAYNET:PASSPORT]', err && err.message ? err.message : err);
  process.exit(1);
}
