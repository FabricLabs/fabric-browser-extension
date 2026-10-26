'use strict';

/**
 * BIP340 Schnorr client-signed bodies — same construction as core
 * `verifyIdentitySchnorr`, always over a purpose tag — for device links and
 * cross-signs.
 *
 * Passport signs with the identity key of the current account and network
 * (`m/44'/F'/n'/0/0`), passed as the resolved `{ fabricKey, identityId }` from
 * core `deriveAccount`.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./loadFabricPassport');

export type SignedIdentity = {
  id: string;
  xpub: string;
};

export type ClientSignedBody = {
  signature: string;
  pubkeyHex: string;
  identity: SignedIdentity;
};

/** A Fabric Key at the identity path, and its Fabric id. */
export type FabricSigningKey = {
  fabricKey: { pubkey: string; xpub: string; signSchnorr: (msg: unknown, tag: string) => unknown };
  identityId: string;
};

export type FabricSignInput =
  | FabricSigningKey
  | { xprv: string }
  | { privateKeyHex: string; xpub: string };

export type FabricSigningIdentity = {
  id: string;
  xpub: string;
  pubkeyHex: string;
};

function schnorr (): { resolveFabricSigningIdentity: Function; buildFabricIdentitySignedPayload: Function } {
  if (!core || !core.identitySchnorr) throw new Error('Fabric identity signing is unavailable in this build');
  return core.identitySchnorr;
}

function resolve (input: FabricSignInput): FabricSigningKey {
  const maybe = input as FabricSigningKey;
  if (maybe && maybe.fabricKey && typeof maybe.fabricKey.signSchnorr === 'function' && typeof maybe.identityId === 'string') {
    return maybe;
  }
  return schnorr().resolveFabricSigningIdentity(input) as FabricSigningKey;
}

/** The signing key of one derived account (core `deriveAccount(...).identity`). */
export function signingKeyOfAccount (account: { identity: { key: FabricSigningKey['fabricKey']; id: string } }): FabricSigningKey {
  return { fabricKey: account.identity.key, identityId: String(account.identity.id) };
}

/** Fabric id, xpub, and compressed pubkey of the signing key, without signing anything. */
export function fabricSigningIdentity (input: FabricSignInput): FabricSigningIdentity {
  const resolved = resolve(input);
  const pubkeyHex = String(resolved.fabricKey.pubkey || '').toLowerCase();
  if (!/^[a-f0-9]{66}$/.test(pubkeyHex)) throw new Error('Could not derive Fabric public key');
  return { id: String(resolved.identityId), xpub: String(resolved.fabricKey.xpub || ''), pubkeyHex };
}

/**
 * Sign `message` under the purpose `tag` (a `@fabric/core/functions/signingTags`
 * value) and return a body core `verifyIdentitySchnorr` accepts.
 */
export function buildClientSignedBody (message: string, tag: string, input: FabricSignInput): ClientSignedBody {
  if (typeof tag !== 'string' || !tag) throw new Error('signing tag required');
  const payload = schnorr().buildFabricIdentitySignedPayload(resolve(input), message, tag);
  return {
    signature: payload.signature,
    pubkeyHex: payload.pubkeyHex,
    identity: {
      id: String(payload.identity.id),
      xpub: String(payload.identity.xpub)
    }
  };
}
