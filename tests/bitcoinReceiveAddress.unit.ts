'use strict';

import assert from 'assert';
import { deriveReceiveAddress } from '../src/fabric/bitcoinService';
import { VALID_BIP32_TEST_VECTORS } from '../src/crypto/vectors';

describe('deriveReceiveAddress (xpub vs chain network)', () => {
  const mainnetXpub = VALID_BIP32_TEST_VECTORS[0].chains.find(c => c.path === 'm/0H')?.xpub;
  if (!mainnetXpub) throw new Error('missing test xpub');

  it('decodes mainnet-prefixed xpub and emits regtest bech32 when network is regtest', () => {
    const addr = deriveReceiveAddress(mainnetXpub, 'regtest', 0);
    assert.ok(addr, 'expected a receive address');
    assert.ok(addr!.startsWith('bcrt1'), `expected regtest address, got ${addr}`);
  });

  it('still works when network name is mainnet', () => {
    const addr = deriveReceiveAddress(mainnetXpub, 'mainnet', 0);
    assert.ok(addr, 'expected a receive address');
    assert.ok(addr!.startsWith('bc1'), `expected mainnet segwit, got ${addr}`);
  });

  it('returns null for non-integer or negative indexes', () => {
    assert.strictEqual(deriveReceiveAddress(mainnetXpub, 'regtest', -1), null);
    assert.strictEqual(deriveReceiveAddress(mainnetXpub, 'regtest', 1.5), null);
    assert.strictEqual(deriveReceiveAddress(mainnetXpub, 'regtest', Number.NaN), null);
  });
});
