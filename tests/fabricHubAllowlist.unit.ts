'use strict';

import assert from 'assert';
import {
  assertAllowedFabricHub,
  isAllowedFabricHub,
  normalizeHubOrigin
} from '../src/utils/fabricHubAllowlist';

describe('fabricHubAllowlist (Passport)', function () {
  it('allows default hubs and loopback', function () {
    assert.strictEqual(isAllowedFabricHub('https://relay.goon.vc'), true);
    assert.strictEqual(isAllowedFabricHub('http://127.0.0.1:8080'), true);
  });

  it('rejects phishing hubs', function () {
    assert.strictEqual(isAllowedFabricHub('https://evil.example'), false);
    const bad = assertAllowedFabricHub('https://evil.example');
    assert.strictEqual(bad.ok, false);
  });

  it('normalizes origins', function () {
    assert.strictEqual(normalizeHubOrigin('https://hub.fabric.pub/sessions'), 'https://hub.fabric.pub');
    assert.strictEqual(normalizeHubOrigin('ftp://x'), null);
  });
});
