'use strict';

/**
 * Mutual device-link signing — aligned with hub.fabric.pub/functions/fabricDeviceLink.js
 * and GoonCitizen functions/fabricDeviceLinkClient.js.
 *
 * Popup-only: pulls `@fabric/core` via fabricSiteLoginSign. Content scripts must use
 * `fabricDeviceLinkFetch.ts` instead.
 */

import { buildClientSignedLoginBody } from './fabricSiteLoginSign';
import { deviceLinkFetchHeaders } from './fabricDeviceLinkFetch';
import type { DeviceLinkPending } from './fabricDeviceLinkFetch';

export type { DeviceLinkPending } from './fabricDeviceLinkFetch';
export { fetchPendingDeviceLink, cancelDeviceLinkSession } from './fabricDeviceLinkFetch';

const DEVICE_LINK_PREFIX = 'fabric:device-link:2';
export const DEFAULT_DEVICE_LINK_HUB = 'https://relay.goon.vc';

const SESSION_ID_RE = /^[a-f0-9]{48}$/;
const NONCE_RE = /^[a-f0-9]{64}$/;

function safeDeviceLabel (label: string): string {
  return String(label || 'device').replace(/:/g, '-').slice(0, 64);
}

/** Mutual-link message both devices sign; binds the Hub session id (v2, as `@fabric/http`). */
export function buildDeviceLinkMessage (
  sessionId: string,
  nonce: string,
  initiatorId: string,
  responderId: string,
  label: string
): string {
  const sid = String(sessionId || '').trim().toLowerCase();
  const n = String(nonce || '').trim().toLowerCase();
  if (!SESSION_ID_RE.test(sid)) throw new Error('sessionId must be 48 hex chars');
  if (!NONCE_RE.test(n)) throw new Error('nonce must be 64 hex chars');
  return `${DEVICE_LINK_PREFIX}:${sid}:${n}:${initiatorId}:${responderId}:${safeDeviceLabel(label)}`;
}

/** Offer the initiator signs to commit a prepared session (v2). */
export function buildDeviceLinkOfferMessage (
  sessionId: string,
  nonce: string,
  initiatorId: string,
  label: string,
  origin: string
): string {
  const sid = String(sessionId || '').trim().toLowerCase();
  const n = String(nonce || '').trim().toLowerCase();
  if (!SESSION_ID_RE.test(sid)) throw new Error('sessionId must be 48 hex chars');
  if (!NONCE_RE.test(n)) throw new Error('nonce must be 64 hex chars');
  return `${DEVICE_LINK_PREFIX}:offer:${sid}:${n}:${initiatorId}:${safeDeviceLabel(label)}:${origin}`;
}

export function httpsLandingUrl (hubBase: string, sessionId: string): string {
  const base = String(hubBase || '').replace(/\/$/, '');
  return `${base}/#device-link=${encodeURIComponent(sessionId)}`;
}

function jsonHeaders (): Record<string, string> {
  return deviceLinkFetchHeaders({ json: true });
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
  const probe = buildClientSignedLoginBody('fabric:device-link:id-probe', opts.privateKeyHex, opts.xpub);
  const initiatorId = probe.identity.id;
  const label = safeDeviceLabel(opts.label || 'Passport');
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
    // The Hub picks the session id and nonce; Passport signs only an offer it rebuilt itself.
    const prep = await fetch(`${hubBase}/device-links`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ origin, label, identity: probe.identity }),
      cache: 'no-store'
    });
    const prepared = (await prep.json().catch(() => ({}))) as OfferReply;
    if (!prep.ok || !prepared.ok) {
      return { ok: false, error: (prepared && prepared.error) || `HTTP ${prep.status}` };
    }
    const sessionId = String(prepared.sessionId || '').toLowerCase();
    const nonce = String(prepared.nonce || '').toLowerCase();
    if (!SESSION_ID_RE.test(sessionId) || !NONCE_RE.test(nonce)) {
      return { ok: false, error: 'hub did not return a device-link session (it may predate session-bound links)' };
    }
    const offerMessage = buildDeviceLinkOfferMessage(sessionId, nonce, initiatorId, label, origin);
    if (prepared.offerMessage && prepared.offerMessage !== offerMessage) {
      return { ok: false, error: 'hub offer does not match this identity, label, or origin' };
    }
    const signed = buildClientSignedLoginBody(offerMessage, opts.privateKeyHex, opts.xpub);
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
    const data = {
      sessionId,
      nonce,
      pollSecret: committed.pollSecret || prepared.pollSecret,
      protocolUrl: committed.protocolUrl || prepared.protocolUrl
    };
    const protocolUrl = data.protocolUrl ||
      `fabric://link?sessionId=${encodeURIComponent(data.sessionId)}&hub=${encodeURIComponent(origin)}`;
    return {
      ok: true,
      sessionId: data.sessionId,
      nonce: data.nonce,
      pollSecret: data.pollSecret,
      label,
      hubBase,
      origin,
      protocolUrl,
      httpsUrl: httpsLandingUrl(hubBase, data.sessionId),
      initiatorId,
      status: 'pending'
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Poll once. When the responder has accepted, countersign as initiator.
 */
export async function tickDeviceLinkAsInitiator (opts: {
  privateKeyHex: string;
  xpub: string;
  sessionId: string;
  hubBase: string;
  origin: string;
  nonce?: string;
  label?: string;
}): Promise<
  | {
    ok: true;
    status: string;
    sessionId: string;
    nonce?: string;
    peerFabricId?: string | null;
    peerXpub?: string | null;
    peerPubkey?: string | null;
    label?: string;
  }
  | { ok: false; error: string }
> {
  const base = String(opts.hubBase || '').replace(/\/$/, '');
  try {
    const get = await fetch(`${base}/device-links/${encodeURIComponent(opts.sessionId)}`, {
      headers: jsonHeaders(),
      cache: 'no-store'
    });
    const st = (await get.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      status?: string;
      linkMessage?: string;
      nonce?: string;
      label?: string;
      responder?: { id?: string; xpub?: string; pubkeyHex?: string };
    };
    if (!get.ok || !st.ok) {
      return { ok: false, error: (st && st.error) || `HTTP ${get.status}` };
    }
    if (st.status === 'pending') {
      return { ok: true, status: 'pending', sessionId: opts.sessionId };
    }
    if (st.status === 'linked') {
      return {
        ok: true,
        status: 'linked',
        sessionId: opts.sessionId,
        nonce: st.nonce || opts.nonce,
        peerFabricId: (st.responder && st.responder.id) || null,
        peerXpub: (st.responder && st.responder.xpub) || null,
        peerPubkey: (st.responder && st.responder.pubkeyHex) || null,
        label: st.label || opts.label
      };
    }
    if (st.status !== 'accepted' || !st.linkMessage) {
      return { ok: true, status: String(st.status || 'unknown'), sessionId: opts.sessionId };
    }
    const responderId = (st.responder && st.responder.id) || '';
    const probe = buildClientSignedLoginBody('fabric:device-link:id-probe', opts.privateKeyHex, opts.xpub);
    let expected = '';
    try {
      expected = buildDeviceLinkMessage(
        opts.sessionId,
        String(opts.nonce || st.nonce || ''),
        probe.identity.id,
        responderId,
        String(opts.label || st.label || 'device')
      );
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (!responderId || responderId === probe.identity.id || st.linkMessage !== expected) {
      return { ok: false, error: 'hub link message does not match this session' };
    }
    const countersigned = buildClientSignedLoginBody(expected, opts.privateKeyHex, opts.xpub);
    const post = await fetch(
      `${base}/device-links/${encodeURIComponent(opts.sessionId)}/signatures`,
      {
        method: 'POST',
        headers: jsonHeaders(),
        body: JSON.stringify({
          role: 'initiator',
          signature: countersigned.signature,
          pubkeyHex: countersigned.pubkeyHex,
          identity: countersigned.identity
        }),
        cache: 'no-store'
      }
    );
    const done = (await post.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      status?: string;
      label?: string;
      responder?: { id?: string; xpub?: string; pubkeyHex?: string };
    };
    if (!post.ok || !done.ok) {
      return { ok: false, error: (done && done.error) || `HTTP ${post.status}` };
    }
    // Hub POST …/signatures returns { id, xpub } only; pubkeyHex is on the GET.
    const responder = Object.assign({}, st.responder || {}, done.responder || {});
    return {
      ok: true,
      status: String(done.status || 'linked'),
      sessionId: opts.sessionId,
      nonce: st.nonce || opts.nonce,
      peerFabricId: (responder && responder.id) || null,
      peerXpub: (responder && responder.xpub) || null,
      peerPubkey: (responder && responder.pubkeyHex) || null,
      label: done.label || st.label || opts.label
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Sign as responder and POST to Hub `/device-links/:id/signatures`.
 */
export async function completeDeviceLinkAsResponder (
  pending: DeviceLinkPending,
  privateKeyHex: string,
  xpub: string
): Promise<
  | { ok: true; status: string; peerFabricId: string; peerXpub: string; label: string }
  | { ok: false; error: string }
> {
  // Derive Fabric Identity.id the same way Hub verify expects (via site-login helper).
  const probe = buildClientSignedLoginBody('fabric:device-link:id-probe', privateKeyHex, xpub);
  const responderId = probe.identity.id;
  if (responderId === pending.initiator.id) {
    return { ok: false, error: 'Cannot link a device to itself — use a different Passport identity' };
  }
  let linkMessage: string;
  try {
    linkMessage = buildDeviceLinkMessage(
      pending.sessionId,
      pending.nonce,
      pending.initiator.id,
      responderId,
      pending.label || 'device'
    );
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const body = buildClientSignedLoginBody(linkMessage, privateKeyHex, xpub);
  const base = String(pending.hubBase || '').replace(/\/$/, '');
  try {
    new URL(base);
  } catch {
    return { ok: false, error: 'invalid hub base' };
  }
  const url = `${base}/device-links/${encodeURIComponent(pending.sessionId)}/signatures`;
  try {
    const res = await fetch(url, {
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
      peerFabricId: pending.initiator.id,
      peerXpub: pending.initiator.xpub,
      label: pending.label || 'Linked device'
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
