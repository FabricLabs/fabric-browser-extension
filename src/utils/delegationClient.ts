'use strict';

/**
 * Transports for delegation frames (`@fabric/core` `functions/delegation`):
 *
 * - linked signers on this computer (Fabric Hub, GoonCitizen) answer on
 *   loopback at `/services/delegation` (`@fabric/http` `fabricDelegate`);
 * - a trusted Hub's `/delegations` rendezvous carries pairing frames between
 *   two participants that cannot reach each other;
 * - a trusted Hub's `/services/delegation/mailbox` holds requests, results,
 *   grants, and revocations until their addressee collects them.
 *
 * These helpers only move `fabric:` strings; the background's `Delegation`
 * builds and checks every frame. Each resolves (never rejects) with the
 * route's JSON plus `httpStatus`, or `{ ok: false, httpStatus: 0, error }`.
 */

import { FABRIC_DELEGATE_BASES_KEY } from '../constants/siteLogin';
import { privateGet, privateSet } from './privateStore';

export const DEFAULT_DELEGATE_BASES = [
  'http://127.0.0.1:8080',
  'http://127.0.0.1:3041'
] as const;

export const DELEGATE_PATH = '/services/delegation';
export const DELEGATE_LINKS_PATH = '/services/delegation/links';
export const DELEGATE_REQUESTS_PATH = '/services/delegation/requests';
export const RENDEZVOUS_PATH = '/delegations';
export const MAILBOX_PATH = '/services/delegation/mailbox';
export const MAILBOX_HEADER = 'X-Fabric-Mailbox';

export const DELEGATE_OUTDATED_ERROR = 'This app is out of date. Update Fabric Hub or GoonCitizen to link it with Passport.';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type CallResult = { ok: boolean; httpStatus: number; error?: string; [key: string]: unknown };

/** A linked signer (or one that could be) answering on this computer. */
export type LocalDelegate = {
  base: string;
  signer: string;
  name: string | null;
  network: string | null;
  locked: boolean;
  /** Compressed identity pubkey of the app. */
  pubkey: string;
  /** This Passport holds a grant from it (and the app accepts this extension). */
  granted: boolean;
  scopes: string[];
};

const PUBKEY = /^0[23][0-9a-f]{64}$/;

function defaultFetch (): FetchLike {
  return (input, init) => fetch(input, init);
}

/** Loopback `http(s)://host:port` only (`localhost`, `127.0.0.1`, `[::1]`). */
export function normalizeDelegateBase (raw: unknown): string | null {
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

export function parseDelegateBases (raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw == null ? '' : raw).split(/[\s,]+/);
  const out: string[] = [];
  for (const part of parts) {
    const base = normalizeDelegateBase(part);
    if (base && !out.includes(base)) out.push(base);
  }
  return out;
}

export async function readDelegateBases (): Promise<string[]> {
  try {
    const stored = await privateGet(FABRIC_DELEGATE_BASES_KEY);
    if (stored == null) return [...DEFAULT_DELEGATE_BASES];
    return parseDelegateBases(stored);
  } catch {
    return [...DEFAULT_DELEGATE_BASES];
  }
}

export async function writeDelegateBases (raw: unknown): Promise<string[]> {
  const list = parseDelegateBases(raw);
  await privateSet(FABRIC_DELEGATE_BASES_KEY, list);
  return list;
}

/** Chrome ends an MV3 service worker whose fetch waits over 30 s; any extension API call resets that timer. */
export const KEEPALIVE_EVERY_MS = 20000;

export async function keepWorkerAlive<T> (work: Promise<T>): Promise<T> {
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

/** What to tell the user when an app refuses a delegation call. */
export function delegateRefusalError (status: number, error: unknown): string {
  const text = typeof error === 'string' ? error : '';
  if (status === 404 || status === 405) return DELEGATE_OUTDATED_ERROR;
  if (status === 426) return 'This Passport is out of date for that app. Update Passport.';
  if (status === 0) return text || 'not reachable';
  return text || `refused (HTTP ${status})`;
}

async function call (url: string, init: RequestInit & { timeoutMs?: number; fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  const run = init.fetchImpl || defaultFetch();
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), init.timeoutMs || 15000) : null;
  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (init.body) headers['Content-Type'] = 'application/json';
    Object.assign(headers, (init.headers || {}) as Record<string, string>);
    const res = await keepWorkerAlive(run(url, {
      method: init.method || 'GET',
      body: init.body,
      headers,
      cache: 'no-store',
      credentials: 'omit',
      signal: controller ? controller.signal : undefined
    }));
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    return { ...json, ok: res.ok && json.ok !== false, httpStatus: res.status } as CallResult;
  } catch (err: unknown) {
    const aborted = !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
    return { ok: false, httpStatus: 0, error: aborted ? 'did not answer in time' : 'not reachable' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function trim (origin: string): string {
  return String(origin || '').replace(/\/$/, '');
}

function postFrame (url: string, body: Record<string, unknown>, timeoutMs?: number, fetchImpl?: FetchLike): Promise<CallResult> {
  return call(url, { method: 'POST', body: JSON.stringify(body), timeoutMs, fetchImpl });
}

/**
 * Ask each loopback base who answers there. Unreachable bases and apps
 * without `/services/delegation` are skipped.
 * @param opts.pubkey This Passport's identity, so each app says whether it granted it anything.
 */
export async function discoverDelegates (opts: {
  bases?: string[];
  pubkey?: string | null;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
} = {}): Promise<LocalDelegate[]> {
  const bases = opts.bases ? parseDelegateBases(opts.bases) : await readDelegateBases();
  const query = opts.pubkey && PUBKEY.test(String(opts.pubkey).toLowerCase())
    ? `?pubkey=${encodeURIComponent(String(opts.pubkey).toLowerCase())}`
    : '';
  const found = await Promise.all(bases.map(async (base): Promise<LocalDelegate | null> => {
    const body = await call(`${base}${DELEGATE_PATH}${query}`, { timeoutMs: opts.timeoutMs || 1500, fetchImpl: opts.fetchImpl });
    if (!body.ok) return null;
    const pubkey = String(body.pubkey || '').toLowerCase();
    if (!PUBKEY.test(pubkey)) return null;
    return {
      base,
      signer: String(body.signer || 'app'),
      name: typeof body.name === 'string' ? body.name : null,
      network: typeof body.network === 'string' ? body.network : null,
      locked: body.locked === true,
      pubkey,
      granted: body.granted === true,
      scopes: Array.isArray(body.scopes) ? (body.scopes as unknown[]).map(String) : []
    };
  }));
  return found.filter((d): d is LocalDelegate => !!d);
}

/** Pass a pairing frame (offer, reveal, grant, revoke) to a linked signer on this computer. A reveal waits for its user. */
export function postDelegateLink (base: string, frame: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<CallResult> {
  return postFrame(`${trim(base)}${DELEGATE_LINKS_PATH}`, { frame }, opts.timeoutMs || 150000, opts.fetchImpl);
}

/** Pass a `DELEGATION_REQUEST` to a linked signer on this computer (`{ status, result }`). */
export function postDelegateRequest (base: string, frame: string, opts: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<CallResult> {
  return postFrame(`${trim(base)}${DELEGATE_REQUESTS_PATH}`, { frame }, opts.timeoutMs || 30000, opts.fetchImpl);
}

/** Status of a request a linked signer is holding for its user. */
export function readDelegateRequest (base: string, hash: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return call(`${trim(base)}${DELEGATE_REQUESTS_PATH}/${encodeURIComponent(hash)}`, { timeoutMs: 10000, fetchImpl: opts.fetchImpl });
}

/** Open a link on a rendezvous with an offer. */
export function openLink (origin: string, frame: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return postFrame(`${trim(origin)}${RENDEZVOUS_PATH}`, { frame }, 15000, opts.fetchImpl);
}

/** Add the next frame (answer, reveal, grant) to a link. */
export function postLinkFrame (origin: string, linkId: string, frame: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return postFrame(`${trim(origin)}${RENDEZVOUS_PATH}/${encodeURIComponent(linkId)}/frames`, { frame }, 15000, opts.fetchImpl);
}

/** A link's frames so far (`{ status, frames, expiresAt }`). */
export function readLink (origin: string, linkId: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return call(`${trim(origin)}${RENDEZVOUS_PATH}/${encodeURIComponent(linkId)}`, { timeoutMs: 15000, fetchImpl: opts.fetchImpl });
}

/** End a link early; `proof` is a `DELEGATION_MAILBOX_FETCH` from either participant. */
export function cancelLink (origin: string, linkId: string, proof: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return call(`${trim(origin)}${RENDEZVOUS_PATH}/${encodeURIComponent(linkId)}`, {
    method: 'DELETE',
    headers: { [MAILBOX_HEADER]: proof },
    timeoutMs: 15000,
    fetchImpl: opts.fetchImpl
  });
}

/** Leave a frame in a Hub mailbox; `to` names the addressee of results and revocations. */
export function postMailbox (origin: string, frame: string, opts: { to?: string; fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  const body: Record<string, unknown> = { frame };
  if (opts.to) body.to = opts.to;
  return postFrame(`${trim(origin)}${MAILBOX_PATH}`, body, 15000, opts.fetchImpl);
}

/** Frames left for the key that signed `proof` (`{ frames: [{ seq, type, hash, frame, at }], next }`). */
export function fetchMailbox (origin: string, proof: string, opts: { fetchImpl?: FetchLike } = {}): Promise<CallResult> {
  return call(`${trim(origin)}${MAILBOX_PATH}`, { headers: { [MAILBOX_HEADER]: proof }, timeoutMs: 15000, fetchImpl: opts.fetchImpl });
}
