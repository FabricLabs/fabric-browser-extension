'use strict';

/** Page → content script `postMessage` source (must match page origin). */
export const FABRIC_SITE_POSTMESSAGE_SOURCE = 'fabric-site';

/** Page → Passport: `{ source: 'fabric-site', type, challenge: 'fabric:…' }` with a transferred `MessagePort`. */
export const PASSPORT_CHALLENGE = 'PASSPORT_CHALLENGE';

/** Passport → page, on that port only: `{ type, ok: true, assertion }` or `{ type, ok: false, error }`. */
export const PASSPORT_ASSERTION = 'PASSPORT_ASSERTION';

/** `data-fabric-passport` value pages look for (protocol version, not the extension id). */
export const PASSPORT_MARKER_VERSION = '2';

/** chrome.storage.session key: pending sign-ins, one per tab and frame. */
export const FABRIC_PENDING_PASSPORT_KEY = 'fabric_pending_passport';

/** chrome.storage.session key: challenge nonces already queued (replay guard). */
export const FABRIC_PASSPORT_SEEN_NONCES_KEY = 'fabric_passport_seen_nonces';

/** Runtime message: content script → background with a page challenge. */
export const FABRIC_RUNTIME_PASSPORT_CHALLENGE = 'FABRIC_RUNTIME_PASSPORT_CHALLENGE';

/** Runtime messages: popup ↔ background for the pending sign-ins. */
export const FABRIC_RUNTIME_PASSPORT_LIST = 'FABRIC_RUNTIME_PASSPORT_LIST';
export const FABRIC_RUNTIME_PASSPORT_ANSWER = 'FABRIC_RUNTIME_PASSPORT_ANSWER';

/** Runtime message: popup → background, ask a linked desktop app to answer a pending sign-in. */
export const FABRIC_RUNTIME_DESKTOP_SIGN = 'FABRIC_RUNTIME_DESKTOP_SIGN';

/** Runtime message: background → content script, deliver the answer to the page's port. */
export const FABRIC_PASSPORT_PAGE_RESULT = 'FABRIC_PASSPORT_PAGE_RESULT';

/** chrome.storage.local key: loopback base URLs of desktop signers (Hub, GoonCitizen). */
export const FABRIC_DESKTOP_SIGNERS_KEY = 'fabric.desktop.signers';
