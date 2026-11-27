'use strict';

/**
 * Load `@fabric/core` `functions/passport`, `Key.Accounts`,
 * `functions/fabricIdentitySchnorr`, and the matching `types/key` and
 * `types/message` from one core tree: FABRIC_CORE when set, else this
 * package's `node_modules`. `fabric:` helpers are `Message` statics.
 *
 * All of them come from the same root so keys and messages agree. Webpack
 * aliases this file to `fabricPassportCore.browser.js` for the extension bundle.
 */

const fs = require('fs');
const path = require('path');
const messageFabricUri = require('./messageFabricUri');

function coreRoots () {
  const roots = [];
  const env = (typeof process !== 'undefined' && process.env) || {};
  if (env.FABRIC_CORE) roots.push(path.resolve(env.FABRIC_CORE));
  roots.push(path.resolve(__dirname, '../../node_modules/@fabric/core'));
  return roots;
}

function loadFabricPassport () {
  for (const root of coreRoots()) {
    const file = path.join(root, 'functions', 'passport.js');
    const keyFile = path.join(root, 'types', 'key.js');
    const messageFile = path.join(root, 'types', 'message.js');
    if (!fs.existsSync(file) || !fs.existsSync(keyFile) || !fs.existsSync(messageFile)) continue;
    const Key = require(keyFile);
    const Message = require(messageFile);
    if (!Key.Accounts || typeof Message.encodeFabricUri !== 'function') continue;
    return {
      passport: require(file),
      accountKeys: Key.Accounts,
      identitySchnorr: require(path.join(root, 'functions', 'fabricIdentitySchnorr.js')),
      Key,
      Message,
      fabricUri: messageFabricUri(Message)
    };
  }
  return { passport: null, accountKeys: null, identitySchnorr: null, Key: null, Message: null, fabricUri: null };
}

module.exports = loadFabricPassport();
