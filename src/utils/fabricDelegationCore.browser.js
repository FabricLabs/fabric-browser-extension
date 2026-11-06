'use strict';

/** Browser build of `loadFabricDelegation.js`; `fabric-delegation-core` is a webpack alias for the core root. */
const Delegation = require('fabric-delegation-core/types/delegation');

module.exports = {
  delegation: Delegation,
  Delegation,
  Key: require('fabric-delegation-core/types/key'),
  fabricUri: require('fabric-delegation-core/functions/fabricUri')
};
