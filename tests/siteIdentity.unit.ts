'use strict';

import assert from 'assert';
import { describeSite, lookalikeOf, pairwiseIndex, registrableDomain } from '../src/utils/siteIdentity';

describe('siteIdentity', function () {
  it('finds the registrable domain', function () {
    assert.strictEqual(registrableDomain('www.shop.example.com'), 'example.com');
    assert.strictEqual(registrableDomain('login.example.co.uk'), 'example.co.uk');
    assert.strictEqual(registrableDomain('example.com.au'), 'example.com.au');
    assert.strictEqual(registrableDomain('a.b.example.de'), 'example.de');
    assert.strictEqual(registrableDomain('127.0.0.1'), '127.0.0.1');
    assert.strictEqual(registrableDomain('localhost'), 'localhost');
  });

  it('splits the host for display and badges new sites', function () {
    const site = describeSite('https://login.hub.fabric.pub', [], []);
    assert.strictEqual(site.prefix, 'login.hub.');
    assert.strictEqual(site.registrable, 'fabric.pub');
    assert.strictEqual(site.firstSeen, true);
    assert.strictEqual(describeSite('https://hub.fabric.pub', [], ['https://hub.fabric.pub']).firstSeen, false);
    assert.strictEqual(describeSite('http://127.0.0.1:3000').port, ':3000');
  });

  it('warns about look-alikes of trusted or signed-in sites', function () {
    const known = ['https://hub.fabric.pub', 'https://goon.vc'];
    assert.strictEqual(lookalikeOf('fabrlc.pub', known), 'fabric.pub');
    const nested = describeSite('https://fabric.pub.example.com', known);
    assert.strictEqual(nested.registrable, 'example.com');
    assert.strictEqual(nested.prefix, 'fabric.pub.');
    assert.strictEqual(lookalikeOf('fabric.com', known), 'fabric.pub');
    assert.strictEqual(lookalikeOf('fabr1c.pub', known), 'fabric.pub');
    assert.strictEqual(lookalikeOf('fabric.pub', known), null);
    assert.strictEqual(lookalikeOf('example.org', known), null);
    assert.strictEqual(describeSite('https://xn--fabrc-qmc.pub', known).international, true);
  });

  it('derives a stable, non-zero pairwise index per origin', function () {
    const a = pairwiseIndex('https://shop.example');
    assert.strictEqual(pairwiseIndex('https://shop.example'), a);
    assert.notStrictEqual(pairwiseIndex('https://other.example'), a);
    assert.ok(a > 0 && a < 0x80000000);
  });
});
