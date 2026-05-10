'use strict';

const path = require('path');
const { createRequire } = require('module');
const fileReq = createRequire(__filename);
const httpEntry = fileReq.resolve('@fabric/http/types/web');
const authPath = path.join(path.dirname(httpEntry), '..', 'middlewares', 'auth.js');
const auth = fileReq(authPath);
const buildBearerToken = auth && auth.buildBearerToken;
if (typeof buildBearerToken !== 'function') {
  throw new Error(
    '[fabricHttpBearerToken] Installed @fabric/http is too old (missing middlewares/auth buildBearerToken). ' +
      'Use a build that includes `buildBearerToken`, or `npm install` a path/git dep that has it.'
  );
}

/**
 * @param {string} secret
 * @param {Record<string, unknown>} [payload]
 * @returns {string}
 */
function makeBearerToken (secret, payload = {}) {
  return buildBearerToken(secret, payload);
}

module.exports = { makeBearerToken };
