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

export function buildDeviceLinkMessage (
  nonce: string,
  initiatorId: string,
  responderId: string,
  label: string
): string {
  const safeLabel = String(label || 'device').replace(/:/g, '-').slice(0, 64);
  return `${DEVICE_LINK_PREFIX}:${nonce}:${initiatorId}:${responderId}:${safeLabel}`;
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
