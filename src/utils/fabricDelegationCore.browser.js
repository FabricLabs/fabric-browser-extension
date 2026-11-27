'use strict';

/** Browser build of `loadFabricDelegation.js`; `fabric-delegation-core` is a webpack alias for the core root. */
const messageFabricUri = require('./messageFabricUri');
const Delegation = require('fabric-delegation-core/types/delegation');
const Message = require('fabric-delegation-core/types/message');

module.exports = {
  delegation: Delegation,
  Delegation,
  Key: require('fabric-delegation-core/types/key'),
  fabricUri: messageFabricUri(Message)
};
