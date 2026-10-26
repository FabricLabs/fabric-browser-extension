'use strict';

import assert from 'assert';
import sinon from 'sinon';
import {
  buildDesktopSignRequest,
  consentedDisclosures,
  isSignableSiteOrigin,
  originOfSender,
  pairingCode,
  readPageChallenge,
  signPassportAssertion,
  verifyPageAssertion
} from '../src/utils/fabricSiteMessage';
import {
  discoverDesktopSigners,
  KEEPALIVE_EVERY_MS,
  normalizeDesktopSignerBase,
  parseDesktopSignerBases,
  pinsForChallenge,
  requestDesktopLink,
  requestDesktopSignature,
  desktopRefusalError,
  DESKTOP_OUTDATED_ERROR,
  type DesktopPin
} from '../src/utils/fabricDesktopSigner';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricPassport');
const { passport, accountKeys, Key } = core;

const SITE = 'https://shop.example';

function jsonResponse (status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function newMaster (): string {
  return accountKeys.importSeed(accountKeys.generateMnemonic());
}

function expectations (c: { nonce: string; hash: string; expiresAt: number; network: string | null; request: string[] }) {
  return {
    origin: SITE,
    nonce: c.nonce,
    challengeHash: c.hash,
    challengeExpiresAt: c.expiresAt,
    network: c.network,
    allow: c.request
  };
}

describe('fabricSiteMessage', function () {
  before(function () {
    if (!passport) this.skip();
  });

  it('takes the origin from the browser, never the page', function () {
    assert.strictEqual(originOfSender({ origin: 'https://shop.example', url: 'https://other.example/x' }), SITE);
    assert.strictEqual(originOfSender({ url: 'https://shop.example/login?x=1' }), SITE);
    assert.strictEqual(originOfSender({ origin: 'null', url: 'file:///tmp/x.html' }), null);
    assert.strictEqual(isSignableSiteOrigin('http://127.0.0.1:3000'), true);
    assert.strictEqual(isSignableSiteOrigin('http://shop.example'), false);
  });

  it('reads a challenge only for the origin the browser reported', function () {
    const c = passport.createChallenge({ origin: SITE, purpose: 'Sign in', request: ['wallet'] });
    const read = readPageChallenge(c.uri, SITE);
    assert.ok(read.ok);
    if (!read.ok) return;
    assert.strictEqual(read.challenge.nonce, c.nonce);
    assert.strictEqual(read.challenge.hash, c.hash);
    assert.deepStrictEqual(read.challenge.request, ['wallet']);
    assert.strictEqual(read.challenge.siteAuthor, null);

    const elsewhere = readPageChallenge(c.uri, 'https://evil.example');
    assert.ok(!elsewhere.ok);
    if (!elsewhere.ok) assert.strictEqual(elsewhere.error, 'origin_mismatch');
    assert.ok(!readPageChallenge('fabric:' + 'A'.repeat(60000), SITE).ok);
    assert.ok(!readPageChallenge(c.uri, 'http://shop.example').ok);
    const expired = passport.createChallenge({ origin: SITE, now: Date.now() - 10 * 60 * 1000, ttlMs: 60000 });
    assert.ok(!readPageChallenge(expired.uri, SITE).ok);
  });

  it('signs with the chosen account and shares only what was asked and ticked', function () {
    const master = newMaster();
    const c = passport.createChallenge({ origin: SITE, request: ['wallet', 'cosigner'] });
    const disclose = consentedDisclosures(c.request, ['cosigner', 'wallet', 'nonsense']);
    assert.deepStrictEqual(disclose, ['wallet', 'cosigner']);
    assert.deepStrictEqual(consentedDisclosures(['wallet'], ['cosigner']), []);

    const signed = signPassportAssertion({ challenge: c.uri, origin: SITE, masterXprv: master, account: 2, network: 'testnet', disclose });
    const keys = accountKeys.deriveAccount(master, { account: 2, network: 'testnet' });
    assert.strictEqual(signed.identity.pubkey, keys.identity.pubkey);
    const verified = verifyPageAssertion(signed.uri, { ...expectations(c), signers: ['passport'] });
    assert.ok(verified.ok);
    if (!verified.ok) return;
    assert.strictEqual(verified.assertion.network, 'testnet');
    assert.deepStrictEqual(verified.assertion.disclosed, ['wallet', 'cosigner']);

    const quiet = signPassportAssertion({ challenge: c.uri, origin: SITE, masterXprv: master, account: 0, network: 'mainnet' });
    const plain = verifyPageAssertion(quiet.uri, { ...expectations(c), signers: ['passport'] });
    assert.ok(plain.ok);
    if (plain.ok) assert.deepStrictEqual(plain.assertion.disclosed, []);
    assert.notStrictEqual(quiet.identity.pubkey, signed.identity.pubkey);
  });

  it('refuses an assertion for another sign-in or from the wrong signer', function () {
    const master = newMaster();
    const c = passport.createChallenge({ origin: SITE });
    const other = passport.createChallenge({ origin: SITE });
    const signed = signPassportAssertion({ challenge: c.uri, origin: SITE, masterXprv: master, account: 0, network: 'mainnet' });
    assert.ok(!verifyPageAssertion(signed.uri, { ...expectations(other), signers: ['passport'] }).ok);
    assert.ok(!verifyPageAssertion(signed.uri, { ...expectations(c), signers: ['hub'] }).ok);
    const pinned = verifyPageAssertion(signed.uri, { ...expectations(c), signers: ['passport'], pubkey: new Key().pubkey });
    assert.ok(!pinned.ok);
  });

  it('refuses to sign for another network than the challenge names', function () {
    const c = passport.createChallenge({ origin: SITE, network: 'regtest' });
    assert.throws(() => signPassportAssertion({ challenge: c.uri, origin: SITE, masterXprv: newMaster(), account: 0, network: 'mainnet' }), /regtest/);
  });

  it('wraps a challenge for a desktop with the linked account and accepts only the pinned key and device', function () {
    const master = newMaster();
    const desktop = new Key();
    const c = passport.createChallenge({ origin: SITE });
    const wrapped = buildDesktopSignRequest({ challenge: c.uri, origin: SITE, masterXprv: master, device: { account: 1, network: 'mainnet' } });
    const device = accountKeys.deriveAccount(master, { account: 1, network: 'mainnet' }).identity.pubkey;
    assert.strictEqual(wrapped.device, device);
    const read = passport.readSignRequest(wrapped.uri);
    assert.strictEqual(read.ok, true, read.error);
    assert.strictEqual(read.author, device.slice(2));

    const answer = passport.signAssertion({ challenge: c.uri, origin: SITE, signer: 'hub', network: 'mainnet', device }, desktop);
    const ok = verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: desktop.pubkey, device });
    assert.ok(ok.ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: new Key().pubkey, device }).ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: desktop.pubkey, device: new Key().pubkey }).ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['gooncitizen'], pubkey: desktop.pubkey, device }).ok);
  });

  it('shows the same pairing code on both devices', function () {
    const a = new Key().pubkey;
    const b = new Key().pubkey;
    assert.match(pairingCode(a, b), /^\d{6}$/);
    assert.strictEqual(pairingCode(a, b), pairingCode(b, a));
    assert.notStrictEqual(pairingCode(a, b), pairingCode(a, new Key().pubkey));
  });
});

describe('desktop pins', function () {
  const pin = (network: string): DesktopPin => ({
    base: 'http://127.0.0.1:8080',
    signer: 'hub',
    name: null,
    pubkey: '02' + 'ab'.repeat(32),
    network,
    device: { account: 0, network: 'mainnet', pubkey: '03' + 'cd'.repeat(32) },
    pinnedAt: 1
  });

  it('offers a desktop only for challenges on its own network', function () {
    assert.strictEqual(pinsForChallenge([pin('regtest')], 'mainnet').length, 0);
    assert.strictEqual(pinsForChallenge([pin('regtest')], 'regtest').length, 1);
    assert.strictEqual(pinsForChallenge([pin('regtest')], null).length, 1);
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

  it('asks for a desktop update when a pre-v2 desktop refuses', async function () {
    const v1 = await requestDesktopSignature({
      base: '8080',
      signRequestUri: 'fabric:abc',
      expiresAt: Date.now() + 60000,
      fetchImpl: async () => jsonResponse(403, { ok: false, error: 'web pages cannot call the local signer' })
    });
    assert.ok(!v1.ok);
    if (!v1.ok) assert.strictEqual(v1.error, DESKTOP_OUTDATED_ERROR);
    assert.strictEqual(desktopRefusalError(400, 'unknown message type 16962'), DESKTOP_OUTDATED_ERROR);
    assert.strictEqual(desktopRefusalError(426, 'passport_outdated'), DESKTOP_OUTDATED_ERROR);
    assert.strictEqual(desktopRefusalError(403, 'declined on the desktop'), 'declined on the desktop');
    assert.strictEqual(desktopRefusalError(500, undefined), 'desktop refused (HTTP 500)');
  });

  it('keeps the extension worker alive while the desktop user decides', async function () {
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'] });
    let pings = 0;
    (globalThis as { chrome?: unknown }).chrome = { runtime: { getPlatformInfo: (cb: () => void) => { pings++; cb(); } } };
    try {
      let answer: (r: Response) => void = () => {};
      const pending = requestDesktopSignature({
        base: '8080',
        signRequestUri: 'fabric:abc',
        expiresAt: Date.now() + 120000,
        fetchImpl: () => new Promise<Response>((resolve) => { answer = resolve; })
      });
      await clock.tickAsync(KEEPALIVE_EVERY_MS * 3 + 1);
      assert.strictEqual(pings, 3);
      answer(jsonResponse(200, { ok: true, fabric: 'fabric:def' }));
      assert.deepStrictEqual(await pending, { ok: true, uri: 'fabric:def' });
      await clock.tickAsync(KEEPALIVE_EVERY_MS * 3);
      assert.strictEqual(pings, 3);
    } finally {
      clock.restore();
      delete (globalThis as { chrome?: unknown }).chrome;
    }
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
    assert.deepStrictEqual(ok, { ok: true, signer: 'hub', code: null, pubkey: null });
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
