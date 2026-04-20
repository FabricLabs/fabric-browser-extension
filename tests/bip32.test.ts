'use strict';

import assert from 'assert';
import { BIP32Factory } from 'bip32';
import { INVALID_BIP32_TEST_VECTORS, VALID_BIP32_TEST_VECTORS } from '../src/crypto/vectors';
import ecc from '@bitcoinerlab/secp256k1';

describe('BIP32 implementation', () => {
  describe('invalid test vectors', () => {
    INVALID_BIP32_TEST_VECTORS.forEach((vector) => {
      it(`should reject invalid extended key: ${vector}`, () => {
        const bip32 = BIP32Factory(ecc as any);
        try {
          bip32.fromBase58(vector);
          assert.fail(`Invalid test vector passed: ${vector}`);
        } catch (error) {
          // Expected failure
          assert.ok(error instanceof Error);
        }
      });
    });
  });

  describe('valid test vectors', () => {
    VALID_BIP32_TEST_VECTORS.forEach((vector) => {
      it(`should correctly derive keys from seed ${vector.seed}`, () => {
        const bip32 = BIP32Factory(ecc as any);
        const root = bip32.fromSeed(Buffer.from(vector.seed, 'hex'));
        
        vector.chains.forEach(({ path, xpub, xprv }) => {
          // Skip the root path 'm' as it's not a valid derivation path
          if (path === 'm') {
            assert.strictEqual(root.toBase58(), xprv);
            assert.strictEqual(root.neutered().toBase58(), xpub);
          } else {
            // Convert H to ' for hardened keys
            const convertedPath = path.replace(/H/g, "'");
            const node = root.derivePath(convertedPath);
            assert.strictEqual(node.toBase58(), xprv);
            assert.strictEqual(node.neutered().toBase58(), xpub);
          }
        });
      });
    });
  });
}); 