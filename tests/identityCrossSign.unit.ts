'use strict';

import assert from 'assert';
import {
  buildCrossSignMessage,
  buildRevokeMessage,
  CROSS_SIGN_PREFIX,
  CROSS_SIGN_TAG,
  REVOKE_TAG,
  REVOKE_TYPE,
  SIGN_TYPE,
  signCrossSign,
  verifyCrossSignObject
} from '../src/utils/identityCrossSign';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');

describe('identityCrossSign', function () {
  this.timeout(10000);

  const binding = {
    sessionId: '12'.repeat(24),
    nonce: 'ab'.repeat(32),
    origin: 'https://relay.goon.vc'
  };
  const local = '02' + 'aa'.repeat(32);
  const peer = '03' + 'bb'.repeat(32);

  it('builds the v2 message naming the session and the Hub origin', () => {
    const msg = buildCrossSignMessage({ ...binding, localPubkey: local, peerPubkey: peer });
    assert.strictEqual(
      msg,
      `${CROSS_SIGN_PREFIX}:${binding.sessionId}:${binding.nonce}:${local}:${peer}:${binding.origin}`
    );
    assert.strictEqual(SIGN_TYPE, 'IdentityCrossSign');
    const rev = buildRevokeMessage({ ...binding, localPubkey: local, peerPubkey: peer, revokedAt: 1700000000000 });
    assert.ok(rev && rev.includes('revoke'));
    assert.notStrictEqual(CROSS_SIGN_TAG, REVOKE_TAG);
  });

  it('refuses fields without a session, origin, or well-formed keys', () => {
    assert.strictEqual(buildCrossSignMessage({ ...binding, sessionId: '', localPubkey: local, peerPubkey: peer }), null);
    assert.strictEqual(buildCrossSignMessage({ ...binding, origin: '', localPubkey: local, peerPubkey: peer }), null);
    assert.strictEqual(buildCrossSignMessage({ ...binding, localPubkey: 'aa:bb', peerPubkey: peer }), null);
    assert.strictEqual(buildCrossSignMessage({ ...binding, localPubkey: local, peerPubkey: local }), null);
  });

  it('signs with the Fabric key and verifies only for that session', () => {
    const key = new Key();
    const ident = new Identity(key);
    const other = new Identity(new Key());
    const signed = signCrossSign({ xprv: key.xprv }, { ...binding, peerPubkey: other.fabricKey.pubkey });
    assert.strictEqual(signed.localPubkey, ident.fabricKey.pubkey);
    assert.strictEqual(signed.sessionId, binding.sessionId);
    assert.strictEqual(verifyCrossSignObject(signed).ok, true);
    assert.strictEqual(verifyCrossSignObject({ ...signed, sessionId: '34'.repeat(24) }).ok, false);
    assert.strictEqual(verifyCrossSignObject({ ...signed, origin: 'https://hub.fabric.pub' }).ok, false);
    assert.strictEqual(verifyCrossSignObject({ ...signed, type: REVOKE_TYPE, '@type': REVOKE_TYPE }).ok, false);
  });

  it('refuses an unknown kind', () => {
    const key = new Key();
    const other = new Identity(new Key());
    assert.throws(
      () => signCrossSign({ xprv: key.xprv }, { ...binding, peerPubkey: other.fabricKey.pubkey }, 'ChatMessage'),
      /unknown cross-sign type/i
    );
  });
});
