'use strict';

/**
 * BIP340 Schnorr client-signed device-link bodies — same construction as Hub
 * `verifyIdentitySchnorr` — and the `fabric:` `/sessions` site-login POST.
 *
 * Prefer HD material (`Key` / mnemonic / xprv) so signing uses Fabric
 * `Identity.fabricKey`. Leaf `{ privateKeyHex, xpub }` (Passport session) is
 * accepted when the private key is already at the Fabric derivation path.
 */

import { Buffer } from 'buffer';

// CommonJS Fabric helpers (webpack + mocha both resolve these).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildFabricIdentitySignedPayload,
  parseDesktopLoginMessage
} = require('@fabric/http/functions/fabricSiteLoginVerify');

export type SiteLoginIdentity = {
  id: string;
  xpub: string;
};

export type SiteLoginSignatureBody = {
  signature: string;
  pubkeyHex: string;
  identity: SiteLoginIdentity;
};

export type FabricSignInput =
  | { mnemonic: string; passphrase?: string }
  | { xprv: string }
  | { privateKeyHex: string; xpub: string }
  | { private: string; xpub?: string };

/**
 * Build a Hub-verifiable client signature body.
 *
 * Overloads:
 * - `(message, privateKeyHex, xpub)` — Passport session leaf (already at Fabric path)
 * - `(message, { mnemonic|xprv|privateKeyHex+xpub })` — preferred structured input
 */
export function buildClientSignedLoginBody (
  message: string,
  privateKeyHexOrInput: string | FabricSignInput,
  xpub?: string
): SiteLoginSignatureBody {
  let input: FabricSignInput;
  if (typeof privateKeyHexOrInput === 'string') {
    if (typeof xpub !== 'string' || !xpub.startsWith('xpub')) {
      throw new Error('xpub required for site login identity');
    }
    input = { privateKeyHex: privateKeyHexOrInput, xpub };
  } else {
    input = privateKeyHexOrInput;
  }

  const payload = buildFabricIdentitySignedPayload(input, message);
  return {
    signature: payload.signature,
    pubkeyHex: payload.pubkeyHex,
    identity: {
      id: String(payload.identity.id),
      xpub: String(payload.identity.xpub)
    }
  };
}

/**
 * Origin and nonce of a `/sessions` challenge (`fabric:hub-login:1:…`), or null
 * when it is malformed or names another session.
 */
export function parseHubLoginChallenge (
  message: string,
  sessionId: string
): { origin: string; nonce: string } | null {
  const parsed = parseDesktopLoginMessage(message);
  if (!parsed || String(parsed.sessionId).toLowerCase() !== String(sessionId || '').toLowerCase()) return null;
  return { origin: String(parsed.origin), nonce: String(parsed.nonce) };
}

/**
 * POST a desktop- or Passport-signed `fabric:` `SiteLoginResponse` to
 * `{hub}/sessions/:id/signatures` (bound to the session's origin and nonce).
 */
export async function postFabricSiteLogin (
  hubBase: string,
  sessionId: string,
  uri: string
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const base = String(hubBase || '').replace(/\/$/, '');
  let origin: string;
  try {
    origin = new URL(base).origin;
  } catch {
    return { ok: false, error: 'invalid hub base' };
  }
  const url = `${base}/sessions/${encodeURIComponent(sessionId)}/signatures`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: origin,
        Referer: `${origin}/`
      },
      body: JSON.stringify({ fabric: uri }),
      cache: 'no-store'
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || data.ok !== true) {
      return {
        ok: false,
        error: typeof data.error === 'string' ? data.error : `signature rejected (HTTP ${res.status})`
      };
    }
    return { ok: true, data };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
