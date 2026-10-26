'use strict';

import assert from 'assert';
import { MAX_SITE_PURPOSE_CHARS, sanitizeSitePurpose } from '../src/utils/fabricSiteMessage';
import {
  checkSenderFrame,
  HUB_LOGIN_PROMPT_TTL_MS,
  queueFabricMessage,
  siteLoginPromptOpen,
  type PendingSiteLoginRow
} from '../src/background/fabricSiteLoginRuntime';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { siteLogin } = require('../src/utils/loadFabricSiteLogin');

const SITE = 'https://shop.example';

function sender (over: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return {
    origin: SITE,
    frameId: 0,
    tab: { id: 7, url: `${SITE}/login` } as chrome.tabs.Tab,
    ...over
  } as chrome.runtime.MessageSender;
}

function row (over: Partial<PendingSiteLoginRow> = {}): PendingSiteLoginRow {
  return {
    kind: 'fabric',
    origin: SITE,
    pageOrigin: SITE,
    nonce: 'ab'.repeat(32),
    createdAt: 1_000,
    sessionId: '',
    hubBase: '',
    message: '',
    ...over
  };
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

    it('is applied when a page request is queued', function () {
      const request = siteLogin.createSiteLoginRequest({ origin: SITE, purpose: 'Approve \u202Etxt.exe' });
      const queued = queueFabricMessage({ message: request.uri, id: 'r1' }, sender());
      assert.strictEqual(queued.ok, true);
      if (queued.ok) assert.strictEqual(queued.row.purpose, 'Approve txt.exe');
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

  describe('siteLoginPromptOpen', function () {
    it('is busy while a request is waiting and free once it expires', function () {
      assert.strictEqual(siteLoginPromptOpen(null, 2_000), false);
      assert.strictEqual(siteLoginPromptOpen(row({ expiresAt: 5_000 }), 2_000), true);
      assert.strictEqual(siteLoginPromptOpen(row({ expiresAt: 5_000 }), 5_000), false);
    });

    it('gives a /sessions sign-in (no expiry) a fixed window', function () {
      const hub = row({ kind: 'hub-login', expiresAt: undefined, createdAt: 1_000 });
      assert.strictEqual(siteLoginPromptOpen(hub, 1_000 + HUB_LOGIN_PROMPT_TTL_MS - 1), true);
      assert.strictEqual(siteLoginPromptOpen(hub, 1_000 + HUB_LOGIN_PROMPT_TTL_MS), false);
    });
  });
});
