'use strict';

/**
 * Background side of Passport v2 sign-in.
 *
 * - Pages hand a `PASSPORT_CHALLENGE` to the content script, which forwards it
 *   here. It is read against the origin the browser reports for that frame and
 *   queued for the popup: at most one per tab and frame, a few in total, each
 *   dropped at its expiry, and each nonce only once.
 * - The popup signs (or asks a linked signer to, as a `DELEGATION_REQUEST`)
 *   and the assertion comes back here. It is verified against the queued
 *   challenge and delivered to the content script of that frame only, which
 *   posts it on the page's port.
 * - One sign-in waits per origin: a newer challenge from the same site
 *   replaces the older one, whose page is told so.
 */

import {
  FABRIC_PASSPORT_PAGE_RESULT,
  FABRIC_PASSPORT_SEEN_NONCES_KEY,
  FABRIC_PENDING_PASSPORT_KEY
} from '../constants/siteLogin';
import {
  DESKTOP_SIGNERS,
  PASSPORT_SIGNER,
  originOfSender,
  originOfUrl,
  readPageChallenge,
  sanitizeSitePurpose,
  verifyPageAssertion,
  type PassportDisclosure
} from '../utils/fabricSiteMessage';
import { refreshBadge, signInThrough } from './delegation';
import { swallowNonFatal } from '../utils/nonFatal';

export type PendingPassportRow = {
  /** `${tabId}:${frameId}` */
  key: string;
  /** Content-script id for the page's port (never shown to the page). */
  requestId: string;
  tabId: number;
  frameId: number;
  tabTitle: string | null;
  origin: string;
  challenge: string;
  challengeHash: string;
  nonce: string;
  purpose: string | null;
  network: string | null;
  request: PassportDisclosure[];
  siteAuthor: string | null;
  expiresAt: number;
  createdAt: number;
};

/** Most sign-ins waiting at once, over all tabs. */
export const MAX_PENDING_PASSPORT = 8;
/** Most challenge nonces remembered (each until its challenge expires). */
export const MAX_SEEN_NONCES = 1024;

type Fail = { ok: false; error: string };

/**
 * A sign-in may come only from the top page or a frame with the top page's
 * origin, so a site can't put Passport's prompt under another site's frame.
 */
export function checkSenderFrame (sender: chrome.runtime.MessageSender): { ok: true } | { ok: false; error: 'cross_origin_frame' } {
  if (!sender.frameId) return { ok: true };
  const frame = originOfSender(sender);
  const top = sender.tab ? originOfUrl(sender.tab.url) : null;
  return frame && top && frame === top ? { ok: true } : { ok: false, error: 'cross_origin_frame' };
}

export type FrameRecord = { frameId: number; parentFrameId: number; url?: string };

/**
 * Every frame from `frameId` up to the top must be `topOrigin`. An A-B-A nest
 * fails here even though the leaf and the top share an origin.
 */
export function ancestorsShareOrigin (frames: FrameRecord[], frameId: number, topOrigin: string): boolean {
  const byId = new Map(frames.map((f) => [f.frameId, f]));
  let id = frameId;
  const seen = new Set<number>();
  while (id > 0) {
    if (seen.has(id)) return false;
    seen.add(id);
    const frame = byId.get(id);
    if (!frame || originOfUrl(frame.url) !== topOrigin) return false;
    id = frame.parentFrameId;
  }
  return true;
}

export async function frameAncestorsOk (sender: chrome.runtime.MessageSender): Promise<boolean> {
  if (!checkSenderFrame(sender).ok) return false;
  if (!sender.frameId) return true;
  const top = sender.tab ? originOfUrl(sender.tab.url) : null;
  if (!top || !sender.tab || sender.tab.id == null) return false;
  const nav = (chrome as { webNavigation?: { getAllFrames?: (q: { tabId: number }) => Promise<FrameRecord[] | null> } }).webNavigation;
  if (!nav || typeof nav.getAllFrames !== 'function') return true;
  try {
    const frames = await nav.getAllFrames({ tabId: sender.tab.id });
    if (!frames) return false;
    return ancestorsShareOrigin(frames, sender.frameId, top);
  } catch {
    return false;
  }
}

const NOTIFY_GAP_MS = 30_000;
const lastSignInNotify = new Map<string, number>();

/** At most one sign-in notification per origin in this window. */
export function mayNotifySignIn (origin: string, now: number = Date.now()): boolean {
  const prev = lastSignInNotify.get(origin) || 0;
  if (now - prev < NOTIFY_GAP_MS) return false;
  lastSignInNotify.set(origin, now);
  return true;
}

function sessionStore (): chrome.storage.StorageArea | null {
  return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) || null;
}

/** Waiting sign-ins still inside their challenge's lifetime. */
export function livePending (rows: unknown, now: number = Date.now()): PendingPassportRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r): r is PendingPassportRow => !!r && typeof r === 'object' &&
    typeof (r as PendingPassportRow).key === 'string' &&
    Number((r as PendingPassportRow).expiresAt) > now);
}

export async function readPendingPassport (now: number = Date.now()): Promise<PendingPassportRow[]> {
  const store = sessionStore();
  if (!store) return [];
  const got = await store.get(FABRIC_PENDING_PASSPORT_KEY);
  return livePending(got && got[FABRIC_PENDING_PASSPORT_KEY], now);
}

async function writePendingPassport (rows: PendingPassportRow[]): Promise<void> {
  const store = sessionStore();
  if (!store) throw new Error('session storage unavailable');
  await store.set({ [FABRIC_PENDING_PASSPORT_KEY]: rows });
  void refreshBadge();
}

/**
 * Record a challenge nonce; false when it was already seen (a page replaying a
 * challenge it got answered once). Entries drop out when their challenge expires.
 */
export function rememberNonce (
  seen: Record<string, number>,
  nonce: string,
  expiresAt: number,
  now: number = Date.now()
): { ok: boolean; seen: Record<string, number> } {
  const next: Record<string, number> = {};
  for (const [n, exp] of Object.entries(seen || {})) {
    if (Number(exp) > now) next[n] = Number(exp);
  }
  if (next[nonce]) return { ok: false, seen: next };
  const keys = Object.keys(next);
  if (keys.length >= MAX_SEEN_NONCES) {
    keys.sort((a, b) => next[a] - next[b]);
    for (const k of keys.slice(0, keys.length - MAX_SEEN_NONCES + 1)) delete next[k];
  }
  next[nonce] = expiresAt;
  return { ok: true, seen: next };
}

/**
 * Pending rows and seen nonces are read-modify-write records in session
 * storage; every change goes through this one queue so two challenges
 * arriving together can't both claim a nonce or drop each other's row.
 */
let sessionQueue: Promise<unknown> = Promise.resolve();

export function serialized<T> (work: () => Promise<T>): Promise<T> {
  const run = sessionQueue.then(work, work);
  sessionQueue = run.catch(() => undefined);
  return run;
}

async function claimNonce (nonce: string, expiresAt: number): Promise<boolean> {
  const store = sessionStore();
  if (!store) return false;
  const got = await store.get(FABRIC_PASSPORT_SEEN_NONCES_KEY);
  const seen = ((got && got[FABRIC_PASSPORT_SEEN_NONCES_KEY]) || {}) as Record<string, number>;
  const out = rememberNonce(seen, nonce, expiresAt);
  await store.set({ [FABRIC_PASSPORT_SEEN_NONCES_KEY]: out.seen });
  return out.ok;
}

/**
 * Read a page's challenge into a pending row. Pure: no storage.
 * @param m Content-script message `{ requestId, challenge }`.
 */
export function buildPendingRow (
  m: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  now: number = Date.now()
): { ok: true; row: PendingPassportRow } | Fail {
  if (!sender.tab || typeof sender.tab.id !== 'number') return { ok: false, error: 'not_a_tab' };
  const frame = checkSenderFrame(sender);
  if (!frame.ok) return frame;
  const origin = originOfSender(sender);
  if (!origin) return { ok: false, error: 'origin_unknown' };
  const requestId = typeof m.requestId === 'string' && /^[0-9a-f]{32}$/.test(m.requestId) ? m.requestId : '';
  if (!requestId) return { ok: false, error: 'invalid_request' };
  const read = readPageChallenge(m.challenge, origin, now);
  if (!read.ok) return read;
  const c = read.challenge;
  const frameId = typeof sender.frameId === 'number' ? sender.frameId : 0;
  return {
    ok: true,
    row: {
      key: `${sender.tab.id}:${frameId}`,
      requestId,
      tabId: sender.tab.id,
      frameId,
      tabTitle: sanitizeSitePurpose(sender.tab.title),
      origin: c.origin,
      challenge: c.uri,
      challengeHash: c.hash,
      nonce: c.nonce,
      purpose: sanitizeSitePurpose(c.purpose),
      network: c.network,
      request: c.request,
      siteAuthor: c.siteAuthor,
      expiresAt: c.expiresAt,
      createdAt: now
    }
  };
}

/**
 * Queue a challenge for the popup. A new challenge from the same frame
 * replaces that frame's (the content script already cancelled its port); one
 * from the same origin in another tab or frame replaces that one too (P-06).
 */
export async function queuePassportChallenge (
  m: Record<string, unknown>,
  sender: chrome.runtime.MessageSender
): Promise<{ ok: true; row: PendingPassportRow } | Fail> {
  const built = buildPendingRow(m, sender);
  if (!built.ok) return built;
  if (!(await frameAncestorsOk(sender))) return { ok: false, error: 'cross_origin_frame' };
  const row = built.row;
  return serialized(async () => {
    const rows = await readPendingPassport();
    const replaced = rows.filter((r) => r.key !== row.key && r.origin === row.origin);
    const others = rows.filter((r) => r.key !== row.key && r.origin !== row.origin);
    if (others.length >= MAX_PENDING_PASSPORT) return { ok: false as const, error: 'busy' };
    if (!(await claimNonce(row.nonce, row.expiresAt))) return { ok: false as const, error: 'challenge_replayed' };
    await writePendingPassport([...others, row]);
    for (const old of replaced) deliverToPage(old, { ok: false, error: 'replaced' });
    return { ok: true as const, row };
  });
}

async function takePending (key: string, requestId?: string): Promise<PendingPassportRow | null> {
  return serialized(async () => {
    const rows = await readPendingPassport();
    const row = rows.find((r) => r.key === key && (!requestId || r.requestId === requestId)) || null;
    if (row) await writePendingPassport(rows.filter((r) => r !== row));
    return row;
  });
}

async function peekPending (key: string, requestId?: string): Promise<PendingPassportRow | null> {
  const rows = await readPendingPassport();
  return rows.find((r) => r.key === key && (!requestId || r.requestId === requestId)) || null;
}

/** Hand the result to the content script of that frame, which checks its origin and posts on the page's port. */
export function deliverToPage (row: PendingPassportRow, payload: { ok: true; assertion: string } | { ok: false; error: string }): void {
  const message = {
    type: FABRIC_PASSPORT_PAGE_RESULT,
    origin: row.origin,
    requestId: row.requestId,
    ...payload
  };
  void Promise.resolve(chrome.tabs.sendMessage(row.tabId, message, { frameId: row.frameId }))
    .catch((err: unknown) => swallowNonFatal('passport-page-result', err));
}

/** What the background checks an assertion against before the page sees it. */
function expectationsFor (row: PendingPassportRow) {
  return {
    origin: row.origin,
    nonce: row.nonce,
    challengeHash: row.challengeHash,
    challengeExpiresAt: row.expiresAt,
    network: row.network,
    allow: row.request
  };
}

/**
 * Popup answered a pending sign-in: an assertion it signed, or a refusal.
 * @param m `{ key, requestId, ok, assertion? , error? }`
 */
export async function answerPassport (m: Record<string, unknown>): Promise<{ ok: true } | Fail> {
  const key = typeof m.key === 'string' ? m.key : '';
  const requestId = typeof m.requestId === 'string' ? m.requestId : undefined;
  if (m.ok !== true) {
    const row = await takePending(key, requestId);
    if (!row) return { ok: false, error: 'no pending sign-in' };
    deliverToPage(row, { ok: false, error: m.error === 'rejected' ? 'rejected' : 'cancelled' });
    return { ok: true };
  }
  const row = await peekPending(key, requestId);
  if (!row) return { ok: false, error: 'no pending sign-in' };
  const verified = verifyPageAssertion(m.assertion, { ...expectationsFor(row), signers: [PASSPORT_SIGNER] });
  if (!verified.ok) return verified;
  if (Date.now() >= row.expiresAt) {
    await takePending(row.key, row.requestId);
    deliverToPage(row, { ok: false, error: 'expired' });
    return { ok: false, error: 'the sign-in expired' };
  }
  if (!(await takePending(row.key, row.requestId))) return { ok: false, error: 'no pending sign-in' };
  deliverToPage(row, { ok: true, assertion: String(m.assertion) });
  return { ok: true };
}

/**
 * Popup asked a linked signer to answer a pending sign-in: a
 * `DELEGATION_REQUEST` carrying the site's challenge goes to it (loopback or
 * a Hub mailbox). Runs here so the answer still reaches the page after the
 * popup closes. The assertion must be signed by that signer's key and name
 * this Passport as `device`.
 * @param m `{ key, requestId, target, disclose }`
 */
export async function completeWithDelegate (m: Record<string, unknown>): Promise<{ ok: true } | Fail> {
  const key = typeof m.key === 'string' ? m.key : '';
  const requestId = typeof m.requestId === 'string' ? m.requestId : undefined;
  const target = typeof m.target === 'string' ? m.target.toLowerCase() : '';
  if (!/^0[23][0-9a-f]{64}$/.test(target)) return { ok: false, error: 'choose a linked signer' };
  const row = await peekPending(key, requestId);
  if (!row) return { ok: false, error: 'no pending sign-in' };
  const disclose = (Array.isArray(m.disclose) ? m.disclose : []).map(String)
    .filter((d): d is PassportDisclosure => row.request.includes(d as PassportDisclosure));

  const answered = await signInThrough({ target, challenge: row.challenge, origin: row.origin, disclose, expiresAt: row.expiresAt });
  if (!answered.ok) return answered;
  if (answered.signer.network && row.network && answered.signer.network !== row.network) {
    return { ok: false, error: `${answered.signer.name} signs on ${answered.signer.network}` };
  }
  const verified = verifyPageAssertion(answered.assertion, {
    ...expectationsFor(row),
    allow: disclose,
    signers: [...DESKTOP_SIGNERS, PASSPORT_SIGNER],
    pubkey: target,
    device: answered.device
  });
  if (!verified.ok) return verified;
  const taken = await takePending(row.key, row.requestId);
  if (!taken) return { ok: false, error: 'no pending sign-in' };
  if (Date.now() >= row.expiresAt) {
    deliverToPage(row, { ok: false, error: 'expired' });
    return { ok: false, error: 'the sign-in expired' };
  }
  deliverToPage(row, { ok: true, assertion: answered.assertion });
  return { ok: true };
}

/** Drop a closed tab's sign-ins (its ports are gone). */
export async function dropTabPending (tabId: number): Promise<void> {
  await serialized(async () => {
    const rows = await readPendingPassport();
    const next = rows.filter((r) => r.tabId !== tabId);
    if (next.length !== rows.length) await writePendingPassport(next);
  });
}
