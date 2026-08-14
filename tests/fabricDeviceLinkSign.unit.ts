'use strict';

import assert from 'assert';
import { buildDeviceLinkMessage, buildDeviceLinkOfferMessage, httpsLandingUrl } from '../src/utils/fabricDeviceLinkSign';

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

  it('builds offer messages and HTTPS landings', function () {
    const nonce = 'ee'.repeat(32);
    const msg = buildDeviceLinkOfferMessage(nonce, 'id1aaa', 'Passport', 'https://relay.goon.vc');
    assert.ok(msg.startsWith('fabric:device-link:1:offer:'));
    assert.ok(msg.includes('Passport'));
    assert.strictEqual(
      httpsLandingUrl('https://relay.goon.vc', 'aa'.repeat(24)),
      'https://relay.goon.vc/#device-link=' + encodeURIComponent('aa'.repeat(24))
    );
  });
});
