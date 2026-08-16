'use strict';

import assert from 'assert';
import { buildCrossSignMessage, buildRevokeMessage, CROSS_SIGN_PREFIX, SIGN_TYPE } from '../src/utils/identityCrossSign';

describe('identityCrossSign', function () {
  this.timeout(10000);

  it('builds the canonical GoonCitizen / Hub message', () => {
    const nonce = 'ab'.repeat(32);
    const local = 'aa'.repeat(32);
    const peer = 'bb'.repeat(32);
    const msg = buildCrossSignMessage(nonce, local, peer);
    assert.ok(msg);
    assert.ok(msg.startsWith(CROSS_SIGN_PREFIX + ':'));
    assert.strictEqual(SIGN_TYPE, 'IdentityCrossSign');
    const rev = buildRevokeMessage(nonce, local, peer);
    assert.ok(rev);
    assert.ok(rev.includes('revoke'));
    assert.strictEqual(buildCrossSignMessage('short', local, peer), null);
    assert.strictEqual(buildRevokeMessage(nonce, '', peer), null);
    assert.strictEqual(buildRevokeMessage('0x' + nonce, '0x' + local, peer), rev);
    assert.strictEqual(buildCrossSignMessage(nonce, 'aa:bb', peer), null);
    assert.strictEqual(buildCrossSignMessage(nonce, 'aa'.repeat(33), peer), null);
  });

  it('re-exports @fabric/core/functions/identityCrossSign', () => {
    const core = require('@fabric/core/functions/identityCrossSign');
    const nonce = 'ab'.repeat(32);
    const local = 'aa'.repeat(32);
    const peer = 'bb'.repeat(32);
    const msg = buildCrossSignMessage(nonce, local, peer);
    assert.ok(msg);
    assert.strictEqual(msg, core.buildCrossSignMessage(nonce, local, peer));
    assert.strictEqual(SIGN_TYPE, core.SIGN_TYPE);
  });

  it('this core pin rejects unknown kind and truncated identity-id hex', () => {
    const crypto = require('crypto');
    const Key = require('@fabric/core/types/key');
    const Identity = require('@fabric/core/types/identity');
    const { signCrossSign } = require('@fabric/core/functions/identityCrossSignVerify');
    const { fabricIdentityIdFromPubkeyHex } = require('@fabric/core/functions/fabricIdentitySchnorr');
    const ident = new Identity(new Key());
    const other = new Identity(new Key());
    assert.throws(
      () => signCrossSign(ident, {
        peerPubkey: other.pubkey,
        nonce: crypto.randomBytes(32).toString('hex')
      }, 'ChatMessage'),
      /unknown cross-sign type/i
    );
    assert.throws(() => fabricIdentityIdFromPubkeyHex('02aa'), /66 hex/i);
  });
});
