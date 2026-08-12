'use strict';

/**
 * Basics tied to SECURITY.md § Adversarial environment.
 */

import assert from 'assert';
import {
  assertAllowedFabricHub,
  isAllowedFabricHub,
  normalizeHubOrigin
} from '../src/utils/fabricHubAllowlist';

describe('adversarialEnvironment.basics (Passport)', function () {
  it('rejects phishing hubs for fabric login/link signing', function () {
    assert.strictEqual(isAllowedFabricHub('https://evil.example'), false);
    assert.strictEqual(isAllowedFabricHub('https://evil.example/sessions?x=1'), false);
    const bad = assertAllowedFabricHub('https://phishing.test');
    assert.strictEqual(bad.ok, false);
  });

  it('does not treat non-http(s) origins as hubs', function () {
    assert.strictEqual(normalizeHubOrigin('ftp://hub.fabric.pub'), null);
    assert.strictEqual(normalizeHubOrigin('javascript:alert(1)'), null);
  });
});
