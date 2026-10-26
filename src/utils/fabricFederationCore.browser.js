'use strict';

/** Browser build of `loadFabricFederation.js`; `fabric-federation-core` is a webpack alias for the core root. */
module.exports = {
  Federation: require('fabric-federation-core/types/federation'),
  Message: require('fabric-federation-core/types/message'),
  Key: require('fabric-federation-core/types/key'),
  fabricUri: require('fabric-federation-core/functions/fabricUri')
};
