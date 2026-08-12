'use strict';

/**
 * For origins the user trusted via **Connect & register** (see IdentityManager + RegisterWebRTCPeer),
 * the service worker:
 * 1) adds `X-Fabric-Identity` to outgoing subresource and navigation requests (declarativeNetRequest),
 * 2) aggregates rough request + Content-Length–based byte counts (webRequest observation only).
 * No xprv; value mirrors public material already sent in RPC metadata.
 */

import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import {
  DNR_IDENTITY_HEADER_RULE_ID_MAX,
  DNR_IDENTITY_HEADER_RULE_ID_MIN,
  FABRIC_TRUSTED_HTTP_ORIGINS_KEY,
  X_FABRIC_IDENTITY
} from '../constants/identityOutband';
import { formatXFabricIdentityValue } from './identityOutbandValue';
import { swallowNonFatal } from '../utils/nonFatal';

const ALL_URLS = '<all_urls>';

type SimpleIdentity = { isCurrent?: boolean; publicKeyHex?: string; id?: string };

type Traffic = { requests: number; responseBytes: number; updated: number };
const trafficByOrigin: Record<string, Traffic> = {};
let trafficOrigins = new Set<string>();

function allReservedRuleIds (): number[] {
  const out: number[] = [];
  for (let id = DNR_IDENTITY_HEADER_RULE_ID_MIN; id <= DNR_IDENTITY_HEADER_RULE_ID_MAX; id++) {
    out.push(id);
  }
  return out;
}

function getHeader (headers: chrome.webRequest.HttpHeader[] | undefined, name: string): string | null {
  if (!headers) return null;
  const n = name.toLowerCase();
  for (const h of headers) {
    if (h && typeof h.name === 'string' && h.name.toLowerCase() === n) {
      return typeof h.value === 'string' ? h.value : null;
    }
  }
  return null;
}

export async function reapplyIdentityOutbandRules (): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateDynamicRules) {
    return;
  }

  const got = await chrome.storage.local.get([FABRIC_STATE_STORAGE_KEY, FABRIC_TRUSTED_HTTP_ORIGINS_KEY]);
  const trustList = (got[FABRIC_TRUSTED_HTTP_ORIGINS_KEY] as string[] | undefined)?.filter(Boolean) ?? [];
  const rawState = got[FABRIC_STATE_STORAGE_KEY];
  const identities: SimpleIdentity[] =
    rawState && typeof rawState === 'object' && Array.isArray((rawState as { identities?: unknown }).identities)
      ? (rawState as { identities: SimpleIdentity[] }).identities
      : [];
  const cur = identities.find((i) => i.isCurrent) || identities[0];
  const headerValue = cur ? formatXFabricIdentityValue(cur) : null;
  const valid = Boolean(headerValue && headerValue !== 'unknown');

  trafficOrigins = new Set(
    valid ? trustList.filter((o) => {
      try {
        const u = new URL(o);
        return u.protocol === 'http:' || u.protocol === 'https:';
      } catch (err: unknown) {
        swallowNonFatal('identity-outband-trust-url', err);
        return false;
      }
    })
      : []
  );

  const addRules: chrome.declarativeNetRequest.Rule[] = [];
  if (valid && trustList.length > 0 && cur) {
    const value = formatXFabricIdentityValue(cur);
    const max = Math.min(trustList.length, DNR_IDENTITY_HEADER_RULE_ID_MAX - DNR_IDENTITY_HEADER_RULE_ID_MIN + 1);
    for (let i = 0; i < max; i++) {
      const origin = trustList[i];
      let urlFilter: string;
      try {
        const u = new URL(origin);
        const h = u.hostname;
        const p = u.port || (u.protocol === 'https:' ? '443' : '80');
        urlFilter = `*://${h}:${p}/*`;
      } catch (err: unknown) {
        swallowNonFatal('identity-outband-rule-url', err);
        continue;
      }
      const ruleId = DNR_IDENTITY_HEADER_RULE_ID_MIN + i;
      const R = chrome.declarativeNetRequest.ResourceType;
      addRules.push({
        id: ruleId,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.MODIFY_HEADERS,
          requestHeaders: [
            { header: X_FABRIC_IDENTITY, operation: chrome.declarativeNetRequest.HeaderOperation.SET, value }
          ]
        },
        /* Omit websocket/upgrade paths — header injection targets normal document + asset requests. */
        condition: { urlFilter, resourceTypes: [R.MAIN_FRAME, R.SUB_FRAME, R.XMLHTTPREQUEST, R.OTHER, R.IMAGE, R.SCRIPT, R.STYLESHEET, R.MEDIA, R.FONT, R.PING, R.OBJECT] }
      });
    }
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: allReservedRuleIds(),
      addRules
    });
  } catch (e: unknown) {
    console.warn('[FABRIC:OUTBAND] updateDynamicRules failed', e);
  }
}

function touchTraffic (origin: string, addBytes: number): void {
  if (!trafficOrigins.has(origin)) return;
  const t: Traffic = trafficByOrigin[origin] ?? { requests: 0, responseBytes: 0, updated: Date.now() };
  t.requests += 1;
  if (addBytes > 0) t.responseBytes += addBytes;
  t.updated = Date.now();
  trafficByOrigin[origin] = t;
}

function addResponseBytes (origin: string, n: number): void {
  if (!trafficOrigins.has(origin) || n <= 0) return;
  const t: Traffic = trafficByOrigin[origin] ?? { requests: 0, responseBytes: 0, updated: Date.now() };
  t.responseBytes += n;
  t.updated = Date.now();
  trafficByOrigin[origin] = t;
}

export function getFabricTrafficSnapshot (): { origins: string[]; byOrigin: Record<string, Traffic> } {
  const byOrigin: Record<string, Traffic> = {};
  for (const o of trafficOrigins) {
    if (trafficByOrigin[o]) byOrigin[o] = { ...trafficByOrigin[o] };
  }
  return { origins: Array.from(trafficOrigins), byOrigin };
}

/** Serialize read-modify-write on trusted origins to avoid concurrent drops. */
let mergeTrustedChain: Promise<void> = Promise.resolve();

export async function mergeTrustedNodeOrigin (origin: string): Promise<void> {
  const job = mergeTrustedChain.then(() => mergeTrustedNodeOriginImpl(origin));
  mergeTrustedChain = job.catch((err: unknown) => {
    swallowNonFatal('merge-trusted-node-origin', err);
  });
  await job;
}

async function mergeTrustedNodeOriginImpl (origin: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(origin);
  } catch (err: unknown) {
    swallowNonFatal('merge-trusted-node-parse', err);
    return;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  const o = u.origin;
  const got = await chrome.storage.local.get(FABRIC_TRUSTED_HTTP_ORIGINS_KEY);
  const cur = (got[FABRIC_TRUSTED_HTTP_ORIGINS_KEY] as string[] | undefined) ?? [];
  if (cur.includes(o)) {
    return;
  }
  const next = [...cur, o].slice(-32);
  await chrome.storage.local.set({ [FABRIC_TRUSTED_HTTP_ORIGINS_KEY]: next });
}

export function initIdentityOutband (): void {
  void reapplyIdentityOutbandRules();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[FABRIC_STATE_STORAGE_KEY] || changes[FABRIC_TRUSTED_HTTP_ORIGINS_KEY]) {
      void reapplyIdentityOutbandRules();
    }
  });

  if (typeof chrome === 'undefined' || !chrome.webRequest?.onBeforeRequest) {
    return;
  }

  const filter: chrome.webRequest.RequestFilter = { urls: [ALL_URLS] };

  chrome.webRequest.onBeforeRequest.addListener(
    (d) => {
      try {
        const origin = new URL(d.url).origin;
        if (!trafficOrigins.has(origin)) return;
        touchTraffic(origin, 0);
      } catch (err: unknown) {
        swallowNonFatal('identity-traffic-on-before', err);
      }
    },
    filter
  );

  chrome.webRequest.onHeadersReceived.addListener(
    (d) => {
      try {
        const origin = new URL(d.url).origin;
        if (!trafficOrigins.has(origin)) return;
        const cl = getHeader(d.responseHeaders, 'content-length');
        if (cl) {
          const n = parseInt(cl, 10);
          if (Number.isFinite(n) && n > 0) addResponseBytes(origin, n);
        }
      } catch (err: unknown) {
        swallowNonFatal('identity-traffic-on-headers', err);
      }
    },
    filter,
    ['responseHeaders']
  );
}
