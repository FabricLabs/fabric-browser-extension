'use strict';

/**
 * Load `@fabric/core` `functions/fabricSiteLogin` + `functions/fabricUri` (and the
 * matching `types/key`) from one core tree: FABRIC_CORE, the sibling
 * `fabric-clean` checkout, then this package's `node_modules`.
 *
 * All three come from the same root so keys and messages agree. Webpack aliases
 * this file to `fabricSiteLoginCore.browser.js` for the extension bundle.
 */

const fs = require('fs');
const path = require('path');

function coreRoots () {
  const roots = [];
  if (typeof process !== 'undefined' && process.env && process.env.FABRIC_CORE) {
    roots.push(path.resolve(process.env.FABRIC_CORE));
  }
  roots.push(path.resolve(__dirname, '../../../fabric-clean'));
  roots.push(path.resolve(__dirname, '../../node_modules/@fabric/core'));
  return roots;
}

function loadFabricSiteLogin () {
  for (const root of coreRoots()) {
    const file = path.join(root, 'functions', 'fabricSiteLogin.js');
    if (fs.existsSync(file)) {
      return {
        siteLogin: require(file),
        fabricUri: require(path.join(root, 'functions', 'fabricUri.js')),
        Key: require(path.join(root, 'types', 'key.js'))
      };
    }
  }
  return { siteLogin: null, fabricUri: null, Key: null };
}

module.exports = loadFabricSiteLogin();
