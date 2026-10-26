'use strict';

/**
 * chrome.runtime.onMessage dispatch for the Fabric extension service worker.
 * Split out from fabricBackground.ts to keep registration/setup separate from handler complexity.
 */

import { FABRIC_MESH_HUB_REGISTRATION_KEY } from '../constants/fabricExtension';
import {
  FABRIC_RUNTIME_DESKTOP_SIGN,
  FABRIC_RUNTIME_PASSPORT_ANSWER,
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_RUNTIME_PASSPORT_LIST
} from '../constants/siteLogin';
import {
  answerPassport,
  checkSenderFrame,
  completeWithDesktop,
  queuePassportChallenge,
  readPendingPassport
} from './fabricSiteLoginRuntime';
import {
  FABRIC_PENDING_DEVICE_LINK_KEY,
  FABRIC_RUNTIME_DEVICE_LINK_CLEAR,
  FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
  FABRIC_RUNTIME_DEVICE_LINK_GET,
  FABRIC_RUNTIME_DEVICE_LINK_REQUEST
} from '../constants/deviceLink';
import { findMessageTypeDescriptor, summarizeNotifiablePayload, INVENTORY_RESPONSE, type NotificationPriority } from '../fabric/messageTypes';
import { getPageIndex } from '../services/pageIndex';
import { getMarketAgent, configureMarketAgent, tickMarketAgent, persistMarketAgent } from '../services/marketRuntime';
import { fabricDsGet, fabricDsSet, fabricDsRemove, fabricDsListPrefix, setDatastoreMasterKeyFromBytes } from './encryptedDatastore';
import {
  getFabricTrafficSnapshot,
  mergeTrustedNodeOrigin,
  reapplyIdentityOutbandRules
} from './identityOutband';
import { attemptPayBolt11ViaActiveFabricNode } from './passportBolt11Pay';
import { swallowNonFatal } from '../utils/nonFatal';
import { validateQueuedDeviceLinkOffer } from '../utils/fabricDeviceLinkFetch';
import {
  assertAllowedFabricHub,
  loadFabricHubGateOptions,
  FABRIC_RUNTIME_HUB_GATE_OPTIONS
} from '../utils/fabricHubAllowlist';
import { originOfSender } from '../utils/fabricSiteMessage';

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

/**
 * The only messages a content script (any web page's frame) may send. Settings,
 * the encrypted datastore, pending prompts, and everything else answer
 * extension pages only.
 */
export const CONTENT_SCRIPT_MESSAGES: ReadonlySet<string> = new Set([
  'CONTENT_SCRIPT_LOADED',
  'FABRIC_HUB_REGISTER_MESH',
  'FABRIC_HUB_UNREGISTER_MESH',
  'FABRIC_PAY_BOLT11_FROM_PASSPORT',
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_RUNTIME_HUB_GATE_OPTIONS,
  FABRIC_RUNTIME_DEVICE_LINK_REQUEST
]);

/** True for this extension's own pages (popup, options, offscreen), even when opened in a tab. */
export function isExtensionPage (sender: chrome.runtime.MessageSender): boolean {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  const own = chrome.runtime.getURL('');
  const from = typeof sender.url === 'string' ? sender.url : '';
  if (from) return from.startsWith(own);
  return !sender.tab;
}

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
  const fromExtension = isExtensionPage(sender);
  if (!fromExtension && !(typeof m.type === 'string' && CONTENT_SCRIPT_MESSAGES.has(m.type))) return undefined;

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

  if (m.type === 'FABRIC_PAGE_INDEX_LIST') {
    // Hash-only page index rows (root, leaves, provider counts) for the popup.
    const limit = typeof m.limit === 'number' ? m.limit : 50;
    void (async () => {
      const index = getPageIndex();
      const pages = (await index.listPages()).slice(0, limit);
      const items = [];
      for (const page of pages) {
        const locations = await index.locatePage({ url: page.url, merkleRootHex: page.merkleRootHex });
        items.push({
          url: page.url,
          title: page.title || null,
          merkleRootHex: page.merkleRootHex,
          blobTotal: page.blobTotal,
          size: page.size,
          providers: locations.reduce((n, l) => n + (l.providers ? l.providers.length : 0), 0),
          blobs: page.blobs.map((b) => ({ index: b.index, blobHashHex: b.blobHashHex, size: b.size }))
        });
      }
      sendResponse({ ok: true, items });
    })().catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_MARKET_STATUS') {
    void getMarketAgent()
      .then((agent) => sendResponse({ ok: true, status: agent.status() }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_MARKET_CONFIGURE') {
    const patch = (m.settings && typeof m.settings === 'object') ? m.settings as Record<string, number> : {};
    void configureMarketAgent(patch)
      .then((agent) => sendResponse({ ok: true, status: agent.status() }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_MARKET_WANT') {
    void getMarketAgent()
      .then(async (agent) => {
        const want = agent.want(String(m.merkleRootHex || ''), {
          documentId: typeof m.documentId === 'string' ? m.documentId : undefined,
          blobTotal: typeof m.blobTotal === 'number' ? m.blobTotal : undefined,
          maxSats: typeof m.maxSats === 'number' ? m.maxSats : undefined
        });
        const tick = agent.tick();
        await persistMarketAgent();
        sendResponse({ ok: true, want, tick, status: agent.status() });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_MARKET_FORGET') {
    void getMarketAgent()
      .then(async (agent) => {
        const removed = agent.forget(String(m.merkleRootHex || ''));
        await persistMarketAgent();
        sendResponse({ ok: true, removed, status: agent.status() });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_MARKET_TICK') {
    void tickMarketAgent()
      .then(async (tick) => sendResponse({ ok: true, tick, status: (await getMarketAgent()).status() }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
    const senderOrigin = sender.tab ? originOfSender(sender) : m.pageOrigin;
    if (m.pageOrigin !== expectedOrigin || senderOrigin !== expectedOrigin) {
      sendResponse({ ok: false, error: 'origin_mismatch' });
      return false;
    }
    void loadFabricHubGateOptions().then((gateOptions) => {
      const gate = assertAllowedFabricHub(expectedOrigin, gateOptions);
      if (!gate.ok) {
        sendResponse({ ok: false, error: 'hub_not_allowed' });
        return;
      }
      void chrome.storage.local.set({
        [FABRIC_MESH_HUB_REGISTRATION_KEY]: {
          hubAddress,
          pageOrigin: expectedOrigin,
          registeredAt: Date.now(),
          source: 'hub_page'
        }
      }, () => {
        void syncMeshFromStorage().then(() => sendResponse({ ok: true }));
      });
    }).catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
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
    if (m.messageType === INVENTORY_RESPONSE) {
      // Peer chunk listings feed the local page/chunk index; never a notification.
      const payload = m.payload as Record<string, unknown>;
      void getPageIndex().ingestInventoryResponse({
        origin: typeof m.nodeAddress === 'string' ? m.nodeAddress : undefined,
        payload,
        signerPubkeyHex: typeof payload.signerPubkeyHex === 'string' ? payload.signerPubkeyHex : null
      }).catch((err: unknown) => swallowNonFatal('page-index-inventory', err));
      return false;
    }
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

  /** Content script: queue a page's PASSPORT_CHALLENGE for the popup. */
  if (m.type === FABRIC_RUNTIME_PASSPORT_CHALLENGE && !fromExtension && sender.tab) {
    void queuePassportChallenge(m, sender).then((queued) => {
      if (!queued.ok) {
        sendResponse(queued);
        return;
      }
      showFabricNotification('Fabric Passport', `Sign-in request from ${queued.row.origin}`);
      try {
        if (chrome.action?.openPopup) {
          void chrome.action.openPopup().catch((err: unknown) => swallowNonFatal('passport-open-popup', err));
        }
      } catch (err: unknown) {
        swallowNonFatal('passport-open-popup', err);
      }
      sendResponse({ ok: true });
    }).catch((e: unknown) => {
      sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e) });
    });
    return true;
  }

  /** Popup: the sign-ins waiting for an answer. */
  if (m.type === FABRIC_RUNTIME_PASSPORT_LIST && fromExtension) {
    void readPendingPassport()
      .then((pending) => sendResponse({ ok: true, pending }))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e), pending: [] }));
    return true;
  }

  /** Popup: an assertion it signed, or a refusal; verified and delivered from here. */
  if (m.type === FABRIC_RUNTIME_PASSPORT_ANSWER && fromExtension) {
    void answerPassport(m)
      .then((out) => sendResponse(out))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    return true;
  }

  /** Popup: a pinned desktop app answers the pending sign-in; delivered from here so closing the popup is fine. */
  if (m.type === FABRIC_RUNTIME_DESKTOP_SIGN && fromExtension) {
    void completeWithDesktop(m)
      .then((out) => sendResponse(out))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    return true;
  }

  /** Content script: which loopback Hub (the active node) the page gates may allow. */
  if (m.type === FABRIC_RUNTIME_HUB_GATE_OPTIONS) {
    void loadFabricHubGateOptions().then((gate) => sendResponse({ activeHub: gate.activeHub || null }));
    return true;
  }

  /** Content script: queue a mutual device-link offer for the popup to approve (responder). */
  if (m.type === FABRIC_RUNTIME_DEVICE_LINK_REQUEST && !fromExtension && sender.tab) {
    const frame = checkSenderFrame(sender);
    if (!frame.ok) {
      sendResponse({ ok: false, error: frame.error });
      return false;
    }
    if (originOfSender(sender) !== (typeof m.pageOrigin === 'string' ? m.pageOrigin.trim() : '')) {
      sendResponse({ ok: false, error: 'origin_mismatch' });
      return false;
    }
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
