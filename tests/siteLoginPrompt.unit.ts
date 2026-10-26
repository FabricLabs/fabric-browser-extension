'use strict';

import assert from 'assert';
import { MAX_SITE_PURPOSE_CHARS, sanitizeSitePurpose } from '../src/utils/fabricSiteMessage';
import {
  buildPendingRow,
  checkSenderFrame,
  livePending,
  MAX_SEEN_NONCES,
  rememberNonce
} from '../src/background/fabricSiteLoginRuntime';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { passport } = require('../src/utils/loadFabricPassport');

const SITE = 'https://shop.example';
const REQUEST_ID = 'ef'.repeat(16);

function sender (over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    origin: SITE,
    frameId: 0,
    tab: { id: 7, url: `${SITE}/login`, title: 'Shop' } as chrome.tabs.Tab,
    ...over
  } as chrome.runtime.MessageSender;
}

describe('site-login prompt rules', function () {
  describe('sanitizeSitePurpose', function () {
    it('keeps plain text', function () {
      assert.strictEqual(sanitizeSitePurpose('Sign in to Shop'), 'Sign in to Shop');
    });

    it('drops direction overrides, invisible, and control characters', function () {
      assert.strictEqual(sanitizeSitePurpose('Pay \u202Egnp.exe\u202C now'), 'Pay gnp.exe now');
      assert.strictEqual(sanitizeSitePurpose('a\u200Bb\u2066c\u2069'), 'a b c');
      assert.strictEqual(sanitizeSitePurpose('line\none\r\n\ttwo\u0007'), 'line one two');
    });

    it('caps the length and refuses non-text', function () {
      const long = sanitizeSitePurpose('x'.repeat(500));
      assert.ok(long);
      assert.strictEqual(Array.from(long as string).length, MAX_SITE_PURPOSE_CHARS);
      assert.ok((long as string).endsWith('…'));
      assert.strictEqual(sanitizeSitePurpose(''), null);
      assert.strictEqual(sanitizeSitePurpose('\u200B\u202E'), null);
      assert.strictEqual(sanitizeSitePurpose({ toString: () => 'x' }), null);
    });

    it('is applied when a page challenge is queued', function () {
      const c = passport.createChallenge({ origin: SITE, purpose: 'Approve \u202Etxt.exe' });
      const built = buildPendingRow({ requestId: REQUEST_ID, challenge: c.uri }, sender());
      assert.strictEqual(built.ok, true);
      if (built.ok) assert.strictEqual(built.row.purpose, 'Approve txt.exe');
    });
  });

  describe('checkSenderFrame', function () {
    it('allows the top page and same-origin frames', function () {
      assert.deepStrictEqual(checkSenderFrame(sender()), { ok: true });
      assert.deepStrictEqual(checkSenderFrame(sender({ frameId: 3 })), { ok: true });
    });

    it('refuses a frame from another origin', function () {
      const framed = sender({ frameId: 3, origin: 'https://ads.example' });
      assert.deepStrictEqual(checkSenderFrame(framed), { ok: false, error: 'cross_origin_frame' });
      const unknownTop = sender({ frameId: 3, tab: { id: 7 } as chrome.tabs.Tab });
      assert.deepStrictEqual(checkSenderFrame(unknownTop), { ok: false, error: 'cross_origin_frame' });
    });
  });

  describe('buildPendingRow', function () {
    it('keys the row by tab and frame and binds it to the browser-reported origin', function () {
      const c = passport.createChallenge({ origin: SITE, request: ['wallet'], network: 'regtest' });
      const built = buildPendingRow({ requestId: REQUEST_ID, challenge: c.uri }, sender({ frameId: 2 }));
      assert.ok(built.ok);
      if (!built.ok) return;
      assert.strictEqual(built.row.key, '7:2');
      assert.strictEqual(built.row.origin, SITE);
      assert.strictEqual(built.row.nonce, c.nonce);
      assert.strictEqual(built.row.challengeHash, c.hash);
      assert.strictEqual(built.row.network, 'regtest');
      assert.deepStrictEqual(built.row.request, ['wallet']);
    });

    it('refuses challenges for another origin, bad request ids, and non-tab senders', function () {
      const c = passport.createChallenge({ origin: 'https://evil.example' });
      assert.ok(!buildPendingRow({ requestId: REQUEST_ID, challenge: c.uri }, sender()).ok);
      const mine = passport.createChallenge({ origin: SITE });
      assert.ok(!buildPendingRow({ requestId: 'short', challenge: mine.uri }, sender()).ok);
      assert.ok(!buildPendingRow({ requestId: REQUEST_ID, challenge: mine.uri }, sender({ tab: undefined })).ok);
    });
  });

  describe('rememberNonce', function () {
    it('accepts a nonce once until its challenge expires', function () {
      const first = rememberNonce({}, 'n1', 2_000, 1_000);
      assert.strictEqual(first.ok, true);
      assert.strictEqual(rememberNonce(first.seen, 'n1', 2_000, 1_500).ok, false);
      assert.strictEqual(rememberNonce(first.seen, 'n1', 3_000, 2_000).ok, true);
    });

    it('keeps at most MAX_SEEN_NONCES, dropping the soonest to expire', function () {
      const seen: Record<string, number> = {};
      for (let i = 0; i < MAX_SEEN_NONCES; i++) seen[`n${i}`] = 10_000 + i;
      const out = rememberNonce(seen, 'new', 50_000, 0);
      assert.strictEqual(out.ok, true);
      assert.strictEqual(Object.keys(out.seen).length, MAX_SEEN_NONCES);
      assert.ok(!('n0' in out.seen));
      assert.ok('new' in out.seen);
    });
  });

  describe('livePending', function () {
    it('drops expired and malformed rows', function () {
      const rows = [{ key: '1:0', expiresAt: 5_000 }, { key: '2:0', expiresAt: 1_000 }, null, { expiresAt: 9_000 }];
      assert.deepStrictEqual(livePending(rows, 2_000).map((r) => r.key), ['1:0']);
      assert.deepStrictEqual(livePending('nope', 2_000), []);
    });
  });
});
