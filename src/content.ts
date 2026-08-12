/// <reference types="chrome"/>

import {
  FABRIC_HUB_POSTMESSAGE_SOURCE,
  FABRIC_HUB_REGISTER_MESH,
  FABRIC_HUB_UNREGISTER_MESH
} from './fabric/hubMeshBridge';
import {
  FABRIC_RUNTIME_SITE_LOGIN_REQUEST,
  FABRIC_SITE_LOGIN_REQUEST,
  FABRIC_SITE_LOGIN_RESULT,
  FABRIC_SITE_POSTMESSAGE_SOURCE
} from './constants/siteLogin';
import {
  FABRIC_DEVICE_LINK_REQUEST,
  FABRIC_DEVICE_LINK_RESULT,
  FABRIC_RUNTIME_DEVICE_LINK_REQUEST
} from './constants/deviceLink';
import { fetchPendingDeviceLink } from './utils/fabricDeviceLinkFetch';
import { installFabric402FetchInterceptor } from './content/fabric402FetchPatch';
import { swallowNonFatal } from './utils/nonFatal';
import { assertAllowedFabricHub } from './utils/fabricHubAllowlist';

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

/** DOM marker is set in `contentMarker.ts` (loads before this bundle). */
installFabric402FetchInterceptor();

/** Hub (or dev) page asks the extension to keep WebRTC signaling alive after the tab closes. */
window.addEventListener('message', (event: MessageEvent) => {
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

/** Site pages request client-signed Fabric login (Passport ↔ desktop interchangeable). */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE || data.type !== FABRIC_SITE_LOGIN_REQUEST) {
    return;
  }
  if (event.source !== window || event.origin !== window.location.origin) return;

  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  const message = typeof data.message === 'string' ? data.message : '';
  const hubRaw = typeof data.hub === 'string' ? data.hub.trim() : '';
  const declaredOrigin = typeof data.origin === 'string' ? data.origin.trim() : event.origin;
  if (!sessionId || !message || !hubRaw) return;

  let hubBase: string;
  let hubOrigin: string;
  try {
    const u = new URL(hubRaw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    hubBase = `${u.protocol}//${u.host}`;
    hubOrigin = u.origin;
  } catch (err: unknown) {
    swallowNonFatal('site-login-hub-url', err);
    return;
  }
  const hubGate = assertAllowedFabricHub(hubBase);
  if (!hubGate.ok) {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_SITE_LOGIN_RESULT,
      ok: false,
      error: 'hub_not_allowed'
    }, event.origin);
    return;
  }
  hubBase = hubGate.hubBase;
  if (declaredOrigin !== event.origin || hubOrigin !== event.origin) {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_SITE_LOGIN_RESULT,
      ok: false,
      error: 'origin_mismatch'
    }, event.origin);
    return;
  }

  void chrome.runtime.sendMessage({
    type: FABRIC_RUNTIME_SITE_LOGIN_REQUEST,
    sessionId,
    hubBase,
    origin: declaredOrigin,
    message,
    pageOrigin: event.origin
  }).then((res) => {
    if (res && res.ok === false) {
      window.postMessage({
        source: 'fabric-passport',
        type: FABRIC_SITE_LOGIN_RESULT,
        ok: false,
        error: typeof res.error === 'string' ? res.error : 'passport_rejected'
      }, event.origin);
    }
  }).catch((err: unknown) => swallowNonFatal('site-login-runtime', err));
});

/** Hub (or site) asks Passport to accept a mutual device-link offer as responder. */
window.addEventListener('message', (event: MessageEvent) => {
  const data = event.data;
  if (!data || data.source !== FABRIC_SITE_POSTMESSAGE_SOURCE || data.type !== FABRIC_DEVICE_LINK_REQUEST) {
    return;
  }
  if (event.source !== window || event.origin !== window.location.origin) return;

  const sessionId = typeof data.sessionId === 'string' ? data.sessionId.trim() : '';
  const hubRaw = typeof data.hub === 'string' ? data.hub.trim() : '';
  const declaredOrigin = typeof data.origin === 'string' ? data.origin.trim() : event.origin;
  if (!sessionId || !hubRaw) return;

  let hubBase: string;
  let hubOrigin: string;
  try {
    const u = new URL(hubRaw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
    hubBase = `${u.protocol}//${u.host}`;
    hubOrigin = u.origin;
  } catch (err: unknown) {
    swallowNonFatal('device-link-hub-url', err);
    return;
  }
  const hubGate = assertAllowedFabricHub(hubBase);
  if (!hubGate.ok) {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_DEVICE_LINK_RESULT,
      ok: false,
      error: 'hub_not_allowed'
    }, event.origin);
    return;
  }
  hubBase = hubGate.hubBase;
  if (declaredOrigin !== event.origin || hubOrigin !== event.origin) {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_DEVICE_LINK_RESULT,
      ok: false,
      error: 'origin_mismatch'
    }, event.origin);
    return;
  }

  void fetchPendingDeviceLink(hubBase, sessionId).then((pending) => {
    if (!pending.ok) {
      window.postMessage({
        source: 'fabric-passport',
        type: FABRIC_DEVICE_LINK_RESULT,
        ok: false,
        error: pending.error
      }, event.origin);
      return;
    }
    if (pending.status !== 'pending') {
      window.postMessage({
        source: 'fabric-passport',
        type: FABRIC_DEVICE_LINK_RESULT,
        ok: false,
        error: `device_link_${pending.status || 'unavailable'}`
      }, event.origin);
      return;
    }
    return chrome.runtime.sendMessage({
      type: FABRIC_RUNTIME_DEVICE_LINK_REQUEST,
      sessionId: pending.sessionId,
      hubBase: pending.hubBase,
      origin: pending.origin,
      nonce: pending.nonce,
      label: pending.label,
      initiator: pending.initiator,
      pageOrigin: event.origin
    }).then((res) => {
      if (res && res.ok === false) {
        window.postMessage({
          source: 'fabric-passport',
          type: FABRIC_DEVICE_LINK_RESULT,
          ok: false,
          error: typeof res.error === 'string' ? res.error : 'passport_rejected'
        }, event.origin);
      }
    });
  }).catch((err: unknown) => swallowNonFatal('device-link-runtime', err));
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
  if (message.type === 'FABRIC_SITE_LOGIN_PAGE_RESULT') {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_SITE_LOGIN_RESULT,
      ok: !!message.ok,
      error: message.error,
      sessionId: message.sessionId,
      identity: message.identity
    }, window.location.origin);
  }
  if (message.type === 'FABRIC_DEVICE_LINK_PAGE_RESULT') {
    window.postMessage({
      source: 'fabric-passport',
      type: FABRIC_DEVICE_LINK_RESULT,
      ok: !!message.ok,
      error: message.error,
      sessionId: message.sessionId,
      peerFabricId: message.peerFabricId
    }, window.location.origin);
  }
  return undefined;
});

// Notify the extension that content script is loaded
chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_LOADED' });

console.log('Fabric Extension content script loaded successfully');

// Export for TypeScript
export {};
