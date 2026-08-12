'use strict';

/**
 * Fetch-only helpers for Hub device-link sessions.
 * Kept free of `@fabric/core` so the content-script bundle does not pull Identity/bech32.
 */

export type DeviceLinkPending = {
  sessionId: string;
  hubBase: string;
  origin: string;
  nonce: string;
  label: string;
  initiator: { id: string; xpub: string; pubkeyHex?: string };
};

/**
 * GET pending device-link session from Hub.
 */
export async function fetchPendingDeviceLink (
  hubBase: string,
  sessionId: string
): Promise<
  | { ok: true } & DeviceLinkPending & { status: string }
  | { ok: false; error: string }
> {
  const base = String(hubBase || '').replace(/\/$/, '');
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, error: 'invalid hub base' };
  }
  try {
    const res = await fetch(`${base}/device-links/${encodeURIComponent(sessionId)}`, {
      headers: {
        Accept: 'application/json',
        Origin: origin,
        Referer: `${origin}/`
      },
      cache: 'no-store'
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      status?: string;
      sessionId?: string;
      origin?: string;
      nonce?: string;
      label?: string;
      initiator?: { id: string; xpub: string; pubkeyHex?: string };
    };
    if (!res.ok || !data.ok) {
      return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
    }
    if (!data.initiator || !data.nonce) {
      return { ok: false, error: 'incomplete device-link session' };
    }
    return {
      ok: true,
      status: String(data.status || ''),
      sessionId: String(data.sessionId || sessionId),
      hubBase: base,
      origin: String(data.origin || origin),
      nonce: data.nonce,
      label: String(data.label || 'device'),
      initiator: data.initiator
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
