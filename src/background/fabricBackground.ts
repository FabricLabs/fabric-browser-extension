'use strict';

import { FABRIC_MESH_HUB_REGISTRATION_KEY, FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import { handleFabricRuntimeMessage } from './fabricBackgroundRuntimeMessages';
import { initIdentityOutband } from './identityOutband';
import { swallowNonFatal } from '../utils/nonFatal';

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

const OFFSCREEN_PATH = 'background/offscreen.html';
const ALARM_MESH_KEEPALIVE = 'fabric_mesh_keepalive';

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
  } catch (err: unknown) {
    swallowNonFatal('mesh-hub-storage', err);
  }
  try {
    const data = await chrome.storage.local.get(FABRIC_STATE_STORAGE_KEY);
    return extractActiveFabricHub(data[FABRIC_STATE_STORAGE_KEY]);
  } catch (err: unknown) {
    swallowNonFatal('fabric-state-storage', err);
    return null;
  }
}

async function ensureOffscreenDocument (): Promise<void> {
  try {
    if (chrome.offscreen.hasDocument) {
      const has = await chrome.offscreen.hasDocument();
      if (has) return;
    }
  } catch (err: unknown) {
    swallowNonFatal('offscreen-has-document', err);
  }
  try {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL(OFFSCREEN_PATH),
      reasons: [chrome.offscreen.Reason.WEB_RTC],
      justification: 'Maintain Fabric Protocol WebRTC signaling and peer mesh while the popup is closed.'
    });
  } catch (err: unknown) {
    swallowNonFatal('offscreen-create-document', err);
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

function registerMeshPort (port: chrome.runtime.Port): void {
  if (port.name !== 'fabric-mesh-runtime') return;
  meshPort = port;
  port.onDisconnect.addListener(() => {
    meshPort = null;
  });
  port.onMessage.addListener((msg: unknown) => {
    void msg;
  });
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

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    return handleFabricRuntimeMessage(message, sender, sendResponse, {
      fabricActionDebugUrl: FABRIC_ACTION_DEBUG_URL,
      syncMeshFromStorage
    });
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
