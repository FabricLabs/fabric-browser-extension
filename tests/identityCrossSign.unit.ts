'use strict';

import assert from 'assert';
import { buildCrossSignMessage, buildRevokeMessage, CROSS_SIGN_PREFIX, SIGN_TYPE } from '../src/utils/identityCrossSign';

describe('identityCrossSign', () => {
  it('builds the canonical GoonCitizen / Hub message', () => {
    const nonce = 'ab'.repeat(32);
    const local = 'aa'.repeat(33);
    const peer = 'bb'.repeat(33);
    const msg = buildCrossSignMessage(nonce, local, peer);
    assert.ok(msg);
    assert.ok(msg.startsWith(CROSS_SIGN_PREFIX + ':'));
    assert.strictEqual(SIGN_TYPE, 'IdentityCrossSign');
    const rev = buildRevokeMessage(nonce, local, peer);
    assert.ok(rev);
    assert.ok(rev.includes('revoke'));
  });
});
