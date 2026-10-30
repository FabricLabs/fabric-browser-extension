'use strict';

import assert from 'assert';
import { openRecord, recordMacKey, sealRecord } from '../src/utils/recordSeal';

describe('recordSeal', function () {
  const master = 'xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi';

  it('opens a record only under the same master and name', async function () {
    const key = await recordMacKey(master);
    const sealed = await sealRecord(key, 'signers', [{ pubkey: '02' + 'ab'.repeat(32) }]);
    assert.deepStrictEqual(await openRecord(key, 'signers', sealed), [{ pubkey: '02' + 'ab'.repeat(32) }]);
    assert.strictEqual(await openRecord(key, 'other', sealed), null);
    const otherKey = await recordMacKey(master.replace(/.$/, 'j'));
    assert.strictEqual(await openRecord(otherKey, 'signers', sealed), null);
  });

  it('drops a record whose data was changed or that was never sealed', async function () {
    const key = await recordMacKey(master);
    const sealed = await sealRecord(key, 'hubs', ['https://hub.fabric.pub']);
    const forged = { ...sealed, data: ['https://evil.example'] };
    assert.strictEqual(await openRecord(key, 'hubs', forged), null);
    assert.strictEqual(await openRecord(key, 'hubs', ['https://evil.example']), null);
    assert.strictEqual(await openRecord(key, 'hubs', { ...sealed, mac: 'zz' }), null);
    assert.strictEqual(await openRecord(key, 'hubs', null), null);
  });

  it('needs an unlocked master', async function () {
    await assert.rejects(() => recordMacKey(''), /unlock/);
  });
});
