'use strict';

/**
 * Mutual device-link signing (v3) — strings and checks from
 * `@fabric/http/functions/fabricDeviceLinkMessages` and `fabricDeviceLinkClient`,
 * the same ones hub.fabric.pub and GoonCitizen use.
 *
 * Passport signs only strings it built itself from a session it fetched and
 * checked: the responder verifies the initiator's offer first, and the
 * initiator countersigns only a responder the user approved.
 *
 * Popup-only: pulls `@fabric/core` via fabricIdentitySign. Content scripts must use
 * `fabricDeviceLinkFetch.ts` instead.
 */

import { buildClientSignedBody, fabricSigningIdentity } from './fabricIdentitySign';
import { deviceLinkFetchHeaders } from './fabricDeviceLinkFetch';
import type { DeviceLinkPending } from './fabricDeviceLinkFetch';

export type { DeviceLinkPending } from './fabricDeviceLinkFetch';
export { fetchPendingDeviceLink, cancelDeviceLinkSession } from './fabricDeviceLinkFetch';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const messages = require('@fabric/http/functions/fabricDeviceLinkMessages');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkClient = require('@fabric/http/functions/fabricDeviceLinkClient');

export const DEVICE_LINK_OFFER_TAG: string = messages.DEVICE_LINK_OFFER_TAG;
export const DEVICE_LINK_TAG: string = messages.DEVICE_LINK_TAG;
export const DEFAULT_DEVICE_LINK_HUB = 'https://relay.goon.vc';

const SESSION_ID_RE = /^[a-f0-9]{48}$/;
const NONCE_RE = /^[a-f0-9]{64}$/;

export type DeviceKey = { id: string; xpub: string; pubkeyHex: string };

type SessionJson = {
  ok?: boolean;
  error?: string;
  status?: string;
  sessionId?: string;
  origin?: string;
  nonce?: string;
  label?: string;
  offerMessage?: string;
  linkMessage?: string;
  initiator?: { id?: string; xpub?: string; pubkeyHex?: string; offerSignature?: string };
  responder?: { id?: string; xpub?: string; pubkeyHex?: string; signature?: string };
};

function safeDeviceLabel (label: string): string {
  return String(label || 'device').replace(/:/g, '-').slice(0, 64);
}

/** Mutual-link message both devices sign (v3): session, both ids, label, Hub origin. */
export function buildDeviceLinkMessage (
  sessionId: string,
  nonce: string,
  initiatorId: string,
  responderId: string,
  label: string,
  origin: string
): string {
  return messages.buildDeviceLinkMessage(sessionId, nonce, initiatorId, responderId, label, origin);
}

/** Offer the initiator signs to commit a prepared session (v3). */
export function buildDeviceLinkOfferMessage (
  sessionId: string,
  nonce: string,
  initiatorId: string,
  label: string,
  origin: string
): string {
  return messages.buildDeviceLinkOfferMessage(sessionId, nonce, initiatorId, label, origin);
}

/** First 16 hex characters of the x-only pubkey, in groups of four, for people to compare. */
export function keyFingerprint (pubkeyHex: string): string {
  const hex = String(pubkeyHex || '').toLowerCase().replace(/^0[23]/, '').slice(0, 16);
  return (hex.match(/.{1,4}/g) || []).join(' ');
}

export function httpsLandingUrl (hubBase: string, sessionId: string): string {
  const base = String(hubBase || '').replace(/\/$/, '');
  return `${base}/#device-link=${encodeURIComponent(sessionId)}`;
}

function jsonHeaders (): Record<string, string> {
  return deviceLinkFetchHeaders({ json: true });
}

function errorText (e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function getSession (
  hubBase: string,
  sessionId: string
): Promise<{ ok: true; st: SessionJson } | { ok: false; error: string }> {
  const base = String(hubBase || '').replace(/\/$/, '');
  const res = await fetch(`${base}/device-links/${encodeURIComponent(sessionId)}`, {
    headers: jsonHeaders(),
    cache: 'no-store'
  });
  const st = (await res.json().catch(() => ({}))) as SessionJson;
  if (!res.ok || !st.ok) return { ok: false, error: (st && st.error) || `HTTP ${res.status}` };
  return { ok: true, st };
}

export type DeviceLinkOffer = {
  sessionId: string;
  nonce: string;
  pollSecret?: string;
  label: string;
  hubBase: string;
  origin: string;
  protocolUrl: string;
  httpsUrl: string;
  initiatorId: string;
  status: string;
};

/**
 * Create a pending /device-links offer (Passport as initiator).
 * JSON origin is the hub; the browser Origin header may be chrome-extension:
 * (allowlisted as a thin client on the hub).
 */
export async function startDeviceLinkAsInitiator (opts: {
  privateKeyHex: string;
  xpub: string;
  hubBase?: string;
  label?: string;
}): Promise<{ ok: true } & DeviceLinkOffer | { ok: false; error: string }> {
  const hubBase = String(opts.hubBase || DEFAULT_DEVICE_LINK_HUB).replace(/\/$/, '');
  let origin: string;
  try {
    origin = new URL(hubBase).origin;
  } catch {
    return { ok: false, error: 'invalid hub base' };
  }
  type OfferReply = {
    ok?: boolean;
    error?: string;
    sessionId?: string;
    nonce?: string;
    pollSecret?: string;
    offerMessage?: string;
    protocolUrl?: string;
  };
  try {
    const own = fabricSigningIdentity({ privateKeyHex: opts.privateKeyHex, xpub: opts.xpub });
    const label = safeDeviceLabel(opts.label || 'Passport');
    // The Hub picks the session id and nonce; Passport signs only an offer it rebuilt itself.
    const prep = await fetch(`${hubBase}/device-links`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ origin, label, identity: { id: own.id, xpub: own.xpub } }),
      cache: 'no-store'
    });
    const prepared = (await prep.json().catch(() => ({}))) as OfferReply;
    if (!prep.ok || !prepared.ok) {
      return { ok: false, error: (prepared && prepared.error) || `HTTP ${prep.status}` };
    }
    const sessionId = String(prepared.sessionId || '').toLowerCase();
    const nonce = String(prepared.nonce || '').toLowerCase();
    if (!SESSION_ID_RE.test(sessionId) || !NONCE_RE.test(nonce)) {
      return { ok: false, error: 'hub did not return a device-link session' };
    }
    const offerMessage = buildDeviceLinkOfferMessage(sessionId, nonce, own.id, label, origin);
    if (prepared.offerMessage !== offerMessage) {
      return { ok: false, error: 'hub offer does not match this identity, label, or origin' };
    }
    const signed = buildClientSignedBody(offerMessage, DEVICE_LINK_OFFER_TAG, { privateKeyHex: opts.privateKeyHex, xpub: opts.xpub });
    const res = await fetch(`${hubBase}/device-links`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        origin,
        sessionId,
        label,
        identity: signed.identity,
        pubkeyHex: signed.pubkeyHex,
        signature: signed.signature
      }),
      cache: 'no-store'
    });
    const committed = (await res.json().catch(() => ({}))) as OfferReply;
    if (!res.ok || !committed.ok) {
      return { ok: false, error: (committed && committed.error) || `HTTP ${res.status}` };
    }
    const pollSecret = committed.pollSecret || prepared.pollSecret;
    const protocolUrl = committed.protocolUrl || prepared.protocolUrl ||
      `fabric://link?sessionId=${encodeURIComponent(sessionId)}&hub=${encodeURIComponent(origin)}`;
    return {
      ok: true,
      sessionId,
      nonce,
      pollSecret,
      label,
      hubBase,
      origin,
      protocolUrl,
      httpsUrl: httpsLandingUrl(hubBase, sessionId),
      initiatorId: own.id,
      status: 'pending'
    };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}

export type InitiatorTick =
  | { ok: true; status: 'pending' | 'cancelled' | 'expired' | string; sessionId: string }
  | {
    ok: true;
    status: 'accepted';
    sessionId: string;
    nonce: string;
    origin: string;
    label: string;
    linkMessage: string;
    responder: DeviceKey;
  }
  | {
    ok: true;
    status: 'linked';
    sessionId: string;
    nonce: string;
    origin: string;
    label: string;
    responder: DeviceKey;
  }
  | { ok: false; error: string };

/**
 * Poll once. Never signs: an `accepted` session comes back with the responder's
 * key (signature checked) for the user to approve before
 * {@link countersignDeviceLink}. A `linked` session is reported only for the
 * responder in `countersigned`.
 */
export async function tickDeviceLinkAsInitiator (opts: {
  privateKeyHex: string;
  xpub: string;
  sessionId: string;
  hubBase: string;
  origin: string;
  nonce: string;
  label: string;
  countersigned?: string | null;
}): Promise<InitiatorTick> {
  try {
    const got = await getSession(opts.hubBase, opts.sessionId);
    if (!got.ok) return got;
    const st = got.st;
    const status = String(st.status || 'unknown');
    if (status !== 'accepted' && status !== 'linked') {
      return { ok: true, status, sessionId: opts.sessionId };
    }
    const own = fabricSigningIdentity({ privateKeyHex: opts.privateKeyHex, xpub: opts.xpub });
    const sameSession = String(st.sessionId || '').toLowerCase() === opts.sessionId.toLowerCase() &&
      String(st.nonce || '').toLowerCase() === opts.nonce.toLowerCase() &&
      st.label === opts.label &&
      st.origin === opts.origin &&
      st.initiator && st.initiator.id === own.id;
    if (!sameSession) return { ok: false, error: 'hub session does not match this link' };
    const checked = linkClient.verifyDeviceLinkResponder(st) as
      | { ok: true; linkMessage: string; responder: DeviceKey }
      | { ok: false; error: string };
    if (!checked.ok) return { ok: false, error: checked.error };
    if (checked.responder.id === own.id) return { ok: false, error: 'a device cannot link to itself' };
    const base = {
      sessionId: opts.sessionId,
      nonce: opts.nonce,
      origin: opts.origin,
      label: opts.label,
      responder: checked.responder
    };
    if (status === 'linked') {
      if (!opts.countersigned || opts.countersigned !== checked.responder.id) {
        return { ok: false, error: 'hub reports a link this Passport did not approve' };
      }
      return { ok: true, status: 'linked', ...base };
    }
    return { ok: true, status: 'accepted', linkMessage: checked.linkMessage, ...base };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * Countersign the link the user approved. `accepted` is the tick result they
 * saw; the string is rebuilt from it here, never taken from the Hub.
 */
export async function countersignDeviceLink (opts: {
  privateKeyHex: string;
  xpub: string;
  hubBase: string;
  accepted: { sessionId: string; nonce: string; origin: string; label: string; responder: DeviceKey };
}): Promise<{ ok: true; status: string } | { ok: false; error: string }> {
  const a = opts.accepted;
  try {
    const own = fabricSigningIdentity({ privateKeyHex: opts.privateKeyHex, xpub: opts.xpub });
    const linkMessage = buildDeviceLinkMessage(a.sessionId, a.nonce, own.id, a.responder.id, a.label, a.origin);
    const signed = buildClientSignedBody(linkMessage, DEVICE_LINK_TAG, { privateKeyHex: opts.privateKeyHex, xpub: opts.xpub });
    const base = String(opts.hubBase || '').replace(/\/$/, '');
    const post = await fetch(`${base}/device-links/${encodeURIComponent(a.sessionId)}/signatures`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        role: 'initiator',
        signature: signed.signature,
        pubkeyHex: signed.pubkeyHex,
        identity: signed.identity
      }),
      cache: 'no-store'
    });
    const done = (await post.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: string };
    if (!post.ok || !done.ok) return { ok: false, error: (done && done.error) || `HTTP ${post.status}` };
    return { ok: true, status: String(done.status || 'linked') };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}

export type VerifiedDeviceLinkOffer = {
  sessionId: string;
  nonce: string;
  label: string;
  origin: string;
  hubBase: string;
  initiator: DeviceKey;
  fingerprint: string;
};

/**
 * Fetch the session a page asked to link and check the initiator's signed
 * offer: v3 string rebuilt here, pubkey from its xpub, id from that pubkey,
 * offered on the Hub it is served from. What the prompt shows.
 */
export async function verifyPendingDeviceLink (
  pending: DeviceLinkPending
): Promise<{ ok: true; offer: VerifiedDeviceLinkOffer } | { ok: false; error: string }> {
  try {
    const hubOrigin = new URL(pending.hubBase).origin;
    const got = await getSession(pending.hubBase, pending.sessionId);
    if (!got.ok) return got;
    const st = got.st;
    if (st.status !== 'pending') return { ok: false, error: `device link is ${st.status || 'unknown'}` };
    if (String(st.sessionId || '').toLowerCase() !== pending.sessionId.toLowerCase()) {
      return { ok: false, error: 'hub returned another session' };
    }
    const checked = linkClient.verifyDeviceLinkOffer(st, hubOrigin) as
      | { ok: true; origin: string; initiator: DeviceKey }
      | { ok: false; error: string };
    if (!checked.ok) return { ok: false, error: checked.error };
    if (pending.initiator && pending.initiator.id && pending.initiator.id !== checked.initiator.id) {
      return { ok: false, error: 'the page named another device than the Hub session' };
    }
    return {
      ok: true,
      offer: {
        sessionId: String(st.sessionId).toLowerCase(),
        nonce: String(st.nonce).toLowerCase(),
        label: String(st.label),
        origin: checked.origin,
        hubBase: pending.hubBase,
        initiator: checked.initiator,
        fingerprint: keyFingerprint(checked.initiator.pubkeyHex)
      }
    };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}

/**
 * Sign as responder and POST to Hub `/device-links/:id/signatures`. The offer is
 * fetched and checked again, and must name the same initiator key the user
 * approved in `approved`.
 */
export async function completeDeviceLinkAsResponder (
  approved: VerifiedDeviceLinkOffer,
  privateKeyHex: string,
  xpub: string
): Promise<
  | {
    ok: true;
    status: string;
    peerFabricId: string;
    peerXpub: string;
    peerPubkey: string;
    label: string;
    sessionId: string;
    nonce: string;
    origin: string;
  }
  | { ok: false; error: string }
> {
  const again = await verifyPendingDeviceLink({
    sessionId: approved.sessionId,
    hubBase: approved.hubBase,
    origin: approved.origin,
    nonce: approved.nonce,
    label: approved.label,
    initiator: { id: approved.initiator.id, xpub: approved.initiator.xpub }
  });
  if (!again.ok) return again;
  const offer = again.offer;
  if (
    offer.nonce !== approved.nonce || offer.label !== approved.label || offer.origin !== approved.origin ||
    offer.initiator.pubkeyHex !== approved.initiator.pubkeyHex
  ) {
    return { ok: false, error: 'device link changed since you approved it' };
  }
  try {
    const own = fabricSigningIdentity({ privateKeyHex, xpub });
    if (own.id === offer.initiator.id) {
      return { ok: false, error: 'Cannot link a device to itself — use a different Passport identity' };
    }
    const linkMessage = buildDeviceLinkMessage(offer.sessionId, offer.nonce, offer.initiator.id, own.id, offer.label, offer.origin);
    const body = buildClientSignedBody(linkMessage, DEVICE_LINK_TAG, { privateKeyHex, xpub });
    const base = String(offer.hubBase || '').replace(/\/$/, '');
    const res = await fetch(`${base}/device-links/${encodeURIComponent(offer.sessionId)}/signatures`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({
        role: 'responder',
        signature: body.signature,
        pubkeyHex: body.pubkeyHex,
        identity: body.identity
      }),
      cache: 'no-store'
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; status?: string };
    if (!res.ok || !data.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    return {
      ok: true,
      status: String(data.status || 'accepted'),
      peerFabricId: offer.initiator.id,
      peerXpub: offer.initiator.xpub,
      peerPubkey: offer.initiator.pubkeyHex,
      label: offer.label || 'Linked device',
      sessionId: offer.sessionId,
      nonce: offer.nonce,
      origin: offer.origin
    };
  } catch (e: unknown) {
    return { ok: false, error: errorText(e) };
  }
}
