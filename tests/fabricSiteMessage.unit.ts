'use strict';

import assert from 'assert';
import {
  buildDesktopSignRequest,
  checkHubLoginChallenge,
  isSignableSiteOrigin,
  originOfSender,
  readPageSiteLoginRequest,
  signPassportSiteLogin,
  verifyDesktopSiteLogin
} from '../src/utils/fabricSiteMessage';
import {
  discoverDesktopSigners,
  normalizeDesktopSignerBase,
  parseDesktopSignerBases,
  requestDesktopLink,
  requestDesktopSignature
} from '../src/utils/fabricDesktopSigner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { siteLogin, Key } = require('../src/utils/loadFabricSiteLogin');

const SITE = 'https://shop.example';

function jsonResponse (status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

describe('fabricSiteMessage', function () {
  it('takes the origin from the browser, never the page', function () {
    assert.strictEqual(originOfSender({ origin: 'https://shop.example', url: 'https://other.example/x' }), SITE);
    assert.strictEqual(originOfSender({ url: 'https://shop.example/login?x=1' }), SITE);
    assert.strictEqual(originOfSender({ origin: 'null', url: 'file:///tmp/x.html' }), null);
    assert.strictEqual(isSignableSiteOrigin('http://127.0.0.1:3000'), true);
    assert.strictEqual(isSignableSiteOrigin('http://shop.example'), false);
  });

  it('rebuilds an unsigned request with the real origin and refuses a site-signed mismatch', function () {
    const unsigned = siteLogin.createSiteLoginRequest({ origin: 'https://claimed.example', purpose: 'Sign in' });
    const read = readPageSiteLoginRequest(unsigned.uri, SITE);
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.strictEqual(read.request.origin, SITE);
    assert.strictEqual(read.request.nonce, unsigned.nonce);
    assert.strictEqual(read.request.purpose, 'Sign in');
    assert.strictEqual(siteLogin.readSiteLoginRequest(read.request.requestUri).request.origin, SITE);

    const signed = siteLogin.createSiteLoginRequest({ origin: 'https://claimed.example' }, new Key());
    const refused = readPageSiteLoginRequest(signed.uri, SITE);
    assert.ok(!refused.ok);
    if (!refused.ok) assert.strictEqual(refused.error, 'origin_mismatch');

    assert.ok(!readPageSiteLoginRequest('fabric:' + 'A'.repeat(60000), SITE).ok);
    assert.ok(!readPageSiteLoginRequest(unsigned.uri, 'http://shop.example').ok);
  });

  it('checks a legacy hub-login challenge against the page session and origin', function () {
    const sessionId = 'cd'.repeat(24);
    const nonce = 'ab'.repeat(32);
    const message = `fabric:hub-login:1:${nonce}:${sessionId}:${SITE}`;
    const ok = checkHubLoginChallenge(message, { sessionId, origin: SITE });
    assert.ok(ok.ok);
    if (ok.ok) assert.strictEqual(ok.nonce, nonce);
    const wrongSite = checkHubLoginChallenge(message, { sessionId, origin: 'https://evil.example' });
    assert.ok(!wrongSite.ok);
    const wrongSession = checkHubLoginChallenge(message, { sessionId: 'ee'.repeat(24), origin: SITE });
    assert.ok(!wrongSession.ok);
    assert.ok(!checkHubLoginChallenge('fabric:device-link:1:whatever', { sessionId, origin: SITE }).ok);
  });

  it('signs a response with the Passport key that the site can verify', function () {
    const passport = new Key();
    const request = siteLogin.createSiteLoginRequest({ origin: SITE });
    const signed = signPassportSiteLogin({ origin: SITE, nonce: request.nonce, privateKeyHex: passport.private.toString('hex') });
    const verified = siteLogin.verifySiteLoginResponse(signed.uri, { origin: SITE, nonce: request.nonce });
    assert.strictEqual(verified.ok, true, verified.error);
    assert.strictEqual(verified.identity.pubkey, passport.pubkey);
    assert.strictEqual(verified.signer, 'passport');
    assert.strictEqual(verified.identity.xpub, null);
  });

  it('wraps the site request for a desktop and accepts only that desktop key back', function () {
    const passport = new Key();
    const desktop = new Key();
    const request = siteLogin.createSiteLoginRequest({ origin: SITE });
    const wrapped = buildDesktopSignRequest({
      origin: SITE,
      nonce: request.nonce,
      requestUri: request.uri,
      privateKeyHex: passport.private.toString('hex')
    });
    const read = siteLogin.readFabricSignRequest(wrapped.uri);
    assert.strictEqual(read.ok, true, read.error);
    assert.strictEqual(read.author, passport.pubkey.slice(2));
    assert.strictEqual(read.request.nonce, request.nonce);

    const response = siteLogin.signSiteLoginResponse({ origin: SITE, nonce: request.nonce, signer: 'hub' }, desktop);
    assert.ok(verifyDesktopSiteLogin(response.uri, { origin: SITE, nonce: request.nonce, pubkey: desktop.pubkey }).ok);
    const other = verifyDesktopSiteLogin(response.uri, { origin: SITE, nonce: request.nonce, pubkey: passport.pubkey });
    assert.ok(!other.ok);
    const passportSigned = siteLogin.signSiteLoginResponse({ origin: SITE, nonce: request.nonce, signer: 'passport' }, desktop);
    assert.ok(!verifyDesktopSiteLogin(passportSigned.uri, { origin: SITE, nonce: request.nonce, pubkey: desktop.pubkey }).ok);
  });
});

describe('fabricDesktopSigner', function () {
  it('accepts only loopback bases', function () {
    assert.strictEqual(normalizeDesktopSignerBase('8080'), 'http://127.0.0.1:8080');
    assert.strictEqual(normalizeDesktopSignerBase('localhost:3041'), 'http://localhost:3041');
    assert.strictEqual(normalizeDesktopSignerBase('http://[::1]:3041/x'), 'http://[::1]:3041');
    assert.strictEqual(normalizeDesktopSignerBase('http://192.168.1.4:8080'), null);
    assert.strictEqual(normalizeDesktopSignerBase('https://hub.fabric.pub'), null);
    assert.strictEqual(normalizeDesktopSignerBase('http://user:pw@127.0.0.1:8080'), null);
    assert.deepStrictEqual(parseDesktopSignerBases('8080, 8080 3041'), ['http://127.0.0.1:8080', 'http://127.0.0.1:3041']);
  });

  it('discovers unlocked desktops and skips locked or broken ones', async function () {
    const desktop = new Key();
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      if (url.startsWith('http://127.0.0.1:8080')) {
        return jsonResponse(200, { ok: true, signer: 'hub', name: 'Fabric Hub', pubkey: desktop.pubkey, id: 'id1x', linked: true, locked: false });
      }
      if (url.startsWith('http://127.0.0.1:3041')) return jsonResponse(200, { ok: true, signer: 'gooncitizen', locked: true });
      throw new Error('refused');
    };
    const found = await discoverDesktopSigners({
      bases: ['8080', '3041', '9999'],
      pubkey: desktop.pubkey,
      fetchImpl
    });
    assert.strictEqual(found.length, 1);
    assert.strictEqual(found[0].signer, 'hub');
    assert.strictEqual(found[0].linked, true);
    assert.ok(seen[0].includes(`pubkey=${desktop.pubkey}`));
  });

  it('posts the sign request as text and reports refusals', async function () {
    let body: unknown = null;
    const ok = await requestDesktopSignature({
      base: '8080',
      signRequestUri: 'fabric:abc',
      expiresAt: Date.now() + 60000,
      fetchImpl: async (_url: string, init?: RequestInit) => {
        body = init && init.body;
        return jsonResponse(200, { ok: true, fabric: 'fabric:def' });
      }
    });
    assert.deepStrictEqual(ok, { ok: true, uri: 'fabric:def' });
    assert.strictEqual(body, 'fabric:abc');
    const refused = await requestDesktopSignature({
      base: '8080',
      signRequestUri: 'fabric:abc',
      expiresAt: Date.now() + 60000,
      fetchImpl: async () => jsonResponse(403, { ok: false, error: 'declined on the desktop' })
    });
    assert.ok(!refused.ok);
    if (!refused.ok) assert.strictEqual(refused.error, 'declined on the desktop');
    const remote = await requestDesktopSignature({ base: 'https://hub.fabric.pub', signRequestUri: 'fabric:abc', expiresAt: Date.now() + 1000 });
    assert.ok(!remote.ok);
  });

  it('asks a loopback desktop to accept a link session and reports refusals', async function () {
    const sessionId = 'ab'.repeat(24);
    let seen: { url: string; body: unknown } | null = null;
    const ok = await requestDesktopLink({
      base: '8080',
      sessionId,
      fetchImpl: async (url: string, init?: RequestInit) => {
        seen = { url, body: init && init.body };
        return jsonResponse(200, { ok: true, status: 'accepted', signer: 'hub' });
      }
    });
    assert.deepStrictEqual(ok, { ok: true, signer: 'hub' });
    assert.deepStrictEqual(seen, { url: 'http://127.0.0.1:8080/services/fabric/link', body: JSON.stringify({ sessionId }) });
    const declined = await requestDesktopLink({
      base: '8080',
      sessionId,
      fetchImpl: async () => jsonResponse(403, { ok: false, error: 'declined on the desktop' })
    });
    assert.ok(!declined.ok);
    if (!declined.ok) assert.strictEqual(declined.error, 'declined on the desktop');
    assert.ok(!(await requestDesktopLink({ base: 'https://hub.fabric.pub', sessionId })).ok);
    assert.ok(!(await requestDesktopLink({ base: '8080', sessionId: 'nope' })).ok);
  });
});
