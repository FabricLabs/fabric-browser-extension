'use strict';

import { BIP32Factory, type TinySecp256k1Interface } from 'bip32';
import ecc from '@bitcoinerlab/secp256k1';

const bip32 = BIP32Factory(ecc as unknown as TinySecp256k1Interface);

/**
 * Validates an extended public key (xpub) using BIP32 format.
 * @param xpub The extended public key to validate
 * @returns boolean indicating if the xpub is valid
 */
export function validateXpub (xpub: string): boolean {
  try {
    // Check if xpub starts with the correct prefix
    if (!xpub.startsWith('xpub')) {
      return false;
    }

    // Try to parse the xpub using bip32
    const node = bip32.fromBase58(xpub);

    // Verify it's a public key (not private)
    if (!node.isNeutered()) {
      return false;
    }

    // Verify the key has a valid length (typically between 110-112 characters)
    if (xpub.length < 110 || xpub.length > 112) {
      return false;
    }

    return true;
  } catch (_error: unknown) {
    // If any error occurs during validation, the xpub is invalid
    return false;
  }
}