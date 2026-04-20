'use strict';

// Dependencies
import assert from 'assert';
import { bech32m } from 'bech32';
import { VALID_BECH32_TEST_VECTORS, INVALID_BECH32_TEST_VECTORS } from '../src/crypto/vectors';

describe('bech32m implementation', () => {
  describe('invalid test vectors', () => {
    INVALID_BECH32_TEST_VECTORS.forEach(({ str, reason }) => {
      it(`should reject invalid vector: ${str} (${reason})`, () => {
          try {
          bech32m.decode(str);
          assert.fail(`Invalid test vector passed: ${str}`);
          } catch (error) {
          // Expected failure
          assert.ok(error instanceof Error);
          }
      });
    });
  });

  describe('valid test vectors', () => {
    VALID_BECH32_TEST_VECTORS.forEach((vector) => {
      it(`should correctly encode and decode ${vector}`, () => {
        try {
          const { prefix, words } = bech32m.decode(vector);
          const reencoded = bech32m.encode(prefix, words);
          assert.strictEqual(reencoded, vector.toLowerCase());
        } catch (error) {
          assert.fail(`Valid test vector failed: ${vector}\nError: ${error}`);
        }
      });
    });
  });
}); 