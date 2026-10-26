'use strict';

/**
 * Local desktop signers (Fabric Hub, GoonCitizen) reachable from Passport.
 *
 * Each desktop app serves `GET /services/fabric/identity` and
 * `POST /services/fabric/sign` on loopback only. Passport finds them on the
 * configured bases (default Hub `127.0.0.1:8080`, GoonCitizen `127.0.0.1:3041`),
 * device-links to them with the usual `/device-links` flow, and then asks them
 * to sign site logins with a `fabric:` `FabricSignRequest`.
 */

import { FABRIC_DESKTOP_SIGNERS_KEY } from '../constants/siteLogin';

export const DEFAULT_DESKTOP_SIGNER_BASES = [
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3041'
] as const;

export const FABRIC_IDENTITY_PATH = '/services/fabric/identity';
export const FABRIC_SIGN_PATH = '/services/fabric/sign';
export const FABRIC_LINK_PATH = '/services/fabric/link';

export type DesktopSigner = {
  base: string;
  signer: string;
  name: string | null;
  pubkey: string;
  id: string | null;
  linked: boolean;
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function defaultFetch (): FetchLike {
  return (input, init) => fetch(input, init);
}

/** Loopback `http(s)://host:port` only (`localhost`, `127.0.0.1`, `[::1]`). */
export function normalizeDesktopSignerBase (raw: unknown): string | null {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) text = `http://127.0.0.1:${text}`;
  if (!/^https?:\/\//i.test(text)) text = `http://${text}`;
  try {
    const u = new URL(text);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    const h = u.hostname.toLowerCase();
    if (h !== 'localhost' && h !== '127.0.0.1' && h !== '[::1]') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export function parseDesktopSignerBases (raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\s,]+/);
  const out: string[] = [];
  for (const part of parts) {
    const base = normalizeDesktopSignerBase(part);
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

export async function readDesktopSignerBases (): Promise<string[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return [...DEFAULT_DESKTOP_SIGNER_BASES];
    const got = await chrome.storage.local.get(FABRIC_DESKTOP_SIGNERS_KEY);
    const stored = got && got[FABRIC_DESKTOP_SIGNERS_KEY];
    if (stored == null) return [...DEFAULT_DESKTOP_SIGNER_BASES];
    return parseDesktopSignerBases(stored);
  } catch {
    return [...DEFAULT_DESKTOP_SIGNER_BASES];
  }
}

export async function writeDesktopSignerBases (raw: unknown): Promise<string[]> {
  const list = parseDesktopSignerBases(raw);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [FABRIC_DESKTOP_SIGNERS_KEY]: list });
  }
  return list;
}

async function fetchWithTimeout (fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...init, signal: controller ? controller.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Chrome ends an MV3 service worker whose fetch waits over 30 s; any extension API call resets that timer. */
export const KEEPALIVE_EVERY_MS = 20000;

async function keepWorkerAlive<T> (work: Promise<T>): Promise<T> {
  const runtime = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
  if (!runtime || typeof runtime.getPlatformInfo !== 'function') return work;
  const timer = setInterval(() => {
    try {
      runtime.getPlatformInfo(() => { void runtime.lastError; });
    } catch {
      /* extension context gone; the fetch fails on its own */
    }
  }, KEEPALIVE_EVERY_MS);
  try {
    return await work;
  } finally {
    clearInterval(timer);
  }
}

/**
 * Ask each base who it is. Locked or unreachable desktops are skipped.
 * @param pubkey Passport pubkey (compressed hex) so each desktop says whether it is linked.
 */
export async function discoverDesktopSigners (opts: {
  bases?: string[];
  pubkey?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<DesktopSigner[]> {
  const bases = opts.bases ? parseDesktopSignerBases(opts.bases) : await readDesktopSignerBases();
  const fetchImpl = opts.fetchImpl || defaultFetch();
  const query = opts.pubkey && /^0[23][0-9a-f]{64}$/i.test(opts.pubkey)
    ? `?pubkey=${encodeURIComponent(opts.pubkey.toLowerCase())}`
    : '';
  const found = await Promise.all(bases.map(async (base): Promise<DesktopSigner | null> => {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${base}${FABRIC_IDENTITY_PATH}${query}`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'omit'
      }, opts.timeoutMs || 1500);
      if (!res.ok) return null;
      const body = await res.json() as Record<string, unknown>;
      if (!body || body.ok !== true || body.locked === true) return null;
      const pubkey = String(body.pubkey || '').toLowerCase();
      if (!/^0[23][0-9a-f]{64}$/.test(pubkey)) return null;
      return {
        base,
        signer: String(body.signer || 'desktop'),
        name: typeof body.name === 'string' ? body.name : null,
        pubkey,
        id: typeof body.id === 'string' ? body.id : null,
        linked: body.linked === true
      };
    } catch {
      return null;
    }
  }));
  return found.filter((s): s is DesktopSigner => !!s);
}

/**
 * POST a `fabric:` `FabricSignRequest` and return the desktop's `fabric:`
 * response. Waits until the request expires (the desktop user is deciding).
 * The caller verifies the response before using it.
 */
export async function requestDesktopSignature (opts: {
  base: string;
  signRequestUri: string;
  expiresAt: number;
  fetchImpl?: FetchLike;
  now?: number;
}): Promise<{ ok: true; uri: string } | { ok: false; error: string; status?: number }> {
  const base = normalizeDesktopSignerBase(opts.base);
  if (!base) return { ok: false, error: 'desktop signer must be on loopback' };
  const fetchImpl = opts.fetchImpl || defaultFetch();
  const now = Number.isFinite(opts.now) ? Number(opts.now) : Date.now();
  const waitMs = Math.max(1000, opts.expiresAt - now + 5000);
  try {
    const res = await keepWorkerAlive(fetchWithTimeout(fetchImpl, `${base}${FABRIC_SIGN_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'text/plain;charset=utf-8' },
      body: opts.signRequestUri,
      cache: 'no-store',
      credentials: 'omit'
    }, waitMs));
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || body.ok !== true || typeof body.fabric !== 'string') {
      return {
        ok: false,
        status: res.status,
        error: typeof body.error === 'string' ? body.error : `desktop refused (HTTP ${res.status})`
      };
    }
    return { ok: true, uri: body.fabric };
  } catch (e: unknown) {
    const aborted = e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
    return { ok: false, error: aborted ? 'desktop did not answer in time' : 'desktop app not reachable' };
  }
}

/**
 * Ask a desktop app to accept a device-link offer Passport just made on that
 * desktop's own loopback `/device-links`. The desktop shows a native approval
 * and, once approved, signs as the responder; Passport's usual poll then
 * countersigns. Waits while the desktop user decides (about two minutes).
 */
export async function requestDesktopLink (opts: {
  base: string;
  sessionId: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}): Promise<{ ok: true; signer: string } | { ok: false; error: string; status?: number }> {
  const base = normalizeDesktopSignerBase(opts.base);
  if (!base) return { ok: false, error: 'desktop signer must be on loopback' };
  if (!/^[0-9a-f]{48}$/i.test(String(opts.sessionId || ''))) return { ok: false, error: 'invalid link session' };
  const fetchImpl = opts.fetchImpl || defaultFetch();
  try {
    const res = await keepWorkerAlive(fetchWithTimeout(fetchImpl, `${base}${FABRIC_LINK_PATH}`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.sessionId }),
      cache: 'no-store',
      credentials: 'omit'
    }, opts.timeoutMs || 150000));
    const body = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok || body.ok !== true) {
      return {
        ok: false,
        status: res.status,
        error: typeof body.error === 'string' ? body.error : `desktop refused (HTTP ${res.status})`
      };
    }
    return { ok: true, signer: String(body.signer || 'desktop') };
  } catch (e: unknown) {
    const aborted = e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';
    return { ok: false, error: aborted ? 'desktop did not answer in time' : 'desktop app not reachable' };
  }
}
