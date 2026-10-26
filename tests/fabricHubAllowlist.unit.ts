'use strict';

import assert from 'assert';
import {
  assertAllowedFabricHub,
  isAllowedFabricHub,
  lanHubPermissionPattern,
  normalizeHubOrigin,
  normalizeHttpsHostSuffix
} from '../src/utils/fabricHubAllowlist';

describe('fabricHubAllowlist (Passport)', function () {
  it('allows default HTTPS hubs', function () {
    assert.strictEqual(isAllowedFabricHub('https://hub.fabric.pub'), true);
    assert.strictEqual(isAllowedFabricHub('https://relay.goon.vc'), true);
    assert.strictEqual(isAllowedFabricHub('https://goon.vc'), true);
    assert.strictEqual(isAllowedFabricHub('https://hub.goon.vc'), true);
  });

  it('allows a loopback Hub only when it is the active Fabric node', function () {
    assert.strictEqual(isAllowedFabricHub('http://127.0.0.1:8080'), false);
    assert.strictEqual(isAllowedFabricHub('http://[::1]:3041'), false);
    assert.strictEqual(isAllowedFabricHub('http://127.0.0.1:8080', { activeHub: 'http://127.0.0.1:8080/' }), true);
    assert.strictEqual(isAllowedFabricHub('http://[::1]:3041', { activeHub: 'http://[::1]:3041' }), true);
    assert.strictEqual(isAllowedFabricHub('http://127.0.0.1:3041', { activeHub: 'http://127.0.0.1:8080' }), false);
    assert.strictEqual(isAllowedFabricHub('http://localhost:8080', { activeHub: 'http://127.0.0.1:8080' }), false);
  });

  it('names the host permission a cleartext LAN hub needs', function () {
    assert.strictEqual(lanHubPermissionPattern('http://192.168.1.20:8080'), 'http://192.168.1.20/*');
    assert.strictEqual(lanHubPermissionPattern('https://hub.example.org'), null);
    assert.strictEqual(lanHubPermissionPattern('http://127.0.0.1:8080'), null);
    assert.strictEqual(lanHubPermissionPattern('*.example.org'), null);
  });

  it('rejects cleartext production hubs unless explicitly allowlisted', function () {
    assert.strictEqual(isAllowedFabricHub('http://hub.fabric.pub'), false);
    assert.strictEqual(
      isAllowedFabricHub('http://hub.fabric.pub', { extra: ['http://hub.fabric.pub'] }),
      true
    );
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

  it('does not hardcode CDN previews; opt-in via extra / suffix', function () {
    const preview = 'https://pub-fabric-hub-git-feature-rsi-fabric-labs.vercel.app';
    assert.strictEqual(isAllowedFabricHub(preview), false);
    assert.strictEqual(isAllowedFabricHub(preview, { extra: ['*.vercel.app'] }), true);
    assert.strictEqual(isAllowedFabricHub(preview, { extra: [preview] }), true);
    assert.strictEqual(isAllowedFabricHub('http://x.vercel.app', { extra: ['*.vercel.app'] }), false);
    assert.strictEqual(normalizeHttpsHostSuffix('*.com'), null);
    assert.strictEqual(isAllowedFabricHub('https://evil.com', { extra: ['*.com'] }), false);
  });
});
