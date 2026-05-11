'use strict';

/**
 * chrome.runtime.onMessage dispatch for the Fabric extension service worker.
 * Split out from fabricBackground.ts to keep registration/setup separate from handler complexity.
 */

import { FABRIC_MESH_HUB_REGISTRATION_KEY, FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import { findMessageTypeDescriptor, type NotificationPriority } from '../fabric/messageTypes';
import { fabricDsGet, fabricDsSet, fabricDsRemove, setDatastoreMasterKeyFromBytes } from './encryptedDatastore';
import {
  getFabricTrafficSnapshot,
  mergeTrustedNodeOrigin,
  reapplyIdentityOutbandRules
} from './identityOutband';
import { attemptPayBolt11ViaActiveFabricNode } from './passportBolt11Pay';
import { swallowNonFatal } from '../utils/nonFatal';

const NOTIFY_ID_MESH = 'fabric-mesh-line';

export interface FabricRuntimeMessageDeps {
  fabricActionDebugUrl: string;
  syncMeshFromStorage: () => Promise<void>;
}

function showFabricNotification (title: string, message: string): void {
  chrome.notifications.create(NOTIFY_ID_MESH, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title,
    message,
    priority: 0
  });
}

/**
 * @returns `true` when sendResponse will be called asynchronously (MV3 contract).
 */
export function handleFabricRuntimeMessage (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
  deps: FabricRuntimeMessageDeps
): boolean | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const selfId = chrome.runtime.id;
  if (sender.id != null && sender.id !== selfId) return undefined;
  const m = message as Record<string, unknown>;
  const { fabricActionDebugUrl, syncMeshFromStorage } = deps;

  if (m.type === 'CONTENT_SCRIPT_LOADED') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      void chrome.tabs.sendMessage(tabId, {
        type: 'EXTENSION_ID',
        id: chrome.runtime.id
      });
    }
    return false;
  }

  if (m.type === 'GET_EXTENSION_ID') {
    sendResponse({ extensionId: chrome.runtime.id });
    return false;
  }

  if (m.type === 'FABRIC_ACTION') {
    fetch(fabricActionDebugUrl)
      .then((r) => r.json())
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ error: error.message }));
    return true;
  }

  if (m.type === 'STORE_SETTINGS') {
    chrome.storage.local.set(m.data as object, () => sendResponse({ success: true }));
    return true;
  }

  if (m.type === 'GET_SETTINGS') {
    chrome.storage.local.get(null, (data) => sendResponse(data));
    return true;
  }

  if (m.type === 'FABRIC_DS_SET' && typeof m.key === 'string') {
    void fabricDsSet(m.key, m.value).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_DS_GET' && typeof m.key === 'string') {
    void fabricDsGet(m.key).then((v) => sendResponse({ value: v })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_DS_REMOVE' && typeof m.key === 'string') {
    void fabricDsRemove(m.key).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_DS_SET_MASTER_KEY' && m.rawKeyB64 && typeof m.rawKeyB64 === 'string') {
    try {
      const bin = atob(m.rawKeyB64);
      if (bin.length < 32) {
        sendResponse({ error: 'Master key must be at least 32 bytes (base64 decodes to 32+ octets).' });
        return true;
      }
      const buf = new ArrayBuffer(32);
      const v = new Uint8Array(buf);
      for (let i = 0; i < 32 && i < bin.length; i++) v[i] = bin.charCodeAt(i);
      void setDatastoreMasterKeyFromBytes(buf).then(() => sendResponse({ ok: true }));
    } catch (e) {
      sendResponse({ error: String(e) });
    }
    return true;
  }

  if (m.type === 'FABRIC_REQUEST_MESH_SYNC') {
    void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
    return true;
  }

  /** Trusted: sent from extension popup (chrome-extension://…/popup.html). */
  if (m.type === 'FABRIC_MESH_REGISTER_FROM_POPUP' && typeof m.hubAddress === 'string') {
    const hubAddress = m.hubAddress.trim();
    void chrome.storage.local.set({
      [FABRIC_MESH_HUB_REGISTRATION_KEY]: {
        hubAddress,
        registeredAt: Date.now(),
        source: 'popup'
      }
    }, () => {
      void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (m.type === 'FABRIC_MESH_UNREGISTER_FROM_POPUP') {
    void chrome.storage.local.remove(FABRIC_MESH_HUB_REGISTRATION_KEY, () => {
      void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  /**
   * Hub page → content script: `postMessage` with source `fabric-hub`.
   * Validates `pageOrigin` matches the Hub URL origin.
   */
  if (m.type === 'FABRIC_HUB_REGISTER_MESH' && typeof m.hubAddress === 'string' && typeof m.pageOrigin === 'string') {
    const hubAddress = m.hubAddress.trim();
    let expectedOrigin: string;
    try {
      const u = new URL(/^https?:\/\//i.test(hubAddress) ? hubAddress : `https://${hubAddress}`);
      expectedOrigin = u.origin;
    } catch (err: unknown) {
      swallowNonFatal('hub-register-mesh-url', err);
      sendResponse({ ok: false, error: 'invalid_hub_address' });
      return false;
    }
    if (m.pageOrigin !== expectedOrigin) {
      sendResponse({ ok: false, error: 'origin_mismatch' });
      return false;
    }
    void chrome.storage.local.set({
      [FABRIC_MESH_HUB_REGISTRATION_KEY]: {
        hubAddress,
        pageOrigin: m.pageOrigin,
        registeredAt: Date.now(),
        source: 'hub_page'
      }
    }, () => {
      void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
    });
    return true;
  }

  if (m.type === 'FABRIC_HUB_UNREGISTER_MESH' && typeof m.pageOrigin === 'string') {
    void chrome.storage.local.get(FABRIC_MESH_HUB_REGISTRATION_KEY, (got) => {
      const cur = got[FABRIC_MESH_HUB_REGISTRATION_KEY] as Record<string, unknown> | undefined;
      if (!cur) {
        sendResponse({ ok: true });
        return;
      }
      const src = cur.source;
      const prevOrigin = typeof cur.pageOrigin === 'string' ? cur.pageOrigin : null;
      if (src === 'hub_page' && prevOrigin === m.pageOrigin) {
        void chrome.storage.local.remove(FABRIC_MESH_HUB_REGISTRATION_KEY, () => {
          void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
        });
        return;
      }
      sendResponse({ ok: false, error: 'not_owner' });
    });
    return true;
  }

  if (m.type === 'MESH_SIGNALING') {
    const event = m.event as string;
    const hub = typeof m.hubAddress === 'string' ? m.hubAddress : '';
    if (event === 'open') {
      showFabricNotification('Fabric mesh', `Signaling connected to ${hub}`);
      void fabricDsSet('mesh_last_open', { hub, ts: Date.now() });
    } else if (event === 'close') {
      showFabricNotification('Fabric mesh', `Signaling disconnected (${hub})`);
    } else if (event === 'error') {
      showFabricNotification('Fabric mesh', `Signaling error: ${hub}`);
    }
    return false;
  }

  if (m.type === 'FABRIC_NODE_MESSAGE' && typeof m.messageType === 'string' && m.payload && typeof m.payload === 'object') {
    const descriptor = findMessageTypeDescriptor(m.messageType);
    if (descriptor && descriptor.notificationPriority !== 'silent') {
      const node = typeof m.nodeAddress === 'string' ? m.nodeAddress : 'a Fabric node';
      const payload = m.payload as Record<string, unknown>;
      const noteField = typeof payload.note === 'string' && payload.note ? payload.note : '';
      const contentField = typeof payload.content === 'string' && payload.content ? payload.content : '';
      const body = noteField
        ? `${node}: ${noteField.slice(0, 120)}`
        : contentField
          ? `${node}: ${contentField.slice(0, 120)}`
          : `${descriptor.label} from ${node}`;
      const chromePriority: Record<NotificationPriority, number> = { high: 2, normal: 1, low: 0, silent: 0 };
      const idSuffix = typeof payload.inviteId === 'string' ? payload.inviteId.slice(0, 16)
        : typeof payload.id === 'string' ? payload.id.slice(0, 16)
        : String(Date.now());
      chrome.notifications.create(`fabric-${m.messageType}-${idSuffix}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: descriptor.label,
        message: body,
        priority: chromePriority[descriptor.notificationPriority] ?? 1
      });
      void fabricDsSet(`notification:${m.messageType}:${idSuffix}`, {
        nodeAddress: m.nodeAddress,
        messageType: m.messageType,
        payload,
        receivedAt: Date.now()
      });
    }
    return false;
  }

  if (m.type === 'FABRIC_PAY_BOLT11_FROM_PASSPORT' && typeof m.bolt11 === 'string') {
    const bolt11 = m.bolt11.trim();
    void attemptPayBolt11ViaActiveFabricNode(bolt11).then((r) => {
      showFabricNotification(r.ok ? 'Passport payment' : 'Passport payment failed', r.message);
      sendResponse(r);
    }).catch((e) => {
      sendResponse({ ok: false, message: String(e instanceof Error ? e.message : e) });
    });
    return true;
  }

  if (m.type === 'FABRIC_TRUSTED_NODE_ORIGIN' && typeof m.origin === 'string') {
    void mergeTrustedNodeOrigin(m.origin)
      .then(() => reapplyIdentityOutbandRules())
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'GET_FABRIC_TRAFFIC_METRICS') {
    sendResponse({ ok: true, ...getFabricTrafficSnapshot() });
    return false;
  }

  return undefined;
}
