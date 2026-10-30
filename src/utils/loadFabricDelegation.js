'use strict';

/**
 * Load `@fabric/core` delegation (`functions/delegation`, `types/delegation`)
 * with the `types/key` and `functions/fabricUri` of the same tree:
 * FABRIC_CORE when set, else this package's `node_modules`.
 *
 * Only a core whose pairing frames carry the author's `pubkey` qualifies.
 * Webpack aliases this file to `fabricDelegationCore.browser.js` for the bundle.
 */

const fs = require('fs');
const path = require('path');

function coreRoots () {
  const roots = [];
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.FABRIC_CORE) roots.push(path.resolve(env.FABRIC_CORE));
  roots.push(path.resolve(__dirname, '../../node_modules/@fabric/core'));
  return roots;
}

function qualifies (root) {
  const fn = path.join(root, 'functions', 'delegation.js');
  if (!fs.existsSync(fn) || !fs.existsSync(path.join(root, 'types', 'delegation.js'))) return false;
  return fs.readFileSync(fn, 'utf8').includes('pubkeys: { initiator');
}

function loadFabricDelegation () {
  for (const root of coreRoots()) {
    if (!qualifies(root)) continue;
    return {
      delegation: require(path.join(root, 'functions', 'delegation.js')),
      Delegation: require(path.join(root, 'types', 'delegation.js')),
      Key: require(path.join(root, 'types', 'key.js')),
      fabricUri: require(path.join(root, 'functions', 'fabricUri.js'))
    };
  }
  return { delegation: null, Delegation: null, Key: null, fabricUri: null };
}

module.exports = loadFabricDelegation();
