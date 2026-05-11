'use strict';

/**
 * Same logic as `identityAndWalletBlobFromNode` in `IdentityManager.tsx`:
 * 32-byte x coordinate from compressed secp public key → `id` bech32m.
 */

import { bech32m } from 'bech32';
import { Buffer } from 'buffer';
import { swallowNonFatal } from './nonFatal';

export function publicKeyHexToIdBech32m (publicKeyHex: string): string | null {
  const h = publicKeyHex.replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{66}$/.test(h)) return null;
  const buf = Buffer.from(h, 'hex');
  if (buf.length !== 33) return null;
  if (buf[0] !== 0x02 && buf[0] !== 0x03) return null;
  const xCoord = buf.subarray(1, 33);
  const words = bech32m.toWords(Uint8Array.from(xCoord));
  return bech32m.encode('id', words);
}

/** True if the string is a decodable bech32m with HRP `id` (Passport’s Fabric identity). */
export function isFabricIdBech32m (s: string): boolean {
  if (!s || typeof s !== 'string') return false;
  try {
    const d = bech32m.decode(s);
    return d.prefix === 'id';
  } catch (err: unknown) {
    swallowNonFatal('fabric-id-bech32m-decode', err);
    return false;
  }
}

/**
 * `X-Fabric-Identity` value: canonical `id1…` bech32m of the secp public key, or the stored
 * `id` / `bech32` when already in that form (reuses the same string as the UI).
 */
export function formatXFabricIdentityValue (identity: {
  id?: string;
  bech32?: string;
  publicKeyHex?: string;
}): string {
  if (typeof identity.id === 'string' && isFabricIdBech32m(identity.id)) {
    return identity.id;
  }
  if (typeof identity.bech32 === 'string' && isFabricIdBech32m(identity.bech32)) {
    return identity.bech32;
  }
  if (typeof identity.publicKeyHex === 'string') {
    const fromPk = publicKeyHexToIdBech32m(identity.publicKeyHex);
    if (fromPk) return fromPk;
  }
  if (typeof identity.id === 'string' && identity.id.length > 0) {
    return identity.id;
  }
  return 'unknown';
}
