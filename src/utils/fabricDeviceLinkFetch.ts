'use strict';

/**
 * Fetch-only helpers for Hub device-link sessions.
 * Kept free of `@fabric/core` so the content-script bundle does not pull Identity/bech32.
 */

import { assertAllowedFabricHub } from './fabricHubAllowlist';

export type DeviceLinkPending = {
  sessionId: string;
  hubBase: string;
  origin: string;
  nonce: string;
  label: string;
  initiator: { id: string; xpub: string; pubkeyHex?: string };
};

/**
 * Content-script gate for `FABRIC_DEVICE_LINK_REQUEST` (phishing / origin bind).
 */
export function evaluateDeviceLinkPageRequest (opts: {
  sessionId: string;
  hubRaw: string;
  declaredOrigin: string;
  pageOrigin: string;
}): { ok: true; hubBase: string; sessionId: string } | { ok: false; error: string } {
  const sessionId = String(opts.sessionId || '').trim();
  const hubRaw = String(opts.hubRaw || '').trim();
  if (!sessionId || !hubRaw) return { ok: false, error: 'invalid' };
  let hubBase: string;
  let hubOrigin: string;
  try {
    const u = new URL(hubRaw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, error: 'invalid' };
    }
    hubBase = `${u.protocol}//${u.host}`;
    hubOrigin = u.origin;
  } catch {
    return { ok: false, error: 'invalid' };
  }
  const hubGate = assertAllowedFabricHub(hubBase);
  if (!hubGate.ok) return { ok: false, error: 'hub_not_allowed' };
  hubBase = hubGate.hubBase;
  if (opts.declaredOrigin !== opts.pageOrigin || hubOrigin !== opts.pageOrigin) {
    return { ok: false, error: 'origin_mismatch' };
  }
  return { ok: true, hubBase, sessionId };
}

/**
 * Background queue gate for `FABRIC_RUNTIME_DEVICE_LINK_REQUEST`.
 */
export function validateQueuedDeviceLinkOffer (m: {
  sessionId?: unknown;
  hubBase?: unknown;
  origin?: unknown;
  nonce?: unknown;
  pageOrigin?: unknown;
  initiator?: unknown;
}): { ok: true } | { ok: false; error: 'invalid_device_link' } {
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId.trim() : '';
  const hubBase = typeof m.hubBase === 'string' ? m.hubBase.trim() : '';
  const origin = typeof m.origin === 'string' ? m.origin.trim() : '';
  const nonce = typeof m.nonce === 'string' ? m.nonce.trim() : '';
  const pageOrigin = typeof m.pageOrigin === 'string' ? m.pageOrigin.trim() : '';
  const initiator = m.initiator && typeof m.initiator === 'object'
    ? (m.initiator as { id?: unknown; xpub?: unknown })
    : null;
  if (
    !sessionId || !hubBase || !nonce || !pageOrigin || pageOrigin !== origin ||
    !initiator || typeof initiator.id !== 'string' || typeof initiator.xpub !== 'string'
  ) {
    return { ok: false, error: 'invalid_device_link' };
  }
  return { ok: true };
}

/**
 * Device-link HTTP headers. Do not set Origin/Referer — Fetch forbids them in
 * browsers, and Hub accepts `chrome-extension:` / `moz-extension:` thin-client
 * Origins on allowlisted hubs (`@fabric/http` `deviceLinkHeaders`).
 */
export function deviceLinkFetchHeaders (opts: { json?: boolean } = {}): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (opts.json) headers['Content-Type'] = 'application/json';
  return headers;
}

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
      headers: deviceLinkFetchHeaders(),
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

/**
 * DELETE a pending Hub device-link session. 404 / already-gone is success so
 * Cancel always unsticks the Passport UI. Fetch rejection is `ok: false` —
 * the remote row may still exist.
 */
export async function cancelDeviceLinkSession (
  hubBase: string,
  sessionId: string
): Promise<{ ok: true; cancelled?: boolean; skipped?: boolean; alreadyLinked?: boolean } | { ok: false; error: string }> {
  const base = String(hubBase || '').replace(/\/$/, '');
  const sid = String(sessionId || '').trim();
  if (!base || !sid) return { ok: true, skipped: true };
  try {
    const res = await fetch(`${base}/device-links/${encodeURIComponent(sid)}`, {
      method: 'DELETE',
      headers: deviceLinkFetchHeaders(),
      cache: 'no-store'
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; existed?: boolean };
    if (res.status === 404 || (res.ok && data && data.ok !== false)) {
      return { ok: true, cancelled: true };
    }
    if (res.status === 409) {
      return { ok: true, alreadyLinked: true };
    }
    return { ok: false, error: (data && data.error) || `HTTP ${res.status}` };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
