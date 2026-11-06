'use strict';

/**
 * Load `@fabric/core` `types/federation` (named federations: descriptors,
 * withdrawals, member messages) with the `types/message`, `types/key`, and
 * `functions/fabricUri` of the same tree: FABRIC_CORE when set, else this
 * package's `node_modules`.
 *
 * Only a core whose `Federation` carries the member messages qualifies.
 * Webpack aliases this file to `fabricFederationCore.browser.js` for the bundle.
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

function loadFabricFederation () {
  for (const root of coreRoots()) {
    const file = path.join(root, 'types', 'federation.js');
    if (!fs.existsSync(file) || !fs.readFileSync(file, 'utf8').includes('MESSAGE_TYPES')) continue;
    return {
      Federation: require(file),
      Message: require(path.join(root, 'types', 'message.js')),
      Key: require(path.join(root, 'types', 'key.js')),
      fabricUri: require(path.join(root, 'functions', 'fabricUri.js'))
    };
  }
  return { Federation: null, Message: null, Key: null, fabricUri: null };
}

module.exports = loadFabricFederation();
