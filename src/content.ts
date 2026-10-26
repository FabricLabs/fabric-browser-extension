/// <reference types="chrome"/>

import {
  FABRIC_HUB_POSTMESSAGE_SOURCE,
  FABRIC_HUB_REGISTER_MESH,
  FABRIC_HUB_UNREGISTER_MESH
} from './fabric/hubMeshBridge';
import {
  FABRIC_PASSPORT_PAGE_RESULT,
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_SITE_POSTMESSAGE_SOURCE,
  PASSPORT_ASSERTION,
  PASSPORT_CHALLENGE
} from './constants/siteLogin';
import {
  FABRIC_DEVICE_LINK_REQUEST,
  FABRIC_DEVICE_LINK_RESULT,
  FABRIC_RUNTIME_DEVICE_LINK_REQUEST
} from './constants/deviceLink';
import { evaluateDeviceLinkPageRequest, fetchPendingDeviceLink } from './utils/fabricDeviceLinkFetch';
import {
  requestFabricHubGateOptions
} from './utils/fabricHubAllowlist';
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

/**
 * Ports pages handed us with a `PASSPORT_CHALLENGE`, by request id. The answer
 * goes only to that port, so nothing else on the page can read or forge it.
 * One open sign-in per frame: a new challenge cancels the previous one.
 */
const passportPorts = new Map<string, MessagePort>();
const MAX_PASSPORT_CHALLENGE_CHARS = 48 * 1024;

function settlePassportPort (requestId: string, payload: Record<string, unknown>): void {
  const port = passportPorts.get(requestId);
  if (!port) return;
  passportPorts.delete(requestId);
  try {
    port.postMessage({ type: PASSPORT_ASSERTION, ...payload });
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

  void requestFabricHubGateOptions().then((gate) => {
    const pageGate = evaluateDeviceLinkPageRequest({
      sessionId,
      hubRaw,
      declaredOrigin,
      pageOrigin: event.origin,
      ...gate
    });
    if (!pageGate.ok) {
      window.postMessage({
        source: 'fabric-passport',
        type: FABRIC_DEVICE_LINK_RESULT,
        ok: false,
        error: pageGate.error
      }, event.origin);
      return;
    }
    const hubBase = pageGate.hubBase;

    return fetchPendingDeviceLink(hubBase, sessionId).then((pending) => {
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
  if (message.type === FABRIC_PASSPORT_PAGE_RESULT) {
    if (sender.tab || message.origin !== window.location.origin || typeof message.requestId !== 'string') return undefined;
    if (message.ok === true && typeof message.assertion === 'string') {
      settlePassportPort(message.requestId, { ok: true, assertion: message.assertion });
    } else {
      settlePassportPort(message.requestId, {
        ok: false,
        error: typeof message.error === 'string' ? message.error : 'passport_rejected'
      });
    }
    return undefined;
  }
  if (message.type === 'FABRIC_DEVICE_LINK_PAGE_RESULT') {
    if (sender.tab || message.origin !== window.location.origin) return undefined;
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
