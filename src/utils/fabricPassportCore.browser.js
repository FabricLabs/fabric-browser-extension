'use strict';

/** Browser build of `loadFabricPassport.js`; `fabric-passport-core` is a webpack alias for the core root. */
module.exports = {
  passport: require('fabric-passport-core/functions/passport'),
  accountKeys: require('fabric-passport-core/functions/accountKeys'),
  identitySchnorr: require('fabric-passport-core/functions/fabricIdentitySchnorr'),
  Key: require('fabric-passport-core/types/key')
};
