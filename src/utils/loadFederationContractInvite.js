'use strict';

/**
 * Load `@fabric/http/functions/federationContractInvite` from this package's
 * dependency tree (or FABRIC_HTTP / sibling checkout).
 *
 * Plain `require('@fabric/http/...')` can resolve a parent workspace's older
 * `@fabric/http` (missing the export). `createRequire` from Passport's
 * package.json keeps resolution rooted here.
 *
 * Webpack aliases the package subpath to the same module for the browser build.
 */

const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');

function loadFederationContractInvite () {
  const candidates = [];
  if (typeof process !== 'undefined' && process.env && process.env.FABRIC_HTTP) {
    candidates.push(
      path.join(path.resolve(process.env.FABRIC_HTTP), 'functions', 'federationContractInvite.js')
    );
  }
  candidates.push(
    path.resolve(__dirname, '../../../fabric-http/functions/federationContractInvite.js')
  );
  candidates.push(
    path.resolve(__dirname, '../../node_modules/@fabric/http/functions/federationContractInvite.js')
  );

  for (const file of candidates) {
    if (file && fs.existsSync(file)) {
      return require(file);
    }
  }

  const rootReq = createRequire(path.resolve(__dirname, '../../package.json'));
  return rootReq('@fabric/http/functions/federationContractInvite');
}

module.exports = loadFederationContractInvite();
