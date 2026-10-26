'use strict';

/**
 * BIP340 Schnorr client-signed bodies — same construction as Hub
 * `verifyIdentitySchnorr`, always over a purpose tag — and the `fabric:`
 * `/sessions` site-login POST.
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
  parseDesktopLoginMessage,
  resolveFabricSigningIdentity
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

export type FabricSigningIdentity = {
  id: string;
  xpub: string;
  pubkeyHex: string;
};

function toSignInput (privateKeyHexOrInput: string | FabricSignInput, xpub?: string): FabricSignInput {
  if (typeof privateKeyHexOrInput !== 'string') return privateKeyHexOrInput;
  if (typeof xpub !== 'string' || !xpub.startsWith('xpub')) {
    throw new Error('xpub required for a Fabric identity');
  }
  return { privateKeyHex: privateKeyHexOrInput, xpub };
}

/** Fabric id, xpub, and compressed pubkey of the signing key, without signing anything. */
export function fabricSigningIdentity (
  privateKeyHexOrInput: string | FabricSignInput,
  xpub?: string
): FabricSigningIdentity {
  const resolved = resolveFabricSigningIdentity(toSignInput(privateKeyHexOrInput, xpub));
  const key = resolved.fabricKey;
  const pubkeyHex = String(key.pubkey || '').toLowerCase();
  if (!/^[a-f0-9]{66}$/.test(pubkeyHex)) throw new Error('Could not derive Fabric public key');
  return { id: String(resolved.identityId), xpub: String(key.xpub || ''), pubkeyHex };
}

/**
 * Sign `message` under the purpose `tag` (a `@fabric/core/functions/signingTags`
 * value) and return a Hub-verifiable body.
 *
 * Overloads:
 * - `(message, tag, privateKeyHex, xpub)` — Passport session leaf (already at Fabric path)
 * - `(message, tag, { mnemonic|xprv|privateKeyHex+xpub })` — preferred structured input
 */
export function buildClientSignedBody (
  message: string,
  tag: string,
  privateKeyHexOrInput: string | FabricSignInput,
  xpub?: string
): SiteLoginSignatureBody {
  if (typeof tag !== 'string' || !tag) throw new Error('signing tag required');
  const payload = buildFabricIdentitySignedPayload(toSignInput(privateKeyHexOrInput, xpub), message, tag);
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
