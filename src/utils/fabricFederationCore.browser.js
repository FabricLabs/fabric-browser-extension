'use strict';

/** Browser build of `loadFabricFederation.js`; `fabric-federation-core` is a webpack alias for the core root. */
const messageFabricUri = require('./messageFabricUri');
const Message = require('fabric-federation-core/types/message');

module.exports = {
  Federation: require('fabric-federation-core/types/federation'),
  Message,
  Key: require('fabric-federation-core/types/key'),
  fabricUri: messageFabricUri(Message)
};
