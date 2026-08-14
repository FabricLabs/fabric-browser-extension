'use strict';

/**
 * Mutual device-link signing — aligned with hub.fabric.pub/functions/fabricDeviceLink.js
 * and GoonCitizen functions/fabricDeviceLinkClient.js.
 *
 * Popup-only: pulls `@fabric/core` via fabricSiteLoginSign. Content scripts must use
 * `fabricDeviceLinkFetch.ts` instead.
 */

import { buildClientSignedLoginBody } from './fabricSiteLoginSign';
import type { DeviceLinkPending } from './fabricDeviceLinkFetch';

export type { DeviceLinkPending } from './fabricDeviceLinkFetch';
export { fetchPendingDeviceLink } from './fabricDeviceLinkFetch';

const DEVICE_LINK_PREFIX = 'fabric:device-link:1';
export const DEFAULT_DEVICE_LINK_HUB = 'https://relay.goon.vc';

export function buildDeviceLinkMessage (
  nonce: string,
  initiatorId: string,
  responderId: string,
  label: string
): string {
  const safeLabel = String(label || 'device').replace(/:/g, '-').slice(0, 64);
  return `${DEVICE_LINK_PREFIX}:${nonce}:${initiatorId}:${responderId}:${safeLabel}`;
}

export function buildDeviceLinkOfferMessage (
  nonce: string,
  initiatorId: string,
  label: string,
  origin: string
): string {
  const safeLabel = String(label || 'device').replace(/:/g, '-').slice(0, 64);
  return `${DEVICE_LINK_PREFIX}:offer:${nonce}:${initiatorId}:${safeLabel}:${origin}`;
}

export function httpsLandingUrl (hubBase: string, sessionId: string): string {
  const base = String(hubBase || '').replace(/\/$/, '');
  return `${base}/#device-link=${encodeURIComponent(sessionId)}`;
}

function randomNonceHex (): string {
  const u = new Uint8Array(32);
  crypto.getRandomValues(u);
  return Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function jsonHeaders (origin: string): Record<string, string> {
  const o = String(origin || '').replace(/\/$/, '');
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: o,
    Referer: `${o}/`
  };
}

export type DeviceLinkOffer = {
  sessionId: string;
  nonce: string;
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
  const nonce = randomNonceHex();
  const label = String(opts.label || 'Passport').replace(/:/g, '-').slice(0, 64);
  const offerMessage = buildDeviceLinkOfferMessage(nonce, initiatorId, label, origin);
  const signed = buildClientSignedLoginBody(offerMessage, opts.privateKeyHex, opts.xpub);
  try {
    const res = await fetch(`${hubBase}/device-links`, {
      method: 'POST',
      headers: jsonHeaders(origin),
      body: JSON.stringify({
        origin,
        label,
        nonce,
        identity: signed.identity,
        pubkeyHex: signed.pubkeyHex,
        signature: signed.signature
      }),
      cache: 'no-store'
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      sessionId?: string;
      nonce?: string;
      protocolUrl?: string;
    };
    if (!res.ok || !data.ok || !data.sessionId) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    const protocolUrl = data.protocolUrl ||
      `fabric://link?sessionId=${encodeURIComponent(data.sessionId)}&hub=${encodeURIComponent(origin)}`;
    return {
      ok: true,
      sessionId: data.sessionId,
      nonce: data.nonce || nonce,
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
  const origin = String(opts.origin || base).replace(/\/$/, '');
  try {
    const get = await fetch(`${base}/device-links/${encodeURIComponent(opts.sessionId)}`, {
      headers: jsonHeaders(origin),
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
    const countersigned = buildClientSignedLoginBody(st.linkMessage, opts.privateKeyHex, opts.xpub);
    const post = await fetch(
      `${base}/device-links/${encodeURIComponent(opts.sessionId)}/signatures`,
      {
        method: 'POST',
        headers: jsonHeaders(origin),
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
    const responder = done.responder || st.responder;
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
  const linkMessage = buildDeviceLinkMessage(
    pending.nonce,
    pending.initiator.id,
    responderId,
    pending.label || 'device'
  );
  const body = buildClientSignedLoginBody(linkMessage, privateKeyHex, xpub);
  const base = String(pending.hubBase || '').replace(/\/$/, '');
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, error: 'invalid hub base' };
  }
  const url = `${base}/device-links/${encodeURIComponent(pending.sessionId)}/signatures`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: origin,
        Referer: `${origin}/`
      },
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
