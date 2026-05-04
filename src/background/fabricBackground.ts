'use strict';

import { FABRIC_MESH_HUB_REGISTRATION_KEY, FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';

declare const __FABRIC_ACTION_DEBUG_URL__: string;
const FABRIC_ACTION_DEBUG_URL =
  typeof __FABRIC_ACTION_DEBUG_URL__ === 'string' && __FABRIC_ACTION_DEBUG_URL__.length
    ? __FABRIC_ACTION_DEBUG_URL__
    : 'http://localhost:3003/api/endpoint';

type ExtendableEvent = Event & { waitUntil (p: Promise<unknown>): void };

interface ExtensionServiceWorkerGlobal {
  skipWaiting (): Promise<void>;
  addEventListener (type: string, listener: (ev: Event) => void): void;
  clients: { claim (): Promise<unknown> };
}
import { fabricDsGet, fabricDsSet, fabricDsRemove, setDatastoreMasterKeyFromBytes } from './encryptedDatastore';
import { findMessageTypeDescriptor, type NotificationPriority } from '../fabric/messageTypes';
import { initIdentityOutband } from './identityOutband';
import { attemptPayBolt11ViaActiveFabricNode } from './passportBolt11Pay';

const OFFSCREEN_PATH = 'background/offscreen.html';
const ALARM_MESH_KEEPALIVE = 'fabric_mesh_keepalive';
const NOTIFY_ID_MESH = 'fabric-mesh-line';

let meshPort: chrome.runtime.Port | null = null;
const pendingMeshMessages: object[] = [];

function flushMeshQueue (): void {
  while (meshPort && pendingMeshMessages.length > 0) {
    const next = pendingMeshMessages.shift();
    if (next) meshPort.postMessage(next);
  }
}

function postToMesh (msg: object): void {
  if (meshPort) meshPort.postMessage(msg);
  else pendingMeshMessages.push(msg);
}

function extractActiveFabricHub (state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const settings = s.settings as Record<string, unknown> | undefined;
  const nodes = settings?.fabricNodes as Array<{ isActive?: boolean; hubAddress?: string }> | undefined;
  if (!Array.isArray(nodes)) return null;
  const active = nodes.find(n => n && n.isActive && typeof n.hubAddress === 'string');
  return active?.hubAddress ?? null;
}

function registrationHubAddress (reg: unknown): string | null {
  if (!reg || typeof reg !== 'object') return null;
  const h = (reg as Record<string, unknown>).hubAddress;
  return typeof h === 'string' && h.trim() ? h.trim() : null;
}

/**
 * Hub-registered mesh (via postMessage or popup) overrides the active Fabric node for signaling only.
 */
async function extractMeshHubAddress (): Promise<string | null> {
  try {
    const regBag = await chrome.storage.local.get(FABRIC_MESH_HUB_REGISTRATION_KEY);
    const fromReg = registrationHubAddress(regBag[FABRIC_MESH_HUB_REGISTRATION_KEY]);
    if (fromReg) return fromReg;
  } catch (_) {}
  try {
    const data = await chrome.storage.local.get(FABRIC_STATE_STORAGE_KEY);
    return extractActiveFabricHub(data[FABRIC_STATE_STORAGE_KEY]);
  } catch (_) {
    return null;
  }
}

async function ensureOffscreenDocument (): Promise<void> {
  try {
    if (chrome.offscreen.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
  } catch (_) {}
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: 'Maintain Fabric Protocol WebRTC signaling and peer mesh while the popup is closed.'
    });
  } catch (_) {
    /* Document may already exist (race) */
  }
}

async function syncMeshFromStorage (): Promise<void> {
  try {
    const hub = await extractMeshHubAddress();
    await ensureOffscreenDocument();
    if (hub) postToMesh({ type: 'START_MESH', hubAddress: hub });
    else postToMesh({ type: 'STOP_MESH' });
  } catch (e) {
    console.warn('[FABRIC:BG] mesh sync failed', e);
  }
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

function registerMeshPort (port: chrome.runtime.Port): void {
  if (port.name !== 'fabric-mesh-runtime') return;
  meshPort = port;
  port.onDisconnect.addListener(() => {
    meshPort = null;
  });
  port.onMessage.addListener((_msg: unknown) => {});
  flushMeshQueue();
}

export function registerFabricBackground (): void {
  const sw = globalThis as unknown as ExtensionServiceWorkerGlobal;

  sw.addEventListener('install', () => {
    void sw.skipWaiting();
  });

  sw.addEventListener('activate', (event: Event) => {
    (event as ExtendableEvent).waitUntil(sw.clients.claim());
  });

  chrome.runtime.onConnect.addListener((port) => {
    registerMeshPort(port);
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message !== 'object') return undefined;
    const m = message as Record<string, unknown>;

    if (m.type === 'CONTENT_SCRIPT_LOADED') {
      const tabId = (_sender as chrome.runtime.MessageSender).tab?.id;
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
      fetch(FABRIC_ACTION_DEBUG_URL)
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
      } catch {
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

    return undefined;
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[FABRIC_STATE_STORAGE_KEY] && !changes[FABRIC_MESH_HUB_REGISTRATION_KEY]) return;
    void syncMeshFromStorage();
  });

  chrome.runtime.onInstalled.addListener(() => {
    void syncMeshFromStorage();
    try {
      chrome.alarms.create(ALARM_MESH_KEEPALIVE, { periodInMinutes: 5 });
    } catch (e) {
      console.warn('[FABRIC:BG] alarms not available', e);
    }
  });

  try {
    chrome.alarms.get(ALARM_MESH_KEEPALIVE, (existing) => {
      if (!existing) {
        chrome.alarms.create(ALARM_MESH_KEEPALIVE, { periodInMinutes: 5 });
      }
    });
  } catch (e) {
    console.warn('[FABRIC:BG] alarms get/create', e);
  }

  chrome.runtime.onStartup.addListener(() => {
    void syncMeshFromStorage();
  });

  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== ALARM_MESH_KEEPALIVE) return;
    postToMesh({ type: 'PING' });
    void syncMeshFromStorage();
  });

  void syncMeshFromStorage();
  initIdentityOutband();
}
