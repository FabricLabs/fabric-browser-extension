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

/**
 * Peer sessions (v3): the page names a peer (its key and `ws:`/`wss:`
 * endpoints); Passport connects, signs in by the peer's key, and keeps the
 * session. Page → Passport, each with a transferred `MessagePort`:
 * `PASSPORT_PEER_CONNECT { endpoints, peer?, request?, purpose? }` →
 * `PASSPORT_PEER_SESSION { session }`; `PASSPORT_PEER_CALL { sessionId,
 * method, params }` → `PASSPORT_PEER_RESULT { result }`;
 * `PASSPORT_PEER_CLOSE { sessionId }` → `PASSPORT_PEER_CLOSED`;
 * `PASSPORT_PEER_AUTHORIZE { sessionId, url, method, body }` →
 * `PASSPORT_PEER_AUTHORIZATION { header }` (an `X-Fabric-Request` for that one
 * HTTP request).
 */
export const PASSPORT_PEER_CONNECT = 'PASSPORT_PEER_CONNECT';
export const PASSPORT_PEER_SESSION = 'PASSPORT_PEER_SESSION';
export const PASSPORT_PEER_CALL = 'PASSPORT_PEER_CALL';
export const PASSPORT_PEER_RESULT = 'PASSPORT_PEER_RESULT';
export const PASSPORT_PEER_CLOSE = 'PASSPORT_PEER_CLOSE';
export const PASSPORT_PEER_CLOSED = 'PASSPORT_PEER_CLOSED';
export const PASSPORT_PEER_AUTHORIZE = 'PASSPORT_PEER_AUTHORIZE';
export const PASSPORT_PEER_AUTHORIZATION = 'PASSPORT_PEER_AUTHORIZATION';
export const PASSPORT_PEER_PROTOCOL = 3;

/** Runtime messages: content script → background for peer sessions. */
export const FABRIC_RUNTIME_PASSPORT_PEER_CONNECT = 'FABRIC_RUNTIME_PASSPORT_PEER_CONNECT';
export const FABRIC_RUNTIME_PASSPORT_PEER_CALL = 'FABRIC_RUNTIME_PASSPORT_PEER_CALL';
export const FABRIC_RUNTIME_PASSPORT_PEER_CLOSE = 'FABRIC_RUNTIME_PASSPORT_PEER_CLOSE';
export const FABRIC_RUNTIME_PASSPORT_PEER_AUTHORIZE = 'FABRIC_RUNTIME_PASSPORT_PEER_AUTHORIZE';

/** chrome.storage.session key: private session keys of pending peer sign-ins, by request id (never listed to the popup). */
export const FABRIC_PASSPORT_PEER_KEYS_KEY = 'fabric_passport_peer_keys';

/** chrome.storage.session key: open peer sessions, by session id. */
export const FABRIC_PASSPORT_PEER_SESSIONS_KEY = 'fabric_passport_peer_sessions';

/** chrome.storage.local key: loopback base URLs where linked signers may answer (Hub, GoonCitizen). */
export const FABRIC_DELEGATE_BASES_KEY = 'fabric.delegate.bases';
