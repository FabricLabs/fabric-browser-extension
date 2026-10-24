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

/** Page → Passport: `{ source: 'fabric-site', type, id, message: 'fabric:…' }` carrying a `SiteLoginRequest`. */
export const FABRIC_MESSAGE = 'FABRIC_MESSAGE';

/** Passport → page: `{ source: 'fabric-passport', type, id, ok, message?: 'fabric:…', error? }`. */
export const FABRIC_MESSAGE_RESULT = 'FABRIC_MESSAGE_RESULT';

/** Runtime message: content script → background with a page `fabric:` string. */
export const FABRIC_RUNTIME_FABRIC_MESSAGE = 'FABRIC_RUNTIME_FABRIC_MESSAGE';

/** Runtime message: popup → background, ask a linked desktop app to sign the pending login. */
export const FABRIC_RUNTIME_DESKTOP_SIGN = 'FABRIC_RUNTIME_DESKTOP_SIGN';

/** Runtime message: background → content script, deliver a `fabric:` result to the page. */
export const FABRIC_MESSAGE_PAGE_RESULT = 'FABRIC_MESSAGE_PAGE_RESULT';

/** chrome.storage.local key: loopback base URLs of desktop signers (Hub, GoonCitizen). */
export const FABRIC_DESKTOP_SIGNERS_KEY = 'fabric.desktop.signers';

/** Runtime message: background/popup → content script, legacy `/sessions` login result. */
export const FABRIC_SITE_LOGIN_PAGE_RESULT = 'FABRIC_SITE_LOGIN_PAGE_RESULT';
