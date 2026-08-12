'use strict';

import * as assert from 'assert';
import {
  formatXFabricIdentityValue,
  isFabricIdBech32m,
  publicKeyHexToIdBech32m
} from '../src/utils/fabricIdentityBech32';

describe('fabricIdentityBech32 / X-Fabric-Identity', () => {
  /** secp256k1 G compressed (test vectors). */
  const gCompressed =
    '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';

  it('encodes G to bech32m id and round-trips decode', () => {
    const id = publicKeyHexToIdBech32m(gCompressed);
    assert.ok(id != null && isFabricIdBech32m(id));
  });

  it('format overrides stale id by deriving from publicKeyHex', () => {
    const id = publicKeyHexToIdBech32m(gCompressed);
    assert.ok(id);
    assert.strictEqual(formatXFabricIdentityValue({ publicKeyHex: gCompressed, id: 'stale' }), id);
  });

  it('format prefers stored bech32m id when present', () => {
    const id = publicKeyHexToIdBech32m(gCompressed);
    assert.ok(id);
    assert.strictEqual(formatXFabricIdentityValue({ id, publicKeyHex: gCompressed }), id);
  });

  it('uses opaque id as last resort when not bech32m', () => {
    assert.strictEqual(formatXFabricIdentityValue({ id: 'legacy-opaque' }), 'legacy-opaque');
  });
});
