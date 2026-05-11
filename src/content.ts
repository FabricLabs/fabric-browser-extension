/// <reference types="chrome"/>

import {
  FABRIC_HUB_POSTMESSAGE_SOURCE,
  FABRIC_HUB_REGISTER_MESH,
  FABRIC_HUB_UNREGISTER_MESH
} from './fabric/hubMeshBridge';
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
  }
});

// Listen for messages from the extension
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const selfId = chrome.runtime.id;
  if (sender.id != null && sender.id !== selfId) return undefined;
  if (message.type === 'FABRIC_ACTION') {
    sendResponse({ success: true });
    return true;
  }
  if (message.type === 'EXTENSION_ID' && message.id) {
    window.fabricExtension.id = message.id;
  }
  return undefined;
});

// Notify the extension that content script is loaded
chrome.runtime.sendMessage({ type: 'CONTENT_SCRIPT_LOADED' });

console.log('Fabric Extension content script loaded successfully');

// Export for TypeScript
export {};
