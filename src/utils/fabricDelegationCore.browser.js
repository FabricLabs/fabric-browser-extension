'use strict';

/** Browser build of `loadFabricDelegation.js`; `fabric-delegation-core` is a webpack alias for the core root. */
module.exports = {
  delegation: require('fabric-delegation-core/functions/delegation'),
  Delegation: require('fabric-delegation-core/types/delegation'),
  Key: require('fabric-delegation-core/types/key'),
  fabricUri: require('fabric-delegation-core/functions/fabricUri')
};
