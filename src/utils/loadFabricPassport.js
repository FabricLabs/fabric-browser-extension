'use strict';

/**
 * Load `@fabric/core` `functions/passport`, `functions/accountKeys`,
 * `functions/fabricIdentitySchnorr`, and the matching `types/key` from one core
 * tree: FABRIC_CORE, the sibling `fabric-clean` checkout (not in production
 * unless FABRIC_CORE is set), then this package's `node_modules`.
 *
 * All of them come from the same root so keys and messages agree. Webpack
 * aliases this file to `fabricPassportCore.browser.js` for the extension bundle.
 */

const fs = require('fs');
const path = require('path');

function coreRoots () {
  const roots = [];
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.FABRIC_CORE) roots.push(path.resolve(env.FABRIC_CORE));
  if (env.FABRIC_CORE || env.NODE_ENV !== 'production') {
    roots.push(path.resolve(__dirname, '../../../fabric-clean'));
  }
  roots.push(path.resolve(__dirname, '../../node_modules/@fabric/core'));
  return roots;
}

function loadFabricPassport () {
  for (const root of coreRoots()) {
    const file = path.join(root, 'functions', 'passport.js');
    if (fs.existsSync(file)) {
      return {
        passport: require(file),
        accountKeys: require(path.join(root, 'functions', 'accountKeys.js')),
        identitySchnorr: require(path.join(root, 'functions', 'fabricIdentitySchnorr.js')),
        Key: require(path.join(root, 'types', 'key.js'))
      };
    }
  }
  return { passport: null, accountKeys: null, identitySchnorr: null, Key: null };
}

module.exports = loadFabricPassport();
