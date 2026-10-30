'use strict';

/** Page → content script `postMessage` source (must match page origin). */
export const FABRIC_SITE_POSTMESSAGE_SOURCE = 'fabric-site';

/** Page → Passport: `{ source: 'fabric-site', type, challenge: 'fabric:…' }` with a transferred `MessagePort`. */
export const PASSPORT_CHALLENGE = 'PASSPORT_CHALLENGE';

/** Passport → page, on that port only: `{ type, ok: true, assertion }` or `{ type, ok: false, error }`. */
export const PASSPORT_ASSERTION = 'PASSPORT_ASSERTION';

/**
 * Page → Passport: `{ source: 'fabric-site', type, v }` with a transferred
 * `MessagePort`; Passport answers `{ type, v }` on that port only (see
 * `@fabric/http` `probePassport`). Nothing is written into the page's DOM.
 */
export const PASSPORT_HELLO = 'PASSPORT_HELLO';
export const PASSPORT_PROTOCOL = 2;

/** chrome.storage.session key: pending sign-ins, one per tab and frame. */
export const FABRIC_PENDING_PASSPORT_KEY = 'fabric_pending_passport';

/** chrome.storage.session key: challenge nonces already queued (replay guard). */
export const FABRIC_PASSPORT_SEEN_NONCES_KEY = 'fabric_passport_seen_nonces';

/** Runtime message: content script → background with a page challenge. */
export const FABRIC_RUNTIME_PASSPORT_CHALLENGE = 'FABRIC_RUNTIME_PASSPORT_CHALLENGE';

/** Runtime messages: popup ↔ background for the pending sign-ins. */
export const FABRIC_RUNTIME_PASSPORT_LIST = 'FABRIC_RUNTIME_PASSPORT_LIST';
export const FABRIC_RUNTIME_PASSPORT_ANSWER = 'FABRIC_RUNTIME_PASSPORT_ANSWER';

/** Runtime message: popup → background, ask a linked signer to answer a pending sign-in. */
export const FABRIC_RUNTIME_DELEGATE_SIGN_IN = 'FABRIC_RUNTIME_DELEGATE_SIGN_IN';

/** Runtime message: background → content script, deliver the answer to the page's port. */
export const FABRIC_PASSPORT_PAGE_RESULT = 'FABRIC_PASSPORT_PAGE_RESULT';

/** chrome.storage.local key: loopback base URLs where linked signers may answer (Hub, GoonCitizen). */
export const FABRIC_DELEGATE_BASES_KEY = 'fabric.delegate.bases';
