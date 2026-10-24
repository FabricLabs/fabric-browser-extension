'use strict';

import assert from 'assert';
import { buildDeviceLinkMessage, buildDeviceLinkOfferMessage, httpsLandingUrl } from '../src/utils/fabricDeviceLinkSign';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpMessages = require('@fabric/http/functions/fabricDeviceLinkMessages');

describe('fabricDeviceLinkSign', function () {
  const sessionId = '12'.repeat(24);

  it('builds session-bound mutual link messages', function () {
    const nonce = 'ab'.repeat(32);
    const msg = buildDeviceLinkMessage(sessionId, nonce, 'id1aaa', 'id1bbb', 'Passport');
    assert.strictEqual(msg, `fabric:device-link:2:${sessionId}:${nonce}:id1aaa:id1bbb:Passport`);
  });

  it('matches @fabric/http byte for byte', function () {
    const nonce = 'ab'.repeat(32);
    assert.strictEqual(
      buildDeviceLinkMessage(sessionId, nonce, 'id1aaa', 'id1bbb', 'Pass:port'),
      httpMessages.buildDeviceLinkMessage(sessionId, nonce, 'id1aaa', 'id1bbb', 'Pass:port')
    );
    assert.strictEqual(
      buildDeviceLinkOfferMessage(sessionId, nonce, 'id1aaa', 'Passport', 'https://relay.goon.vc'),
      httpMessages.buildDeviceLinkOfferMessage(sessionId, nonce, 'id1aaa', 'Passport', 'https://relay.goon.vc')
    );
  });

  it('refuses a message without a session id', function () {
    assert.throws(() => buildDeviceLinkMessage('', 'ab'.repeat(32), 'id1a', 'id1b', 'x'), /sessionId/);
    assert.throws(() => buildDeviceLinkOfferMessage('nope', 'ab'.repeat(32), 'id1a', 'x', 'https://a.b'), /sessionId/);
  });

  it('sanitizes colons in labels', function () {
    const nonce = 'cd'.repeat(32);
    const msg = buildDeviceLinkMessage(sessionId, nonce, 'id1a', 'id1b', 'Hub:browser');
    assert.ok(!msg.includes('Hub:browser'));
    assert.ok(msg.endsWith('Hub-browser'));
  });

  it('builds offer messages and HTTPS landings', function () {
    const nonce = 'ee'.repeat(32);
    const msg = buildDeviceLinkOfferMessage(sessionId, nonce, 'id1aaa', 'Passport', 'https://relay.goon.vc');
    assert.ok(msg.startsWith(`fabric:device-link:2:offer:${sessionId}:`));
    assert.ok(msg.includes('Passport'));
    assert.strictEqual(
      httpsLandingUrl('https://relay.goon.vc', 'aa'.repeat(24)),
      'https://relay.goon.vc/#device-link=' + encodeURIComponent('aa'.repeat(24))
    );
  });
});
