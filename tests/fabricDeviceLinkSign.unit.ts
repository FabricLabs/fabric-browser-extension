'use strict';

import assert from 'assert';
import { buildDeviceLinkMessage } from '../src/utils/fabricDeviceLinkSign';

describe('fabricDeviceLinkSign', function () {
  it('builds canonical mutual link messages', function () {
    const nonce = 'ab'.repeat(32);
    const msg = buildDeviceLinkMessage(nonce, 'id1aaa', 'id1bbb', 'Passport');
    assert.strictEqual(msg, `fabric:device-link:1:${nonce}:id1aaa:id1bbb:Passport`);
  });

  it('sanitizes colons in labels', function () {
    const nonce = 'cd'.repeat(32);
    const msg = buildDeviceLinkMessage(nonce, 'id1a', 'id1b', 'Hub:browser');
    assert.ok(!msg.includes('Hub:browser'));
    assert.ok(msg.endsWith('Hub-browser'));
  });
});
