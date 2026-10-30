'use strict';

import assert from 'assert';
import {
  consentedDisclosures,
  isSignableSiteOrigin,
  originOfSender,
  readPageChallenge,
  signPassportAssertion,
  siteIdentityKey,
  verifyPageAssertion
} from '../src/utils/fabricSiteMessage';
import { pairwiseIndex } from '../src/utils/siteIdentity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricPassport');
const { passport, accountKeys, Key } = core;

const SITE = 'https://shop.example';

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

  it('accepts a linked signer\'s assertion only from its key, naming this Passport', function () {
    const master = newMaster();
    const delegate = new Key();
    const c = passport.createChallenge({ origin: SITE });
    const device = accountKeys.deriveAccount(master, { account: 1, network: 'mainnet' }).identity.pubkey;
    const answer = passport.signAssertion({ challenge: c.uri, origin: SITE, signer: 'hub', network: 'mainnet', device }, delegate);
    const ok = verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: delegate.pubkey, device });
    assert.ok(ok.ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: new Key().pubkey, device }).ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['hub'], pubkey: delegate.pubkey, device: new Key().pubkey }).ok);
    assert.ok(!verifyPageAssertion(answer.uri, { ...expectations(c), signers: ['gooncitizen'], pubkey: delegate.pubkey, device }).ok);
  });

  it('shows each new site its own identity and keeps the main one on request', function () {
    const master = newMaster();
    const pair = { account: 0, network: 'mainnet' };
    const main = accountKeys.deriveAccount(master, pair).identity.pubkey;
    const own = siteIdentityKey(master, pair, SITE, true).pubkey;
    const other = siteIdentityKey(master, pair, 'https://other.example', true).pubkey;
    assert.notStrictEqual(own, main);
    assert.notStrictEqual(own, other);
    assert.strictEqual(siteIdentityKey(master, pair, SITE, true).pubkey, own);
    assert.strictEqual(siteIdentityKey(master, pair, SITE, false).pubkey, main);
    assert.ok(pairwiseIndex(SITE) > 0 && pairwiseIndex(SITE) < 0x80000000);

    const c = passport.createChallenge({ origin: SITE });
    const signed = signPassportAssertion({ challenge: c.uri, origin: SITE, masterXprv: master, ...pair, pairwise: true });
    assert.strictEqual(signed.identity.pubkey, own);
    assert.ok(verifyPageAssertion(signed.uri, { ...expectations(c), signers: ['passport'] }).ok);
  });
});
