'use strict';

/** Browser build of `loadFabricSiteLogin.js`; `fabric-site-login-core` is a webpack alias for the core root. */
module.exports = {
  siteLogin: require('fabric-site-login-core/functions/fabricSiteLogin'),
  fabricUri: require('fabric-site-login-core/functions/fabricUri'),
  Key: require('fabric-site-login-core/types/key')
};
