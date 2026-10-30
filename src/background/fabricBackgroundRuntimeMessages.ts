'use strict';

/**
 * chrome.runtime.onMessage dispatch for the Fabric extension service worker.
 * Split out from fabricBackground.ts to keep registration/setup separate from handler complexity.
 */

import { FABRIC_MESH_HUB_REGISTRATION_KEY } from '../constants/fabricExtension';
import { privateGet, privateRemove, privateSet } from '../utils/privateStore';
import {
  FABRIC_RUNTIME_DELEGATE_SIGN_IN,
  FABRIC_RUNTIME_PASSPORT_ANSWER,
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_RUNTIME_PASSPORT_LIST
} from '../constants/siteLogin';
import {
  answerPassport,
  completeWithDelegate,
  mayNotifySignIn,
  queuePassportChallenge,
  readPendingPassport
} from './fabricSiteLoginRuntime';
import {
  DELEGATION_ANSWER,
  DELEGATION_ASK,
  DELEGATION_DISCOVER,
  DELEGATION_FORGET,
  DELEGATION_PAIR_CANCEL,
  DELEGATION_PAIR_CONFIRM,
  DELEGATION_PAIR_HUB,
  DELEGATION_PAIR_INVITATION,
  DELEGATION_PAIR_LOCAL,
  DELEGATION_PAIRING_GET,
  DELEGATION_POLL,
  DELEGATION_REVOKE,
  DELEGATION_STATE,
  SIGN_IN_NOTIFICATION_PREFIX
} from '../constants/delegation';
import {
  answerRequest,
  ask,
  cancelPairing,
  confirmPairing,
  delegationState,
  discover,
  forgetSigner,
  pairHub,
  pairInvitation,
  pairLocal,
  pairingView,
  pollMailboxes,
  refreshBadge,
  revokeGrant
} from './delegation';
import { findMessageTypeDescriptor, summarizeNotifiablePayload, INVENTORY_RESPONSE, type NotificationPriority } from '../fabric/messageTypes';
import { getPageIndex } from '../services/pageIndex';
import { getMarketAgent, configureMarketAgent, tickMarketAgent, persistMarketAgent } from '../services/marketRuntime';
import { fabricDsGet, fabricDsSet, fabricDsRemove, fabricDsListPrefix, setDatastoreMasterKeyFromBytes } from './encryptedDatastore';
import {
  getFabricTrafficSnapshot,
  mergeTrustedNodeOrigin,
  reapplyIdentityOutbandRules
} from './identityOutband';
import { dismissPayment, payPayment, pendingPayments, receivePaymentRequest } from './paymentRequests';
import {
  FABRIC_PAYMENT_DISMISS,
  FABRIC_PAYMENT_PAY,
  FABRIC_PAYMENTS_LIST,
  FABRIC_RUNTIME_PAYMENT_REQUIRED
} from '../constants/fabric402';
import { swallowNonFatal } from '../utils/nonFatal';
import {
  assertAllowedFabricHub,
  loadFabricHubGateOptions
} from '../utils/fabricHubAllowlist';
import { originOfSender } from '../utils/fabricSiteMessage';

const NOTIFY_ID_MESH = 'fabric-mesh-line';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Linked-signer messages; Passport's own pages only. */
const DELEGATION_HANDLERS: Record<string, (m: Record<string, unknown>) => Promise<unknown>> = {
  [DELEGATION_STATE]: () => delegationState(),
  [DELEGATION_DISCOVER]: () => discover(),
  [DELEGATION_PAIR_LOCAL]: (m) => pairLocal(str(m.base)),
  [DELEGATION_PAIR_HUB]: (m) => pairHub(str(m.hub)),
  [DELEGATION_PAIR_INVITATION]: (m) => pairInvitation(str(m.invitation)),
  [DELEGATION_PAIR_CONFIRM]: (m) => confirmPairing(m.scopes),
  [DELEGATION_PAIR_CANCEL]: () => cancelPairing(),
  [DELEGATION_PAIRING_GET]: async () => ({ ok: true, pairing: pairingView() }),
  [DELEGATION_REVOKE]: (m) => revokeGrant(str(m.hash)),
  [DELEGATION_FORGET]: (m) => forgetSigner(str(m.pubkey)),
  [DELEGATION_ANSWER]: (m) => answerRequest({ hash: str(m.hash), action: str(m.action), frame: str(m.frame) || null }),
  [DELEGATION_ASK]: (m) => ask({ target: str(m.target), request: str(m.request), purpose: str(m.purpose) || undefined }),
  [DELEGATION_POLL]: () => pollMailboxes()
};

/**
 * The only messages a content script (any web page's frame) may send. Settings,
 * the encrypted datastore, pending prompts, and everything else answer
 * extension pages only.
 */
export const CONTENT_SCRIPT_MESSAGES: ReadonlySet<string> = new Set([
  'CONTENT_SCRIPT_LOADED',
  'FABRIC_HUB_REGISTER_MESH',
  'FABRIC_HUB_UNREGISTER_MESH',
  FABRIC_RUNTIME_PASSPORT_CHALLENGE,
  FABRIC_RUNTIME_PAYMENT_REQUIRED
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
    void privateSet(FABRIC_MESH_HUB_REGISTRATION_KEY, {
      hubAddress,
      registeredAt: Date.now(),
      source: 'popup'
    }).then(() => syncMeshFromStorage()).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (m.type === 'FABRIC_MESH_UNREGISTER_FROM_POPUP') {
    void privateRemove(FABRIC_MESH_HUB_REGISTRATION_KEY).then(() => syncMeshFromStorage()).then(() => sendResponse({ ok: true }));
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
      void privateSet(FABRIC_MESH_HUB_REGISTRATION_KEY, {
        hubAddress,
        pageOrigin: expectedOrigin,
        registeredAt: Date.now(),
        source: 'hub_page'
      }).then(() => syncMeshFromStorage()).then(() => sendResponse({ ok: true }));
    }).catch((e: unknown) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === 'FABRIC_HUB_UNREGISTER_MESH' && typeof m.pageOrigin === 'string') {
    void privateGet(FABRIC_MESH_HUB_REGISTRATION_KEY).then((got) => {
      const cur = got as Record<string, unknown> | undefined;
      if (!cur) {
        sendResponse({ ok: true });
        return;
      }
      const src = cur.source;
      const prevOrigin = typeof cur.pageOrigin === 'string' ? cur.pageOrigin : null;
      if (src === 'hub_page' && prevOrigin === m.pageOrigin) {
        void privateRemove(FABRIC_MESH_HUB_REGISTRATION_KEY).then(() => syncMeshFromStorage()).then(() => sendResponse({ ok: true }));
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

  /** Content script: a page answered 402 with an invoice; queue it for the popup. */
  if (m.type === FABRIC_RUNTIME_PAYMENT_REQUIRED && !fromExtension) {
    void receivePaymentRequest(m, sender, refreshBadge)
      .then((queued) => sendResponse({ ok: queued }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === FABRIC_PAYMENTS_LIST && fromExtension) {
    void pendingPayments().then((requests) => sendResponse({ ok: true, requests }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (m.type === FABRIC_PAYMENT_PAY && fromExtension && typeof m.id === 'string') {
    void payPayment(m.id, refreshBadge).then((r) => {
      showFabricNotification(r.ok ? 'Passport payment' : 'Passport payment failed', r.message);
      sendResponse(r);
    }).catch((e) => sendResponse({ ok: false, message: String(e instanceof Error ? e.message : e) }));
    return true;
  }

  if (m.type === FABRIC_PAYMENT_DISMISS && fromExtension && typeof m.id === 'string') {
    void dismissPayment(m.id, refreshBadge).then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));
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
      // No popup opens on its own (P-06): the notification and badge show the
      // sign-in, and a click on either opens it.
      try {
        if (mayNotifySignIn(queued.row.origin)) chrome.notifications.create(`${SIGN_IN_NOTIFICATION_PREFIX}${queued.row.key}`, {
          type: 'basic',
          iconUrl: 'icons/icon128.png',
          title: 'Sign-in request',
          message: `${queued.row.origin} asks you to sign in. Click to review.`,
          priority: 2
        });
      } catch (err: unknown) {
        swallowNonFatal('passport-sign-in-notify', err);
      }
      void refreshBadge();
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

  /** Popup: a linked signer answers the pending sign-in; delivered from here so closing the popup is fine. */
  if (m.type === FABRIC_RUNTIME_DELEGATE_SIGN_IN && fromExtension) {
    void completeWithDelegate(m)
      .then((out) => sendResponse(out))
      .catch((e: unknown) => sendResponse({ ok: false, error: String(e instanceof Error ? e.message : e) }));
    return true;
  }

  /** Content script: which loopback Hub (the active node) the page gates may allow. */
  if (fromExtension && typeof m.type === 'string' && DELEGATION_HANDLERS[m.type]) {
    void DELEGATION_HANDLERS[m.type](m)
      .then((out) => sendResponse(out))
      .catch((e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    return true;
  }

  return undefined;
}
