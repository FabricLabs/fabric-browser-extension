/// <reference types="chrome"/>

import {
  FABRIC_HUB_POSTMESSAGE_SOURCE,
  FABRIC_HUB_REGISTER_MESH,
  FABRIC_HUB_UNREGISTER_MESH
} from './fabric/hubMeshBridge';
import {
  FABRIC_PASSPORT_PAGE_RESULT,
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_RUNTIME_PASSPORT_PEER_AUTHORIZE,
  FABRIC_RUNTIME_PASSPORT_PEER_CALL,
  FABRIC_RUNTIME_PASSPORT_PEER_CLOSE,
  FABRIC_RUNTIME_PASSPORT_PEER_CONNECT,
  FABRIC_SITE_POSTMESSAGE_SOURCE,
  PASSPORT_ASSERTION,
  PASSPORT_CHALLENGE,
  PASSPORT_HELLO,
  PASSPORT_PEER_AUTHORIZATION,
  PASSPORT_PEER_AUTHORIZE,
  PASSPORT_PEER_CALL,
  PASSPORT_PEER_CLOSE,
  PASSPORT_PEER_CLOSED,
  PASSPORT_PEER_CONNECT,
  PASSPORT_PEER_RESULT,
  PASSPORT_PEER_PROTOCOL,
  PASSPORT_PEER_SESSION,
  PASSPORT_PROTOCOL
} from './constants/siteLogin';
import { installFabric402FetchInterceptor } from './content/fabric402FetchPatch';
import { swallowNonFatal } from './utils/nonFatal';

declare global {
  interface Window {
    fabricExtension: {
      id: string;
      chrome: typeof chrome;
    };
  }
}

// Initialize the extension
window.fabricExtension = {
  id: chrome.runtime.id,
  chrome: chrome
};

installFabric402FetchInterceptor();

/**
 * A page asks whether Passport runs here: `{ source: 'fabric-site', type:
 * 'PASSPORT_HELLO', v }` with a transferred port. The answer goes only to
 * that port, and nothing is written to the DOM.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE || data.type !== PASSPORT_HELLO) return;
  if (event.source !== window || event.origin !== window.location.origin) return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  try {
    port.postMessage({ type: PASSPORT_HELLO, v: PASSPORT_PROTOCOL, peer: PASSPORT_PEER_PROTOCOL });
    port.close();
  } catch (err: unknown) {
    swallowNonFatal('passport-hello', err);
  }
});

/** Hub (or dev) page asks the extension to keep WebRTC signaling alive after the tab closes. */
window.addEventListener('message', (event: MessageEvent) => {
  // Only this page itself, never a frame inside it posting up under its own origin.
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== FABRIC_HUB_POSTMESSAGE_SOURCE || typeof data.type !== 'string') return;

  if (data.type === FABRIC_HUB_REGISTER_MESH && typeof data.hubAddress === 'string') {
    let expectedOrigin: string;
    try {
      const raw = data.hubAddress.trim();
      const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      expectedOrigin = u.origin;
    } catch (err: unknown) {
      swallowNonFatal('hub-mesh-postmessage-url', err);
      return;
    }
    if (event.origin !== expectedOrigin) return;
    void chrome.runtime.sendMessage({
      type: FABRIC_HUB_REGISTER_MESH,
      hubAddress: data.hubAddress.trim(),
      pageOrigin: event.origin
    });
    return;
  }

  if (data.type === FABRIC_HUB_UNREGISTER_MESH) {
    void chrome.runtime.sendMessage({
      type: FABRIC_HUB_UNREGISTER_MESH,
      pageOrigin: event.origin
    });
    return;
  }
});

/**
 * Ports pages handed us with a `PASSPORT_CHALLENGE`, by request id. The answer
 * goes only to that port, so nothing else on the page can read or forge it.
 * One open sign-in per frame: a new challenge cancels the previous one.
 */
const passportPorts = new Map<string, MessagePort>();
const MAX_PASSPORT_CHALLENGE_CHARS = 48 * 1024;

/** Port answer types the background may name for a pending request. */
const PORT_TYPES = new Set([PASSPORT_ASSERTION, PASSPORT_PEER_SESSION]);

function settlePassportPort (requestId: string, payload: Record<string, unknown>, type: string = PASSPORT_ASSERTION): void {
  const port = passportPorts.get(requestId);
  if (!port) return;
  passportPorts.delete(requestId);
  try {
    port.postMessage({ type: PORT_TYPES.has(type) ? type : PASSPORT_ASSERTION, ...payload });
  } catch (err: unknown) {
    swallowNonFatal('passport-port-post', err);
  }
  try {
    port.close();
  } catch (err: unknown) {
    swallowNonFatal('passport-port-close', err);
  }
}

function randomRequestId (): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A page hands Passport a `fabric:` `PASSPORT_CHALLENGE` from its server. The
 * background reads it against the origin the browser reports for this frame
 * (`sender.origin`) — never one the page names.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE || data.type !== PASSPORT_CHALLENGE) return;
  if (event.source !== window || event.origin !== window.location.origin) return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  const challenge = typeof data.challenge === 'string' ? data.challenge.trim() : '';
  for (const id of [...passportPorts.keys()]) settlePassportPort(id, { ok: false, error: 'replaced' });
  const requestId = randomRequestId();
  passportPorts.set(requestId, port);
  if (!/^fabric:/i.test(challenge) || challenge.length > MAX_PASSPORT_CHALLENGE_CHARS) {
    settlePassportPort(requestId, { ok: false, error: 'invalid_challenge' });
    return;
  }
  if (!(navigator.userActivation && navigator.userActivation.isActive)) {
    settlePassportPort(requestId, { ok: false, error: 'user_activation' });
    return;
  }
  chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_PASSPORT_CHALLENGE, requestId, challenge }).then((res) => {
    if (!res || res.ok === false) {
      settlePassportPort(requestId, {
        ok: false,
        error: res && typeof res.error === 'string' ? res.error : 'passport_rejected'
      });
    }
  }).catch((err: unknown) => {
    swallowNonFatal('passport-challenge-runtime', err);
    settlePassportPort(requestId, { ok: false, error: 'passport_unavailable' });
  });
});

/**
 * A page asks Passport to sign in to a peer by its key: `{ source:
 * 'fabric-site', type: 'PASSPORT_PEER_CONNECT', endpoints, peer?, request?,
 * purpose? }` with a port. Passport connects itself; the page gets only the
 * session's public view on the port, never a token or key.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE || data.type !== PASSPORT_PEER_CONNECT) return;
  if (event.source !== window || event.origin !== window.location.origin) return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  for (const id of [...passportPorts.keys()]) settlePassportPort(id, { ok: false, error: 'replaced' });
  const requestId = randomRequestId();
  passportPorts.set(requestId, port);
  const fail = (error: string) => settlePassportPort(requestId, { ok: false, error }, PASSPORT_PEER_SESSION);
  if (!(navigator.userActivation && navigator.userActivation.isActive)) {
    fail('user_activation');
    return;
  }
  chrome.runtime.sendMessage({
    type: FABRIC_RUNTIME_PASSPORT_PEER_CONNECT,
    requestId,
    endpoints: Array.isArray(data.endpoints) ? data.endpoints.slice(0, 8).map(String) : [],
    peer: typeof data.peer === 'string' ? data.peer : undefined,
    request: Array.isArray(data.request) ? data.request.slice(0, 4).map(String) : [],
    purpose: typeof data.purpose === 'string' ? data.purpose.slice(0, 280) : undefined
  }).then((res) => {
    if (!res || res.ok === false) fail(res && typeof res.error === 'string' ? res.error : 'passport_rejected');
  }).catch((err: unknown) => {
    swallowNonFatal('passport-peer-connect-runtime', err);
    fail('passport_unavailable');
  });
});

/**
 * A page calls a peer as a session it opened, has Passport sign one HTTP
 * request to it, or ends it. The background answers only for this frame's
 * browser-reported origin; the answer goes to this request's port only.
 */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE) return;
  if (data.type !== PASSPORT_PEER_CALL && data.type !== PASSPORT_PEER_CLOSE && data.type !== PASSPORT_PEER_AUTHORIZE) return;
  if (event.source !== window || event.origin !== window.location.origin) return;
  const port = event.ports && event.ports[0];
  if (!port) return;
  const isCall = data.type === PASSPORT_PEER_CALL;
  const isAuthorize = data.type === PASSPORT_PEER_AUTHORIZE;
  const replyType = isCall ? PASSPORT_PEER_RESULT : isAuthorize ? PASSPORT_PEER_AUTHORIZATION : PASSPORT_PEER_CLOSED;
  const reply = (payload: Record<string, unknown>) => {
    try {
      port.postMessage({ type: replyType, ...payload });
      port.close();
    } catch (err: unknown) {
      swallowNonFatal('passport-peer-port', err);
    }
  };
  const request = isCall
    ? { type: FABRIC_RUNTIME_PASSPORT_PEER_CALL, sessionId: String(data.sessionId || ''), method: String(data.method || ''), params: Array.isArray(data.params) ? data.params : [] }
    : isAuthorize
      ? { type: FABRIC_RUNTIME_PASSPORT_PEER_AUTHORIZE, sessionId: String(data.sessionId || ''), url: String(data.url || ''), method: String(data.method || 'GET'), body: typeof data.body === 'string' ? data.body : '' }
      : { type: FABRIC_RUNTIME_PASSPORT_PEER_CLOSE, sessionId: String(data.sessionId || '') };
  chrome.runtime.sendMessage(request).then((res) => {
    if (res && res.ok === true) reply(isCall ? { ok: true, result: res.result } : isAuthorize ? { ok: true, header: res.header } : { ok: true });
    else reply({ ok: false, error: res && typeof res.error === 'string' ? res.error : 'passport_rejected' });
  }).catch((err: unknown) => {
    swallowNonFatal('passport-peer-call-runtime', err);
    reply({ ok: false, error: 'passport_unavailable' });
  });
});

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const selfId = chrome.runtime.id;
  if (sender.id != null && sender.id !== selfId) return undefined;
  if (message.type === 'FABRIC_ACTION') {
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'EXTENSION_ID' && typeof message.id === 'string') {
    window.fabricExtension.id = message.id;
  }
  if (message.type === FABRIC_PASSPORT_PAGE_RESULT) {
    if (sender.tab || message.origin !== window.location.origin || typeof message.requestId !== 'string') return undefined;
    const portType = typeof message.portType === 'string' ? message.portType : PASSPORT_ASSERTION;
    if (message.ok === true && typeof message.assertion === 'string') {
      settlePassportPort(message.requestId, { ok: true, assertion: message.assertion }, portType);
    } else if (message.ok === true && message.session && typeof message.session === 'object') {
      settlePassportPort(message.requestId, { ok: true, session: message.session }, portType);
    } else {
      settlePassportPort(message.requestId, {
        ok: false,
        error: typeof message.error === 'string' ? message.error : 'passport_rejected'
      }, portType);
    }
    return undefined;
  }
  return undefined;
});

// Notify the extension that content script is loaded
chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_LOADED' });

// Export for TypeScript
export {};
