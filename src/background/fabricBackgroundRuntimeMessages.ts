'use strict';

/**
 * chrome.runtime.onMessage dispatch for the Fabric extension service worker.
 * Split out from fabricBackground.ts to keep registration/setup separate from handler complexity.
 */

import { FABRIC_MESH_HUB_REGISTRATION_KEY } from '../constants/fabricExtension';
import {
  FABRIC_PENDING_SITE_LOGIN_KEY,
  FABRIC_RUNTIME_SITE_LOGIN_CLEAR,
  FABRIC_RUNTIME_SITE_LOGIN_COMPLETE,
  FABRIC_RUNTIME_SITE_LOGIN_GET,
  FABRIC_RUNTIME_SITE_LOGIN_REQUEST
} from '../constants/siteLogin';
import {
  FABRIC_PENDING_DEVICE_LINK_KEY,
  FABRIC_RUNTIME_DEVICE_LINK_CLEAR,
  FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
  FABRIC_RUNTIME_DEVICE_LINK_GET,
  FABRIC_RUNTIME_DEVICE_LINK_REQUEST
} from '../constants/deviceLink';
import { findMessageTypeDescriptor, summarizeNotifiablePayload, type NotificationPriority } from '../fabric/messageTypes';
import { fabricDsGet, fabricDsSet, fabricDsRemove, fabricDsListPrefix, setDatastoreMasterKeyFromBytes } from './encryptedDatastore';
import {
  getFabricTrafficSnapshot,
  mergeTrustedNodeOrigin,
  reapplyIdentityOutbandRules
} from './identityOutband';
import { attemptPayBolt11ViaActiveFabricNode } from './passportBolt11Pay';
import { swallowNonFatal } from '../utils/nonFatal';
import { validateQueuedDeviceLinkOffer } from '../utils/fabricDeviceLinkFetch';

type PendingSiteLoginRow = {
  sessionId: string;
  hubBase: string;
  origin: string;
  message: string;
  pageOrigin: string;
  createdAt: number;
  tabId?: number;
};

type PendingDeviceLinkRow = {
  sessionId: string;
  hubBase: string;
  origin: string;
  nonce: string;
  label: string;
  initiator: { id: string; xpub: string; pubkeyHex?: string };
  pageOrigin: string;
  createdAt: number;
  tabId?: number;
};

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
  sendResponse: (_response?: unknown) => void,
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
      .catch((error: unknown) =>
        sendResponse({
          error: error instanceof Error ? error.message : String(error)
        })
      );
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

  if (m.type === 'FABRIC_LIST_ARC_NOTIFICATIONS') {
    const limit = typeof m.limit === 'number' ? m.limit : 30;
    void fabricDsListPrefix('notification:', limit)
      .then((rows) => sendResponse({
        ok: true,
        items: rows.map((r) => {
          const v = r.value as {
            messageType?: string;
            payload?: Record<string, unknown>;
            nodeAddress?: string;
            receivedAt?: number;
          };
          const messageType = v.messageType || 'unknown';
          const descriptor = findMessageTypeDescriptor(messageType);
          return {
            key: r.key,
            messageType,
            label: descriptor ? descriptor.label : messageType,
            arc: !!(descriptor && descriptor.arc),
            priority: descriptor ? descriptor.notificationPriority : 'normal',
            summary: summarizeNotifiablePayload(messageType, v.payload || {}, v.nodeAddress),
            nodeAddress: v.nodeAddress || null,
            payload: v.payload || null,
            receivedAt: v.receivedAt || null
          };
        })
      }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_DS_SET_MASTER_KEY' && m.rawKeyB64 && typeof m.rawKeyB64 === 'string') {
    try {
      const bin = atob(m.rawKeyB64);
      if (bin.length !== 32) {
        sendResponse({ error: 'Master key must be 32 bytes (base64 decodes to exactly 32 octets).' });
        return true;
      }
      const buf = new ArrayBuffer(32);
      const v = new Uint8Array(buf);
      for (let i = 0; i < 32; i++) v[i] = bin.charCodeAt(i);
      void setDatastoreMasterKeyFromBytes(buf).then(() => sendResponse({ ok: true }));
    } catch (e: unknown) {
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
      const body = summarizeNotifiablePayload(m.messageType, payload, node);
      const chromePriority: Record<NotificationPriority, number> = { high: 2, normal: 1, low: 0, silent: 0 };
      const idSuffix = typeof payload.inviteId === 'string' ? payload.inviteId.slice(0, 16)
        : typeof payload.proposalId === 'string' ? payload.proposalId.slice(0, 16)
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
        receivedAt: Date.now(),
        arc: descriptor.arc === true
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

  /** Content script: queue a client-signed site login for the popup to approve. */
  if (m.type === FABRIC_RUNTIME_SITE_LOGIN_REQUEST) {
    const sessionId = typeof m.sessionId === 'string' ? m.sessionId.trim() : '';
    const hubBase = typeof m.hubBase === 'string' ? m.hubBase.trim() : '';
    const origin = typeof m.origin === 'string' ? m.origin.trim() : '';
    const loginMessage = typeof m.message === 'string' ? m.message : '';
    const pageOrigin = typeof m.pageOrigin === 'string' ? m.pageOrigin.trim() : '';
    if (!sessionId || !hubBase || !loginMessage || !pageOrigin || pageOrigin !== origin) {
      sendResponse({ ok: false, error: 'invalid_site_login' });
      return false;
    }
    const row: PendingSiteLoginRow = {
      sessionId,
      hubBase,
      origin,
      message: loginMessage,
      pageOrigin,
      createdAt: Date.now(),
      tabId: sender.tab?.id
    };
    const persist = chrome.storage.session
      ? chrome.storage.session.set({ [FABRIC_PENDING_SITE_LOGIN_KEY]: row })
      : chrome.storage.local.set({ [FABRIC_PENDING_SITE_LOGIN_KEY]: row });
    void Promise.resolve(persist).then(() => {
      showFabricNotification('Fabric Passport', `Sign-in request from ${origin}`);
      // Best-effort: focus the extension action so the user opens the popup.
      try {
        if (chrome.action?.openPopup) {
          void chrome.action.openPopup().catch((err: unknown) => swallowNonFatal('site-login-open-popup', err));
        }
      } catch (err: unknown) {
        swallowNonFatal('site-login-open-popup', err);
      }
      sendResponse({ ok: true });
    }).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (m.type === FABRIC_RUNTIME_SITE_LOGIN_GET) {
    const store = chrome.storage.session || chrome.storage.local;
    void store.get(FABRIC_PENDING_SITE_LOGIN_KEY, (got) => {
      const pending = got[FABRIC_PENDING_SITE_LOGIN_KEY] as PendingSiteLoginRow | undefined;
      sendResponse({
        pending: pending || null,
        tabId: pending && typeof pending.tabId === 'number' ? pending.tabId : undefined
      });
    });
    return true;
  }

  if (m.type === FABRIC_RUNTIME_SITE_LOGIN_CLEAR || m.type === FABRIC_RUNTIME_SITE_LOGIN_COMPLETE) {
    const store = chrome.storage.session || chrome.storage.local;
    void store.remove(FABRIC_PENDING_SITE_LOGIN_KEY, () => sendResponse({ ok: true }));
    return true;
  }

  /** Content script: queue a mutual device-link offer for the popup to approve (responder). */
  if (m.type === FABRIC_RUNTIME_DEVICE_LINK_REQUEST) {
    const queued = validateQueuedDeviceLinkOffer(m);
    if (!queued.ok) {
      sendResponse({ ok: false, error: queued.error });
      return false;
    }
    const sessionId = typeof m.sessionId === 'string' ? m.sessionId.trim() : '';
    const hubBase = typeof m.hubBase === 'string' ? m.hubBase.trim() : '';
    const origin = typeof m.origin === 'string' ? m.origin.trim() : '';
    const nonce = typeof m.nonce === 'string' ? m.nonce.trim() : '';
    const label = typeof m.label === 'string' ? m.label.trim() : 'device';
    const pageOrigin = typeof m.pageOrigin === 'string' ? m.pageOrigin.trim() : '';
    const initiator = m.initiator && typeof m.initiator === 'object'
      ? (m.initiator as { id?: string; xpub?: string; pubkeyHex?: string })
      : null;
    if (!initiator || typeof initiator.id !== 'string' || typeof initiator.xpub !== 'string') {
      sendResponse({ ok: false, error: 'invalid_device_link' });
      return false;
    }
    const row: PendingDeviceLinkRow = {
      sessionId,
      hubBase,
      origin,
      nonce,
      label,
      initiator: {
        id: initiator.id,
        xpub: initiator.xpub,
        pubkeyHex: typeof initiator.pubkeyHex === 'string' ? initiator.pubkeyHex : undefined
      },
      pageOrigin,
      createdAt: Date.now(),
      tabId: sender.tab?.id
    };
    const persist = chrome.storage.session
      ? chrome.storage.session.set({ [FABRIC_PENDING_DEVICE_LINK_KEY]: row })
      : chrome.storage.local.set({ [FABRIC_PENDING_DEVICE_LINK_KEY]: row });
    void Promise.resolve(persist).then(() => {
      showFabricNotification('Fabric Passport', `Device-link offer from ${origin}`);
      try {
        if (chrome.action?.openPopup) {
          void chrome.action.openPopup().catch((err: unknown) => swallowNonFatal('device-link-open-popup', err));
        }
      } catch (err: unknown) {
        swallowNonFatal('device-link-open-popup', err);
      }
      sendResponse({ ok: true });
    }).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e) });
    });
    return true;
  }

  if (m.type === FABRIC_RUNTIME_DEVICE_LINK_GET) {
    const store = chrome.storage.session || chrome.storage.local;
    void store.get(FABRIC_PENDING_DEVICE_LINK_KEY, (got) => {
      const pending = got[FABRIC_PENDING_DEVICE_LINK_KEY] as PendingDeviceLinkRow | undefined;
      sendResponse({
        pending: pending || null,
        tabId: pending && typeof pending.tabId === 'number' ? pending.tabId : undefined
      });
    });
    return true;
  }

  if (m.type === FABRIC_RUNTIME_DEVICE_LINK_CLEAR || m.type === FABRIC_RUNTIME_DEVICE_LINK_COMPLETE) {
    const store = chrome.storage.session || chrome.storage.local;
    void store.remove(FABRIC_PENDING_DEVICE_LINK_KEY, () => sendResponse({ ok: true }));
    return true;
  }

  return undefined;
}
