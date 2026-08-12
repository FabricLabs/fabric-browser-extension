'use strict';

/** Page → content script `postMessage` source (must match page origin). */
export const FABRIC_SITE_POSTMESSAGE_SOURCE = 'fabric-site';

/** Page asks Passport to complete a client-signed Fabric login session. */
export const FABRIC_SITE_LOGIN_REQUEST = 'FABRIC_SITE_LOGIN_REQUEST';

/** Passport → page result after approve/reject/error. */
export const FABRIC_SITE_LOGIN_RESULT = 'FABRIC_SITE_LOGIN_RESULT';

/** chrome.storage.session key for a pending site-login challenge. */
export const FABRIC_PENDING_SITE_LOGIN_KEY = 'fabric_pending_site_login';

/** Runtime message: content script → background. */
export const FABRIC_RUNTIME_SITE_LOGIN_REQUEST = 'FABRIC_SITE_LOGIN_REQUEST';

/** Runtime message: popup ↔ background for pending login. */
export const FABRIC_RUNTIME_SITE_LOGIN_GET = 'FABRIC_SITE_LOGIN_GET';
export const FABRIC_RUNTIME_SITE_LOGIN_CLEAR = 'FABRIC_SITE_LOGIN_CLEAR';
export const FABRIC_RUNTIME_SITE_LOGIN_COMPLETE = 'FABRIC_SITE_LOGIN_COMPLETE';
