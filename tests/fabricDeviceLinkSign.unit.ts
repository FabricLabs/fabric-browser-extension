'use strict';

import assert from 'assert';
import {
  buildDeviceLinkMessage,
  buildDeviceLinkOfferMessage,
  DEVICE_LINK_OFFER_TAG,
  DEVICE_LINK_TAG,
  httpsLandingUrl,
  keyFingerprint
} from '../src/utils/fabricDeviceLinkSign';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const httpMessages = require('@fabric/http/functions/fabricDeviceLinkMessages');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');

describe('fabricDeviceLinkSign', function () {
  const sessionId = '12'.repeat(24);
  const A = String(new Identity(new Key()).id);
  const B = String(new Identity(new Key()).id);

  const HUB = 'https://relay.goon.vc';

  it('builds session- and origin-bound mutual link messages (v3)', function () {
    const nonce = 'ab'.repeat(32);
    const msg = buildDeviceLinkMessage(sessionId, nonce, A, B, 'Passport', HUB);
    assert.strictEqual(msg, `fabric:device-link:3:link:${sessionId}:${nonce}:${A}:${B}:Passport:${HUB}`);
  });

  it('signs offers and links under their own tags', function () {
    const tags = require('@fabric/core/functions/signingTags');
    assert.strictEqual(DEVICE_LINK_OFFER_TAG, tags.DEVICE_LINK_OFFER);
    assert.strictEqual(DEVICE_LINK_TAG, tags.DEVICE_LINK);
    assert.notStrictEqual(DEVICE_LINK_OFFER_TAG, DEVICE_LINK_TAG);
  });

  it('shows a grouped key fingerprint', function () {
    assert.strictEqual(keyFingerprint('02' + 'ab'.repeat(32)), 'abab abab abab abab');
  });

  it('matches @fabric/http byte for byte', function () {
    const nonce = 'ab'.repeat(32);
    assert.strictEqual(
      buildDeviceLinkMessage(sessionId, nonce, A, B, 'Pass:port', HUB),
      httpMessages.buildDeviceLinkMessage(sessionId, nonce, A, B, 'Pass:port', HUB)
    );
    assert.strictEqual(
      buildDeviceLinkOfferMessage(sessionId, nonce, A, 'Passport', 'https://relay.goon.vc'),
      httpMessages.buildDeviceLinkOfferMessage(sessionId, nonce, A, 'Passport', 'https://relay.goon.vc')
    );
  });

  it('refuses a message without a session id', function () {
    assert.throws(() => buildDeviceLinkMessage('', 'ab'.repeat(32), A, B, 'x', HUB), /sessionId/);
    assert.throws(() => buildDeviceLinkOfferMessage('nope', 'ab'.repeat(32), A, 'x', 'https://a.b'), /sessionId/);
  });

  it('sanitizes colons in labels', function () {
    const nonce = 'cd'.repeat(32);
    const msg = buildDeviceLinkMessage(sessionId, nonce, A, B, 'Hub:browser', HUB);
    assert.ok(!msg.includes('Hub:browser'));
    assert.ok(msg.endsWith(`Hub-browser:${HUB}`));
  });

  it('builds offer messages and HTTPS landings', function () {
    const nonce = 'ee'.repeat(32);
    const msg = buildDeviceLinkOfferMessage(sessionId, nonce, A, 'Passport', 'https://relay.goon.vc');
    assert.ok(msg.startsWith(`fabric:device-link:3:offer:${sessionId}:`));
    assert.ok(msg.includes('Passport'));
    assert.strictEqual(
      httpsLandingUrl('https://relay.goon.vc', 'aa'.repeat(24)),
      'https://relay.goon.vc/#device-link=' + encodeURIComponent('aa'.repeat(24))
    );
  });
});
