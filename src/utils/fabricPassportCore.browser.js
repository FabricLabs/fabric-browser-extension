'use strict';

/** Browser build of `loadFabricPassport.js`; `fabric-passport-core` is a webpack alias for the core root. */
const messageFabricUri = require('./messageFabricUri');
const Key = require('fabric-passport-core/types/key');
const Message = require('fabric-passport-core/types/message');

module.exports = {
  passport: require('fabric-passport-core/functions/passport'),
  accountKeys: Key.Accounts,
  identitySchnorr: require('fabric-passport-core/functions/fabricIdentitySchnorr'),
  Key,
  Message,
  fabricUri: messageFabricUri(Message)
};
