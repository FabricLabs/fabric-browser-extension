'use strict';

/**
 * Passport's side of delegation (`@fabric/core` `types/delegation`): its own
 * `Delegation` keyed with the unlocked account's identity key, on the
 * encrypted datastore (collection `delegation:<pubkey>`, every record sealed
 * with an HMAC keyed from the master, so nothing else that can write
 * extension storage can add a grant or a linked signer).
 *
 * - Pairing: with an app on this computer (Fabric Hub, GoonCitizen) over its
 *   loopback `/services/delegation/links`, or with anyone through a trusted
 *   Hub's `/delegations` rendezvous (Passport shows or reads an invitation).
 *   The code shows only after the reveal; the user confirms it and picks what
 *   to grant.
 * - Requests for this Passport arrive in the mailboxes of its linked signers
 *   (their loopback base or Hub) and the active Fabric node. Each becomes a
 *   `notification:DelegationRequest:<hash>` record, a toast with Sign and
 *   Decline, and the badge. Nothing is signed until the user presses Sign in
 *   a Passport page; no popup opens on its own.
 * - Passport asks a linked signer to sign (a site sign-in, a shared-wallet
 *   invite) with a `DELEGATION_REQUEST`, over loopback or through a mailbox,
 *   and checks the result it gets back.
 */

import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import {
  DELEGATION_ALARM,
  DELEGATION_FOCUS_SESSION_KEY,
  DELEGATION_NOTIFICATION_PREFIX,
  DELEGATION_PAIRING_SESSION_KEY,
  SIGN_IN_NOTIFICATION_PREFIX
} from '../constants/delegation';
import { FABRIC_PENDING_PASSPORT_KEY } from '../constants/siteLogin';
import { FABRIC_PENDING_PAYMENTS_KEY, PAYMENT_NOTIFICATION_PREFIX } from '../constants/fabric402';
import { DELEGATION_REQUEST } from '../fabric/messageTypes';
import { fabricDsGet, fabricDsListPrefix, fabricDsRemove, fabricDsSet } from './encryptedDatastore';
import {
  cancelLink,
  delegateRefusalError,
  discoverDelegates,
  fetchMailbox,
  normalizeDelegateBase,
  openLink,
  postDelegateLink,
  postDelegateRequest,
  postLinkFrame,
  postMailbox,
  readDelegateRequest,
  readLink,
  type CallResult,
  type LocalDelegate
} from '../utils/delegationClient';
import { isAllowedFabricHub, loadFabricHubGateOptions, normalizeHubOrigin } from '../utils/fabricHubAllowlist';
import { deriveAccountKeys } from '../utils/fabricSiteMessage';
import { isAccountVault, recallMaster, pairKey, type AccountPair, type AccountVault } from '../utils/passportVault';
import { privateGet } from '../utils/privateStore';
import { openRecord, recordMacKey, sealRecord } from '../utils/recordSeal';
import { swallowNonFatal } from '../utils/nonFatal';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dcore = require('../utils/loadFabricDelegation');

export const LOCKED_ERROR = 'Unlock Passport first.';
export const PASSPORT_LABEL = 'Passport';
/** Frames kept in Passport's delegation store. */
const MAX_FRAMES = 400;
/** How long a pairing waits for the other side. */
const PAIRING_WAIT_MS = 10 * 60 * 1000;
const POLL_EVERY_MS = 1500;

/** A participant this Passport paired with. */
export type LinkedSigner = {
  pubkey: string;
  name: string;
  /** `hub` | `gooncitizen` for apps on this computer, `passport` or null otherwise. */
  signer: string | null;
  network: string | null;
  via: 'local' | 'hub';
  /** Loopback base of an app on this computer. */
  base: string | null;
  /** Hub whose rendezvous and mailbox carry frames to and from it. */
  hub: string | null;
  linkedAt: number;
};

export type GrantView = {
  hash: string;
  scopes: string[];
  label: string;
  issuedAt: number;
  cosigner: string | null;
  revoked: boolean;
};

export type PendingView = {
  hash: string;
  title: string;
  summary: string;
  scope: string;
  from: { pubkey: string; label: string };
  expiresAt: number;
  receivedAt: number;
  /** Passport sign-ins: the site and what it asks to see. */
  origin: string | null;
  disclose: string[];
  network: string | null;
  /** The frame to sign (`fabric:`), for the prompt to show or answer. */
  inner: string;
  innerType: string;
};

export type PairingView = {
  id: string;
  mode: 'local' | 'offer' | 'invitation';
  status: 'starting' | 'waiting' | 'confirm' | 'granting' | 'done' | 'failed' | 'cancelled';
  invitation: string | null;
  rendezvous: string | null;
  base: string | null;
  peerName: string | null;
  peerPubkey: string | null;
  /** Six digits, shown only once both nonces are known. */
  sas: string | null;
  /** The app on this computer confirmed the code too. */
  remoteConfirmed: boolean;
  localConfirmed: boolean;
  scopes: string[];
  error: string | null;
  expiresAt: number;
};

type Me = {
  d: any;
  pubkey: string;
  pair: AccountPair;
  keys: any;
  mac: CryptoKey;
  vault: AccountVault;
};

let cached: { tag: string; me: Me } | null = null;

export function delegationAvailable (): boolean {
  return !!(dcore && dcore.Delegation && dcore.delegation);
}

/** `123456` as `123 456`. */
export function formatSas (sas: string | null | undefined): string | null {
  const s = String(sas || '');
  return /^\d{6}$/.test(s) ? `${s.slice(0, 3)} ${s.slice(3)}` : null;
}

/** This extension's origin, as grants to a local app name it. */
export function extensionOrigin (): string {
  return chrome.runtime.getURL('').replace(/\/$/, '');
}

async function readVault (): Promise<AccountVault | null> {
  const state = await privateGet(FABRIC_STATE_STORAGE_KEY);
  const vault = state && typeof state === 'object' ? (state as { vault?: unknown }).vault : null;
  return isAccountVault(vault) ? vault : null;
}

function sealedStore (mac: CryptoKey) {
  return {
    async get (key: string): Promise<unknown> {
      const raw = await fabricDsGet(key);
      if (raw == null) return null;
      const data = await openRecord<string>(mac, key, raw);
      if (data == null) console.warn('[FABRIC:DELEGATION] dropped a record whose seal does not check:', key);
      return data;
    },
    async set (key: string, value: unknown): Promise<void> {
      await fabricDsSet(key, await sealRecord(mac, key, value));
    }
  };
}

/** The unlocked account's participant; throws while locked. */
export async function me (): Promise<Me> {
  if (!delegationAvailable()) throw new Error('Linked signers are unavailable in this build');
  const vault = await readVault();
  if (!vault) throw new Error('Create or restore an identity first.');
  const master = await recallMaster(vault);
  if (!master) throw new Error(LOCKED_ERROR);
  const pair = { account: vault.current.account, network: vault.current.network };
  const tag = `${pairKey(pair)}\n${master}`;
  if (cached && cached.tag === tag) return { ...cached.me, vault };
  const keys = deriveAccountKeys(master, pair);
  const mac = await recordMacKey(master);
  const pubkey = String(keys.identity.pubkey).toLowerCase();
  const d = new dcore.Delegation({
    key: keys.identity.key,
    store: sealedStore(mac),
    collection: `delegation:${pubkey}`,
    maxFrames: MAX_FRAMES,
    networkOf: () => pair.network
  });
  await d.load();
  const out = { d, pubkey, pair, keys, mac, vault };
  cached = { tag, me: out };
  return out;
}

/** Drop the cached participant (on lock or account switch). */
export function forgetParticipant (): void {
  cached = null;
}

// Linked signers

function signersKey (pubkey: string): string {
  return `delegates:${pubkey}`;
}

export async function readSigners (who: Me): Promise<LinkedSigner[]> {
  const name = signersKey(who.pubkey);
  const raw = await fabricDsGet(name);
  if (raw == null) return [];
  const list = await openRecord<LinkedSigner[]>(who.mac, name, raw);
  return Array.isArray(list) ? list : [];
}

async function writeSigners (who: Me, list: LinkedSigner[]): Promise<void> {
  const name = signersKey(who.pubkey);
  await fabricDsSet(name, await sealRecord(who.mac, name, list));
}

async function saveSigner (who: Me, entry: LinkedSigner): Promise<void> {
  const x = entry.pubkey.slice(2);
  const next = (await readSigners(who)).filter((s) => s.pubkey.slice(2) !== x);
  next.push(entry);
  await writeSigners(who, next);
}

async function signerFor (who: Me, pubkey: string): Promise<LinkedSigner | null> {
  const x = String(pubkey || '').toLowerCase().slice(-64);
  return (await readSigners(who)).find((s) => s.pubkey.slice(2) === x) || null;
}

function grantView (g: any): GrantView {
  return {
    hash: g.hash,
    scopes: g.grant.scopes,
    label: g.grant.label || '',
    issuedAt: g.grant.issuedAt,
    cosigner: g.grant.cosigner || null,
    revoked: !!g.revoked
  };
}

// Pending requests

function innerUri (read: any): string {
  return dcore.fabricUri.encodeFabricUri(read.inner.buffer);
}

export function pendingView (item: { hash: string; read: any; notification: any; receivedAt: number }): PendingView {
  const read = item.read;
  return {
    hash: item.hash,
    title: item.notification.title,
    summary: item.notification.summary,
    scope: read.scope,
    from: item.notification.from,
    expiresAt: read.request.expiresAt,
    receivedAt: item.receivedAt,
    origin: read.request.origin || null,
    disclose: read.request.disclose || [],
    network: read.inner.network || null,
    inner: innerUri(read),
    innerType: read.inner.type
  };
}

/**
 * Requests still waiting, at most one per requester (the newest): older ones
 * from the same requester are answered `superseded` (P-06).
 */
export function latestPerRequester<T extends { hash: string; receivedAt: number; from: { pubkey: string } }> (items: T[]): { keep: T[]; superseded: T[] } {
  const newest = new Map<string, T>();
  for (const item of items) {
    const x = String(item.from.pubkey).slice(-64);
    const cur = newest.get(x);
    if (!cur || item.receivedAt > cur.receivedAt) newest.set(x, item);
  }
  const keep = [...newest.values()];
  return { keep, superseded: items.filter((i) => !keep.includes(i)) };
}

// Notifications

function notificationKey (hash: string): string {
  return `notification:${DELEGATION_REQUEST}:${hash}`;
}

/** Badge = signature requests, site sign-ins, and payment requests still waiting for the user. */
export async function refreshBadge (): Promise<void> {
  try {
    const rows = await fabricDsListPrefix<{ payload?: { status?: string; expiresAt?: number } }>(`notification:${DELEGATION_REQUEST}:`, 200);
    const now = Date.now();
    let open = rows.filter((r) => r.value && r.value.payload && r.value.payload.status === 'pending' && Number(r.value.payload.expiresAt) > now).length;
    if (chrome.storage.session) {
      const got = await chrome.storage.session.get(FABRIC_PENDING_PASSPORT_KEY);
      const signIns = got && Array.isArray(got[FABRIC_PENDING_PASSPORT_KEY]) ? got[FABRIC_PENDING_PASSPORT_KEY] : [];
      open += signIns.filter((r: { expiresAt?: number }) => Number(r && r.expiresAt) > now).length;
      const pays = await chrome.storage.session.get(FABRIC_PENDING_PAYMENTS_KEY);
      const payments = pays && Array.isArray(pays[FABRIC_PENDING_PAYMENTS_KEY]) ? pays[FABRIC_PENDING_PAYMENTS_KEY] : [];
      open += payments.filter((r: { expiresAt?: number }) => Number(r && r.expiresAt) > now).length;
    }
    await chrome.action.setBadgeBackgroundColor({ color: '#b03060' });
    await chrome.action.setBadgeText({ text: open ? String(Math.min(open, 99)) : '' });
  } catch (err: unknown) {
    swallowNonFatal('delegation-badge', err);
  }
}

async function recordRequest (view: PendingView, hub: string | null): Promise<void> {
  await fabricDsSet(notificationKey(view.hash), {
    messageType: DELEGATION_REQUEST,
    nodeAddress: view.from.label || hub || 'a linked signer',
    receivedAt: view.receivedAt,
    hub,
    payload: {
      note: `${view.title}${view.summary ? ` — ${view.summary}` : ''}`,
      title: view.title,
      summary: view.summary,
      scope: view.scope,
      from: view.from,
      request: view.hash,
      expiresAt: view.expiresAt,
      status: 'pending'
    }
  });
  try {
    const options: chrome.notifications.NotificationCreateOptions = {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: view.title,
      message: view.summary || `${view.from.label} asks you to sign.`,
      priority: 2,
      requireInteraction: true
    };
    // Firefox has no notification buttons; a click opens the prompt there.
    if (!/Firefox\//.test(typeof navigator !== 'undefined' ? navigator.userAgent : '')) {
      options.buttons = [{ title: 'Review and sign' }, { title: 'Decline' }];
    }
    chrome.notifications.create(`${DELEGATION_NOTIFICATION_PREFIX}${view.hash}`, options);
  } catch (err: unknown) {
    swallowNonFatal('delegation-notify', err);
  }
  await refreshBadge();
}

async function settleRecord (hash: string, status: 'signed' | 'declined' | 'superseded' | 'expired'): Promise<void> {
  const key = notificationKey(hash);
  const cur = await fabricDsGet<{ payload?: Record<string, unknown> }>(key);
  if (cur && cur.payload) {
    cur.payload.status = status;
    await fabricDsSet(key, cur);
  }
  try {
    chrome.notifications.clear(`${DELEGATION_NOTIFICATION_PREFIX}${hash}`);
  } catch (err: unknown) {
    swallowNonFatal('delegation-notify-clear', err);
  }
  await refreshBadge();
}

async function requestHub (hash: string): Promise<string | null> {
  const cur = await fabricDsGet<{ hub?: string | null }>(notificationKey(hash));
  return cur && typeof cur.hub === 'string' ? cur.hub : null;
}

/** Open the prompt for a request in a popup window (only after a user click). */
export async function openRequestPrompt (hash: string | null): Promise<void> {
  if (chrome.storage.session) await chrome.storage.session.set({ [DELEGATION_FOCUS_SESSION_KEY]: hash || null });
  await chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 420, height: 680, focused: true });
}

// Mailboxes

/** Where frames for this Passport may wait: each linked signer's base or Hub, and the active node. */
export function mailboxOrigins (signers: LinkedSigner[], activeHub: string | null, allowed: (origin: string) => boolean): string[] {
  const out: string[] = [];
  const add = (o: string | null) => {
    const n = o ? normalizeHubOrigin(o) : null;
    if (n && !out.includes(n)) out.push(n);
  };
  for (const s of signers) {
    if (s.via === 'local' && s.base && normalizeDelegateBase(s.base)) add(s.base);
    if (s.via === 'hub' && s.hub && allowed(s.hub)) add(s.hub);
  }
  if (activeHub && allowed(activeHub)) add(activeHub);
  return out;
}

async function allowedHubCheck (): Promise<{ allowed: (o: string) => boolean; activeHub: string | null }> {
  const gate = await loadFabricHubGateOptions();
  return { allowed: (o: string) => isAllowedFabricHub(o, gate), activeHub: gate.activeHub || null };
}

function cursorKey (who: Me, origin: string): string {
  return `delegation-cursor:${who.pubkey}:${origin}`;
}

async function pollMailbox (who: Me, origin: string): Promise<number> {
  const since = Number(await fabricDsGet<number>(cursorKey(who, origin))) || 0;
  const proof = dcore.delegation.createMailboxFetch({ since }, who.keys.identity.key);
  const out = await fetchMailbox(origin, proof.uri);
  if (!out.ok) return 0;
  const frames = Array.isArray(out.frames) ? out.frames as Array<{ frame: string; seq: number }> : [];
  let taken = 0;
  for (const f of frames) {
    if (!f || typeof f.frame !== 'string') continue;
    try {
      const got = await who.d.receive(f.frame);
      if (got && got.ok) {
        taken++;
        if (got.type === 'DELEGATION_REQUEST' && !got.duplicate) await onRequest(who, got.hash, origin);
      }
    } catch (err: unknown) {
      swallowNonFatal('delegation-mailbox-frame', err);
    }
  }
  const next = Number(out.next);
  if (Number.isFinite(next) && next > since) await fabricDsSet(cursorKey(who, origin), next);
  return taken;
}

/** Collect frames for this Passport from every mailbox it uses. Quiet while locked. */
export async function pollMailboxes (): Promise<{ ok: boolean; taken: number; error?: string }> {
  let who: Me;
  try {
    who = await me();
  } catch (err: unknown) {
    return { ok: false, taken: 0, error: err instanceof Error ? err.message : String(err) };
  }
  const { allowed, activeHub } = await allowedHubCheck();
  const origins = mailboxOrigins(await readSigners(who), activeHub, allowed);
  let taken = 0;
  for (const origin of origins) {
    try {
      taken += await pollMailbox(who, origin);
    } catch (err: unknown) {
      swallowNonFatal('delegation-mailbox', err);
    }
  }
  await expirePending(who);
  return { ok: true, taken };
}

async function deliverResult (who: Me, hash: string, result: { uri: string }, requester: string): Promise<void> {
  const hub = await requestHub(hash);
  if (!hub) return;
  const posted = await postMailbox(hub, result.uri, { to: requester });
  if (!posted.ok) console.warn('[FABRIC:DELEGATION] result not delivered:', posted.error || posted.httpStatus);
}

async function onRequest (who: Me, hash: string, hub: string): Promise<void> {
  const pending = (await who.d.pending()).map(pendingView);
  const view = pending.find((p: PendingView) => p.hash === hash);
  if (!view) return;
  await recordRequest(view, hub);
  const { superseded } = latestPerRequester(pending);
  for (const old of superseded) {
    try {
      const declined = await who.d.decline(old.hash, 'superseded by a newer request');
      await deliverResult(who, old.hash, declined, old.from.pubkey);
      await settleRecord(old.hash, 'superseded');
    } catch (err: unknown) {
      swallowNonFatal('delegation-supersede', err);
    }
  }
}

async function expirePending (who: Me): Promise<void> {
  const now = Date.now();
  for (const item of await who.d.pending()) {
    if (item.read.request.expiresAt > now) continue;
    try {
      await who.d.decline(item.hash, 'expired');
      await settleRecord(item.hash, 'expired');
    } catch (err: unknown) {
      swallowNonFatal('delegation-expire', err);
    }
  }
}

// Answering

/**
 * The user answered a request in a Passport page. Passport and message
 * requests are signed here; federation answers come signed by the page's
 * federation member (the cosigner key) as `frame`.
 */
export async function answerRequest (params: { hash: string; action: string; frame?: string | null }): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const who = await me();
  const item = await who.d.inboxItem(params.hash);
  if (!item || !item.read || !item.read.ok) return { ok: false, error: 'unknown request' };
  if (item.status !== 'pending') return { ok: false, error: `this request is already ${item.status}` };
  const read = item.read;
  let made: { uri: string; hash: string };
  if (params.action === 'decline') {
    made = await who.d.decline(item.hash, 'declined');
  } else if (params.action === 'sign') {
    if (Date.now() >= read.request.expiresAt) {
      made = await who.d.decline(item.hash, 'expired');
      await deliverResult(who, item.hash, made, read.request.requester);
      await settleRecord(item.hash, 'expired');
      return { ok: false, error: 'this request expired' };
    }
    const answer = buildAnswer(who, read, params.frame || null);
    if ('error' in answer) return { ok: false, error: answer.error };
    made = await who.d.sign(item.hash, answer.frame);
  } else {
    return { ok: false, error: 'answer with sign or decline' };
  }
  await deliverResult(who, item.hash, made, read.request.requester);
  await settleRecord(item.hash, params.action === 'sign' ? 'signed' : 'declined');
  return { ok: true, status: params.action === 'sign' ? 'signed' : 'declined' };
}

function buildAnswer (who: Me, read: any, frame: string | null): { frame: unknown } | { error: string } {
  if (read.scope === 'passport') {
    const network = read.inner.network || who.pair.network;
    if (network !== who.pair.network) return { error: `this Passport account signs on ${who.pair.network}; switch to ${network} to answer` };
    if (read.request.account !== who.pair.account) return { error: `the request is for account ${read.request.account}; switch to it to answer` };
    const signed = dcore.delegation.answerPassport(read, {
      signer: PASSPORT_LABEL.toLowerCase(),
      network,
      wallet: read.request.disclose.includes('wallet') ? who.keys.wallet : undefined,
      cosignerKey: read.request.disclose.includes('cosigner') ? who.keys.cosigner.key : undefined
    }, who.keys.identity.key);
    return { frame: signed.uri };
  }
  if (read.scope === 'message') return { frame: dcore.delegation.answerMessage(read, who.keys.identity.key) };
  if (read.scope === 'federation') {
    if (!frame) return { error: 'open the shared wallet to answer this request' };
    return { frame };
  }
  return { error: `${read.scope} requests are not answered here` };
}

// Asking a linked signer

async function sendRequest (who: Me, signer: LinkedSigner, uri: string): Promise<CallResult> {
  if (signer.via === 'local' && signer.base) return postDelegateRequest(signer.base, uri);
  if (signer.hub) {
    const { allowed } = await allowedHubCheck();
    if (!allowed(signer.hub)) return { ok: false, httpStatus: 0, error: `${signer.hub} is no longer a trusted Hub` };
    return postMailbox(signer.hub, uri);
  }
  return { ok: false, httpStatus: 0, error: 'no way to reach that signer' };
}

/** Feed a result a loopback app returned inline into Passport's store. */
async function takeInlineResult (who: Me, out: CallResult): Promise<void> {
  if (typeof out.result === 'string' && out.result) {
    const got = await who.d.receive(out.result);
    if (!got.ok) throw new Error(`the answer does not check: ${got.error}`);
  }
}

/**
 * Wait for the result of a request: a loopback app is asked again, a Hub
 * mailbox is read, until the request expires.
 */
async function waitForResult (who: Me, signer: LinkedSigner, hash: string, expiresAt: number, cancelled: () => boolean = () => false): Promise<any> {
  while (Date.now() < expiresAt && !cancelled()) {
    const item = await who.d.outboxItem(hash);
    if (item && item.status !== 'sent') return item;
    if (signer.via === 'local' && signer.base) {
      const out = await readDelegateRequest(signer.base, hash);
      if (out.ok && out.status !== 'pending') await takeInlineResult(who, out);
    } else if (signer.hub) {
      await pollMailbox(who, normalizeHubOrigin(signer.hub) || signer.hub);
    }
    await new Promise((resolve) => setTimeout(resolve, signer.via === 'local' ? POLL_EVERY_MS : POLL_EVERY_MS * 2));
  }
  return who.d.outboxItem(hash);
}

/**
 * Ask a linked signer to sign `request` (a `fabric:` frame) under the grant it
 * made to this Passport. Returns once the request is delivered; the result
 * arrives later (or inline from an app on this computer).
 */
export async function ask (params: { target: string; request: string; purpose?: string }): Promise<{ ok: true; hash: string; status: string } | { ok: false; error: string }> {
  const who = await me();
  const signer = await signerFor(who, params.target);
  if (!signer) return { ok: false, error: 'that signer is not linked to this Passport' };
  const made = await who.d.request({ target: signer.pubkey, request: params.request, purpose: params.purpose });
  const out = await sendRequest(who, signer, made.uri);
  if (!out.ok && out.httpStatus !== 202) return { ok: false, error: delegateRefusalError(out.httpStatus, out.error) };
  await takeInlineResult(who, out);
  const item = await who.d.outboxItem(made.hash);
  return { ok: true, hash: made.hash, status: item ? item.status : 'sent' };
}

/**
 * Ask a linked signer to answer a site's `PASSPORT_CHALLENGE` for this
 * Passport. Resolves with the assertion it signed (still to be verified
 * against the pending sign-in) or the reason it did not.
 */
export async function signInThrough (params: {
  target: string;
  challenge: string;
  origin: string;
  disclose: string[];
  expiresAt: number;
}): Promise<{ ok: true; assertion: string; signer: LinkedSigner; device: string } | { ok: false; error: string }> {
  const who = await me();
  const signer = await signerFor(who, params.target);
  if (!signer) return { ok: false, error: 'that signer is not linked to this Passport' };
  let made: { uri: string; hash: string; expiresAt: number };
  try {
    made = await who.d.request({ target: signer.pubkey, request: params.challenge, origin: params.origin, disclose: params.disclose });
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const out = await sendRequest(who, signer, made.uri);
  if (!out.ok && out.httpStatus !== 202) return { ok: false, error: delegateRefusalError(out.httpStatus, out.error) };
  await takeInlineResult(who, out);
  const item = await waitForResult(who, signer, made.hash, Math.min(made.expiresAt, params.expiresAt));
  if (!item || item.status === 'sent') return { ok: false, error: `${signer.name} did not answer in time` };
  if (item.status !== 'signed' || !item.result || !item.result.answer) {
    return { ok: false, error: item.result && item.result.refusal ? `${signer.name} declined: ${item.result.refusal}` : `${signer.name} declined` };
  }
  return { ok: true, assertion: item.result.answer.uri, signer, device: who.pubkey };
}

// Grants

/** Withdraw a grant and tell its holder (loopback, or its Hub's mailbox). */
export async function revokeGrant (hash: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const who = await me();
  const given = await who.d.grants('given');
  const found = given.find((g: any) => g.hash === String(hash || '').toLowerCase());
  if (!found) return { ok: false, error: 'no such grant from this Passport' };
  const made = await who.d.revoke(found.hash);
  const signer = await signerFor(who, found.grant.grantee);
  if (signer && signer.via === 'local' && signer.base) {
    await postDelegateLink(signer.base, made.uri, { timeoutMs: 10000 });
  } else if (signer && signer.hub) {
    await postMailbox(signer.hub, made.uri, { to: found.grant.grantee });
  }
  return { ok: true };
}

/** Revoke every grant a signer holds from this Passport and forget it. */
export async function forgetSigner (pubkey: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const who = await me();
  const x = String(pubkey || '').toLowerCase().slice(-64);
  for (const g of await who.d.grants('given')) {
    if (g.grant.grantee.slice(2) === x) await revokeGrant(g.hash);
  }
  await writeSigners(who, (await readSigners(who)).filter((s) => s.pubkey.slice(2) !== x));
  return { ok: true };
}

// State for Passport's pages

export async function delegationState (): Promise<Record<string, unknown>> {
  if (!delegationAvailable()) return { ok: true, available: false };
  let who: Me;
  try {
    who = await me();
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: true, available: true, locked: message === LOCKED_ERROR, error: message === LOCKED_ERROR ? null : message, pairing: pairingView() };
  }
  const given = (await who.d.grants('given', { revoked: true })).map(grantView);
  const givenRaw = await who.d.grants('given', { revoked: true });
  const received = await who.d.grants('received', { revoked: true });
  const signers = (await readSigners(who)).map((s) => {
    const x = s.pubkey.slice(2);
    return {
      ...s,
      given: givenRaw.filter((g: any) => g.grant.grantee.slice(2) === x).map(grantView),
      received: received.filter((g: any) => g.grant.grantor.slice(2) === x).map(grantView)
    };
  });
  const pending = (await who.d.pending()).map(pendingView).filter((p: PendingView) => p.expiresAt > Date.now());
  let focus: string | null = null;
  if (chrome.storage.session) {
    const got = await chrome.storage.session.get(DELEGATION_FOCUS_SESSION_KEY);
    focus = typeof got[DELEGATION_FOCUS_SESSION_KEY] === 'string' ? got[DELEGATION_FOCUS_SESSION_KEY] : null;
    if (focus) await chrome.storage.session.remove(DELEGATION_FOCUS_SESSION_KEY);
  }
  return {
    ok: true,
    available: true,
    locked: false,
    pubkey: who.pubkey,
    network: who.pair.network,
    account: who.pair.account,
    signers,
    given,
    identityPeers: await who.d.identityPeers(),
    pending,
    focus,
    pairing: pairingView()
  };
}

export async function discover (): Promise<{ ok: true; delegates: LocalDelegate[] } | { ok: false; error: string }> {
  const who = await me();
  return { ok: true, delegates: await discoverDelegates({ pubkey: who.pubkey }) };
}

// Pairing

type Pairing = PairingView & {
  linkId: string | null;
  revealHash: string | null;
  peerLabel: string;
  signer: string | null;
  network: string | null;
  token: number;
};

let pairing: Pairing | null = null;
let pairingToken = 0;

export function pairingView (): PairingView | null {
  if (!pairing) return null;
  const { linkId: _l, revealHash: _r, peerLabel: _p, signer: _s, network: _n, token: _t, ...view } = pairing;
  void _l; void _r; void _p; void _s; void _n; void _t;
  return { ...view, sas: formatSas(view.sas) };
}

async function mirror (): Promise<void> {
  try {
    if (chrome.storage.session) await chrome.storage.session.set({ [DELEGATION_PAIRING_SESSION_KEY]: pairingView() });
  } catch (err: unknown) {
    swallowNonFatal('delegation-pairing-mirror', err);
  }
}

function update (token: number, patch: Partial<Pairing>): boolean {
  if (!pairing || pairing.token !== token) return false;
  if (pairing.status === 'cancelled') return false;
  Object.assign(pairing, patch);
  void mirror();
  return true;
}

function fail (token: number, error: unknown): void {
  update(token, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
}

function live (token: number): boolean {
  return !!pairing && pairing.token === token && !['failed', 'cancelled', 'done'].includes(pairing.status);
}

function begin (mode: Pairing['mode'], patch: Partial<Pairing>): number {
  const token = ++pairingToken;
  pairing = {
    id: `${Date.now().toString(36)}${token}`,
    mode,
    status: 'starting',
    invitation: null,
    rendezvous: null,
    base: null,
    peerName: null,
    peerPubkey: null,
    sas: null,
    remoteConfirmed: false,
    localConfirmed: false,
    scopes: [],
    error: null,
    expiresAt: Date.now() + PAIRING_WAIT_MS,
    linkId: null,
    revealHash: null,
    peerLabel: '',
    signer: null,
    network: null,
    token,
    ...patch
  };
  void mirror();
  return token;
}

async function sleep (ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pair with an app on this computer. */
export async function pairLocal (baseRaw: string): Promise<{ ok: true; pairing: PairingView | null } | { ok: false; error: string }> {
  const base = normalizeDelegateBase(baseRaw);
  if (!base) return { ok: false, error: 'apps on this computer answer on localhost only' };
  const who = await me();
  const found = (await discoverDelegates({ bases: [base], pubkey: who.pubkey }))[0];
  if (!found) return { ok: false, error: `nothing answers at ${base}; start Fabric Hub or GoonCitizen and try again` };
  if (found.locked) return { ok: false, error: `${found.name || found.signer} is locked; unlock it first` };
  const token = begin('local', { base, peerName: found.name || found.signer, peerPubkey: found.pubkey, signer: found.signer, network: found.network });
  void runLocal(who, token, found).catch((err) => fail(token, err));
  return { ok: true, pairing: pairingView() };
}

async function runLocal (who: Me, token: number, found: LocalDelegate): Promise<void> {
  const offer = await who.d.offer({ origin: found.base, label: PASSPORT_LABEL, network: who.pair.network });
  update(token, { linkId: offer.linkId });
  const answered = await postDelegateLink(found.base, offer.uri, { timeoutMs: 20000 });
  if (!answered.ok || typeof answered.frame !== 'string') throw new Error(delegateRefusalError(answered.httpStatus, answered.error));
  const got = await who.d.receive(answered.frame);
  if (!got.ok) throw new Error(got.error);
  if (got.peerPubkey !== found.pubkey) throw new Error('the answer came from a different key than the app named; nothing was linked');
  const link = (await who.d.links()).find((l: any) => l.linkId === got.linkId);
  if (!update(token, { status: 'confirm', sas: got.sas, revealHash: link ? link.revealHash : null, peerLabel: got.peerLabel || found.name || found.signer })) return;
  // The app asks its own user to match the code while this one does.
  const confirmed = await postDelegateLink(found.base, got.reveal, { timeoutMs: 150000 });
  if (!live(token)) return;
  if (!confirmed.ok || confirmed.confirmed !== true) {
    throw new Error(confirmed.declined ? `${found.name || found.signer} did not confirm the code` : delegateRefusalError(confirmed.httpStatus, confirmed.error));
  }
  update(token, { remoteConfirmed: true });
  await finishWhenConfirmed(who, token);
}

/** Pair through a Hub: show an invitation and wait for the other side. */
export async function pairHub (hubRaw: string): Promise<{ ok: true; pairing: PairingView | null } | { ok: false; error: string }> {
  const hub = normalizeHubOrigin(String(hubRaw || ''));
  const { allowed } = await allowedHubCheck();
  if (!hub || !allowed(hub)) return { ok: false, error: 'choose one of your trusted Hubs' };
  const who = await me();
  const offer = await who.d.offer({ origin: hub, label: PASSPORT_LABEL, network: who.pair.network });
  const opened = await openLink(hub, offer.uri);
  if (!opened.ok) return { ok: false, error: delegateRefusalError(opened.httpStatus, opened.error) };
  const token = begin('offer', { rendezvous: hub, invitation: offer.uri, linkId: offer.linkId, status: 'waiting', expiresAt: Number(opened.expiresAt) || Date.now() + PAIRING_WAIT_MS });
  void runOffer(who, token, hub, offer.linkId).catch((err) => fail(token, err));
  return { ok: true, pairing: pairingView() };
}

async function waitForFrames (token: number, hub: string, linkId: string, count: number): Promise<string[] | null> {
  while (live(token) && Date.now() < (pairing ? pairing.expiresAt : 0)) {
    const out = await readLink(hub, linkId);
    if (!out.ok) throw new Error(out.httpStatus === 404 ? 'the pairing ended on the Hub' : delegateRefusalError(out.httpStatus, out.error));
    const frames = Array.isArray(out.frames) ? out.frames as string[] : [];
    if (frames.length > count) return frames;
    await sleep(POLL_EVERY_MS);
  }
  if (live(token)) throw new Error('the other side did not answer in time');
  return null;
}

async function runOffer (who: Me, token: number, hub: string, linkId: string): Promise<void> {
  const frames = await waitForFrames(token, hub, linkId, 1);
  if (!frames) return;
  const got = await who.d.receive(frames[1]);
  if (!got.ok) throw new Error(got.error);
  const posted = await postLinkFrame(hub, linkId, got.reveal);
  if (!posted.ok) throw new Error(delegateRefusalError(posted.httpStatus, posted.error));
  const links = await who.d.links();
  const link = links.find((l: any) => l.linkId === got.linkId);
  update(token, {
    status: 'confirm',
    sas: got.sas,
    peerPubkey: got.peerPubkey,
    peerLabel: got.peerLabel || '',
    peerName: got.peerLabel || null,
    revealHash: link ? link.revealHash : null,
    remoteConfirmed: true
  });
}

/** Pair from an invitation another participant shows. */
export async function pairInvitation (invitation: string): Promise<{ ok: true; pairing: PairingView | null } | { ok: false; error: string }> {
  const read = dcore.delegation.readLinkOffer(String(invitation || '').trim());
  if (!read.ok) return { ok: false, error: `not an invitation: ${read.error}` };
  const hub = normalizeHubOrigin(read.offer.origin);
  const { allowed } = await allowedHubCheck();
  if (!hub || !allowed(hub)) return { ok: false, error: `the invitation uses ${read.offer.origin}, which is not one of your trusted Hubs` };
  const who = await me();
  if (read.pubkey.slice(2) === who.pubkey.slice(2)) return { ok: false, error: 'this invitation came from this Passport' };
  const made = await who.d.answer(invitation.trim(), { label: PASSPORT_LABEL });
  const posted = await postLinkFrame(hub, made.linkId, made.uri);
  if (!posted.ok) return { ok: false, error: delegateRefusalError(posted.httpStatus, posted.error) };
  const token = begin('invitation', {
    rendezvous: hub,
    linkId: made.linkId,
    status: 'waiting',
    peerPubkey: made.peerPubkey,
    peerLabel: read.offer.label || '',
    peerName: read.offer.label || null,
    remoteConfirmed: true
  });
  void runInvitation(who, token, hub, made.linkId).catch((err) => fail(token, err));
  return { ok: true, pairing: pairingView() };
}

async function runInvitation (who: Me, token: number, hub: string, linkId: string): Promise<void> {
  const frames = await waitForFrames(token, hub, linkId, 2);
  if (!frames) return;
  const got = await who.d.receive(frames[2]);
  if (!got.ok) throw new Error(got.error);
  const link = (await who.d.links()).find((l: any) => l.linkId === got.linkId);
  update(token, { status: 'confirm', sas: got.sas, revealHash: link ? link.revealHash : null });
}

/** The user matched the code and chose what to grant. */
export async function confirmPairing (scopesRaw: unknown): Promise<{ ok: true; pairing: PairingView | null } | { ok: false; error: string }> {
  if (!pairing || pairing.status !== 'confirm' || !pairing.sas) return { ok: false, error: 'nothing to confirm' };
  const scopes = Array.from(new Set((Array.isArray(scopesRaw) ? scopesRaw : []).map(String)))
    .filter((s) => (dcore.delegation.DELEGATION_SCOPES as string[]).includes(s));
  if (!scopes.length) return { ok: false, error: 'choose at least one thing to allow' };
  const who = await me();
  const token = pairing.token;
  update(token, { localConfirmed: true, scopes });
  await who.d.confirmLink(pairing.linkId);
  void finishWhenConfirmed(who, token).catch((err) => fail(token, err));
  return { ok: true, pairing: pairingView() };
}

async function finishWhenConfirmed (who: Me, token: number): Promise<void> {
  const p = pairing;
  if (!p || p.token !== token || !p.localConfirmed || !p.remoteConfirmed || p.status !== 'confirm') return;
  update(token, { status: 'granting' });
  const link = (await who.d.links()).find((l: any) => l.linkId === p.linkId);
  if (!link || !link.revealHash || !link.peerPubkey) throw new Error('the pairing is incomplete');
  const local = p.mode === 'local';
  const grant = await who.d.grant({
    grantee: link.peerPubkey,
    scopes: p.scopes,
    link: link.revealHash,
    label: PASSPORT_LABEL,
    extensionOrigin: local ? extensionOrigin() : undefined,
    cosignerKey: p.scopes.includes('federation') ? who.keys.cosigner.key : undefined
  });
  if (local && p.base) {
    const out = await postDelegateLink(p.base, grant.uri, { timeoutMs: 20000 });
    if (!out.ok) throw new Error(delegateRefusalError(out.httpStatus, out.error));
    for (const uri of Array.isArray(out.grants) ? out.grants as string[] : []) {
      const got = await who.d.receive(uri);
      if (!got.ok) throw new Error(`the app's grant does not check: ${got.error}`);
    }
  } else if (p.rendezvous && p.linkId) {
    const posted = await postLinkFrame(p.rendezvous, p.linkId, grant.uri);
    if (!posted.ok) throw new Error(delegateRefusalError(posted.httpStatus, posted.error));
    await collectPeerGrant(who, token, p.rendezvous, p.linkId, link.peer);
  }
  await saveSigner(who, {
    pubkey: link.peerPubkey,
    name: p.peerName || p.peerLabel || `${link.peerPubkey.slice(2, 10)}…`,
    signer: p.signer || null,
    network: p.network || null,
    via: local ? 'local' : 'hub',
    base: local ? p.base : null,
    hub: local ? null : p.rendezvous,
    linkedAt: Date.now()
  });
  update(token, { status: 'done' });
  void pollMailboxes().catch((err) => swallowNonFatal('delegation-after-pair', err));
}

/** The other side's grant reaches the link once its user confirms; take it when it does. */
async function collectPeerGrant (who: Me, token: number, hub: string, linkId: string, peerX: string): Promise<void> {
  const until = Math.min(pairing ? pairing.expiresAt : Date.now(), Date.now() + PAIRING_WAIT_MS);
  while (live(token) && Date.now() < until) {
    const out = await readLink(hub, linkId);
    if (!out.ok) return;
    for (const frame of Array.isArray(out.frames) ? out.frames as string[] : []) {
      if (dcore.delegation.delegationType(frame) !== 'DELEGATION_GRANT') continue;
      const read = dcore.delegation.readGrant(frame);
      if (!read.ok || read.author !== peerX) continue;
      const got = await who.d.receive(frame);
      if (got.ok) return;
    }
    await sleep(POLL_EVERY_MS * 2);
  }
}

export async function cancelPairing (): Promise<{ ok: true }> {
  const p = pairing;
  if (p && live(p.token)) {
    update(p.token, { status: 'cancelled' });
    if (p.rendezvous && p.linkId) {
      try {
        const who = await me();
        const proof = dcore.delegation.createMailboxFetch({}, who.keys.identity.key);
        await cancelLink(p.rendezvous, p.linkId, proof.uri);
      } catch (err: unknown) {
        swallowNonFatal('delegation-cancel-link', err);
      }
    }
  }
  pairing = null;
  await mirror();
  return { ok: true };
}

// Background wiring

/** Alarm for the mailboxes, plus notification buttons and clicks. */
export function registerDelegationBackground (): void {
  try {
    chrome.alarms.get(DELEGATION_ALARM, (existing) => {
      if (!existing) chrome.alarms.create(DELEGATION_ALARM, { periodInMinutes: 1 });
    });
  } catch (err: unknown) {
    swallowNonFatal('delegation-alarm', err);
  }
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== DELEGATION_ALARM) return;
    void pollMailboxes().catch((err) => swallowNonFatal('delegation-alarm-poll', err));
  });
  const hashOf = (id: string): string | null => {
    if (!id.startsWith(DELEGATION_NOTIFICATION_PREFIX)) return null;
    const hash = id.slice(DELEGATION_NOTIFICATION_PREFIX.length);
    return /^[0-9a-f]{64}$/.test(hash) ? hash : null;
  };
  chrome.notifications.onClicked.addListener((id) => {
    const hash = hashOf(id);
    if (hash || id.startsWith(SIGN_IN_NOTIFICATION_PREFIX) || id.startsWith(PAYMENT_NOTIFICATION_PREFIX)) {
      void openRequestPrompt(hash).catch((err) => swallowNonFatal('delegation-open-prompt', err));
    }
  });
  if (chrome.notifications.onButtonClicked) {
    chrome.notifications.onButtonClicked.addListener((id, index) => {
      const hash = hashOf(id);
      if (!hash) return;
      if (index === 0) {
        void openRequestPrompt(hash).catch((err) => swallowNonFatal('delegation-open-prompt', err));
      } else {
        void answerRequest({ hash, action: 'decline' }).catch((err) => swallowNonFatal('delegation-decline', err));
      }
    });
  }
  void refreshBadge();
}

/** Forget the delegation record of a removed identity (keys gone with it). */
export async function dropDelegationRecords (pubkey: string): Promise<void> {
  await fabricDsRemove(`delegation:${pubkey}`);
  await fabricDsRemove(signersKey(pubkey));
}
