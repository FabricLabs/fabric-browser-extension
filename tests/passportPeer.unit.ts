'use strict';

import assert from 'assert';
import {
  cleanPeerEndpoints,
  identityScope,
  readPeerConnectRequest,
  signPassportAssertion,
  siteIdentityKey,
  verifyPageAssertion
} from '../src/utils/fabricSiteMessage';
import { peerTrustStatus, withSignIn } from '../src/utils/peerTrust';
import { jsonCallHash, newSessionKey, peerBase, sessionAnswersOrigin, signableTarget, type PeerSessionRecord } from '../src/background/passportPeerSessions';
import { PASSPORT_REQUEST_CONTRACT, createPeerRequest } from '../src/utils/passportPeerRequest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricPassport');
const { passport, accountKeys, Key } = core;

const PAGE = 'http://localhost:3000';
const NOW = 1_800_000_000_000;

function record (extra: Partial<PeerSessionRecord> = {}): PeerSessionRecord {
  return Object.assign({
    sessionId: 'ab'.repeat(32),
    origin: PAGE,
    peer: '02' + 'cd'.repeat(32),
    endpoint: 'ws://127.0.0.1:8080/',
    transport: 'ws',
    base: 'http://127.0.0.1:8080',
    sessionKey: '11'.repeat(32),
    sessionPubkey: '03' + 'ef'.repeat(32),
    identity: { id: 'id', pubkey: '02' + '00'.repeat(32) },
    network: 'regtest',
    disclosed: [],
    issuedAt: NOW,
    expiresAt: NOW + 60_000
  }, extra);
}

describe('Passport peer sessions', function () {
  it('the background accepts every runtime message the content script sends', function () {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path');
    const content = fs.readFileSync(path.join(__dirname, '../src/content.ts'), 'utf8');
    const background = fs.readFileSync(path.join(__dirname, '../src/background/fabricBackgroundRuntimeMessages.ts'), 'utf8');
    const allow = background.slice(background.indexOf('CONTENT_SCRIPT_MESSAGES'), background.indexOf(']);', background.indexOf('CONTENT_SCRIPT_MESSAGES')));
    const sent = new Set((content.match(/type: (FABRIC_RUNTIME_[A-Z_]+)/g) || []).map((m: string) => m.slice(6)));
    assert.ok(sent.size >= 5, 'found the content script\'s runtime messages');
    for (const name of sent) assert.ok(allow.includes(name), `${name} is allowed from content scripts`);
  });

  describe('page requests', function () {
    it('keeps ws/wss endpoints only, a compressed peer key, and known disclosures', function () {
      assert.deepStrictEqual(cleanPeerEndpoints(['wss://hub.example/', 'https://hub.example', 'ws://u:p@x.example', 'javascript:1', 'ftp://x.example', 'wss://hub.example/']), ['wss://hub.example/', 'https://hub.example/']);
      const read = readPeerConnectRequest({ endpoints: ['ws://127.0.0.1:8080'], peer: ('02' + 'aa'.repeat(32)).toUpperCase(), request: ['wallet', 'everything'], purpose: 'Hi‮' });
      assert.strictEqual(read.ok, true);
      if (!read.ok) return;
      assert.deepStrictEqual(read.connect.endpoints, ['ws://127.0.0.1:8080/']);
      assert.strictEqual(read.connect.peer, '02' + 'aa'.repeat(32));
      assert.deepStrictEqual(read.connect.request, ['wallet']);
      assert.strictEqual(read.connect.purpose, 'Hi');
      assert.deepStrictEqual(readPeerConnectRequest({ endpoints: [] }), { ok: false, error: 'no_endpoints' });
      assert.deepStrictEqual(readPeerConnectRequest({ endpoints: ['wss://x.example'], peer: 'nope' }), { ok: false, error: 'invalid_peer' });
    });
  });

  describe('trust', function () {
    const PEER = '02' + 'aa'.repeat(32);
    it('warns on a new peer, and on a new page for a known peer unless the peer lists it', function () {
      assert.strictEqual(peerTrustStatus({}, PEER, PAGE), 'new_peer');
      assert.strictEqual(peerTrustStatus({}, PEER, PAGE, [PAGE]), 'home');
      const once = withSignIn({}, PEER, PAGE, NOW, 'My Hub');
      assert.strictEqual(peerTrustStatus(once, PEER, PAGE), 'known');
      assert.strictEqual(peerTrustStatus(once, PEER, 'https://evil.example'), 'new_site');
      assert.strictEqual(peerTrustStatus(once, PEER, 'https://hub.example', ['https://hub.example']), 'known');
      const twice = withSignIn(once, PEER, 'https://hub.example', NOW + 1);
      assert.strictEqual(twice[PEER].name, 'My Hub', 'keeps the name');
      assert.strictEqual(twice[PEER].first, NOW);
      assert.deepStrictEqual(twice[PEER].origins, ['https://hub.example', PAGE]);
    });
  });

  describe('sessions', function () {
    it('answer only the origin that opened them, until they expire', function () {
      assert.deepStrictEqual(sessionAnswersOrigin(record(), PAGE, NOW), { ok: true });
      assert.deepStrictEqual(sessionAnswersOrigin(record(), 'https://evil.example', NOW), { ok: false, error: 'not_your_session' });
      assert.deepStrictEqual(sessionAnswersOrigin(record(), null, NOW), { ok: false, error: 'not_your_session' });
      assert.deepStrictEqual(sessionAnswersOrigin(record(), PAGE, NOW + 60_000), { ok: false, error: 'expired' });
      assert.deepStrictEqual(sessionAnswersOrigin(undefined, PAGE, NOW), { ok: false, error: 'unknown_session' });
    });

    it('signs requests only for the peer\'s own origin, as path and query', function () {
      assert.strictEqual(peerBase('wss://relay.goon.vc/'), 'https://relay.goon.vc');
      assert.strictEqual(peerBase('ws://127.0.0.1:3041/x'), 'http://127.0.0.1:3041');
      assert.strictEqual(peerBase('https://goon.vc/'), 'https://goon.vc');
      assert.strictEqual(peerBase('ftp://x'), null);
      assert.deepStrictEqual(signableTarget(record(), 'http://127.0.0.1:8080/services/x?y=1#frag'), { ok: true, target: '/services/x?y=1' });
      assert.deepStrictEqual(signableTarget(record(), 'https://evil.example/services/x'), { ok: false, error: 'not_this_peer' });
      assert.deepStrictEqual(signableTarget(record(), 'not a url'), { ok: false, error: 'invalid_url' });
    });

    it('signs request authorizations the @fabric/http peer accepts', function () {
      const sessionKey = new Key();
      const peer = '02' + 'cd'.repeat(32);
      const r = createPeerRequest({ sessionId: 'ab'.repeat(32), peer, method: 'post', target: '/x?y=1', body: '{"a":1}', now: NOW }, sessionKey);
      const decoded = core.fabricUri.decodeFabricUri(r.uri, { allowedTypes: ['CONTRACT_MESSAGE'] });
      assert.strictEqual(decoded.ok, true);
      const fields = decoded.message.toFields();
      assert.strictEqual(fields.contract, PASSPORT_REQUEST_CONTRACT);
      assert.strictEqual(fields.recipient, peer);
      const payload = JSON.parse(fields.payload);
      assert.strictEqual(payload.method, 'POST');
      assert.strictEqual(payload.target, '/x?y=1');
      assert.strictEqual(decoded.author, String(sessionKey.pubkey).slice(2));
      // When a local @fabric/http is available, its reader takes this frame as is.
      let reader: any = null;
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        reader = require(`${process.env.FABRIC_HTTP || '../../fabric-http'}/functions/passportPeerRequest`);
      } catch {
        reader = null;
      }
      if (reader) {
        assert.strictEqual(reader.PASSPORT_REQUEST_CONTRACT, PASSPORT_REQUEST_CONTRACT);
        const read = reader.readPeerRequest(r.uri, { peer, method: 'POST', target: '/x?y=1', body: '{"a":1}', now: NOW });
        assert.strictEqual(read.ok, true, read.error);
      }
    });

    it('keeps a session key that signs as the pubkey the sign-in named', function () {
      const made = newSessionKey();
      assert.match(made.privateHex, /^[0-9a-f]{64}$/);
      assert.strictEqual(String(new Key({ private: made.privateHex }).pubkey).toLowerCase(), made.pubkey);
    });

    it('correlates calls the way @fabric/http does (sha256 of the sha256 hex)', async function () {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const crypto = require('crypto');
      const body = '{"method":"Whoami","params":[]}';
      const preimage = crypto.createHash('sha256').update(body).digest('hex');
      assert.strictEqual(await jsonCallHash(body), crypto.createHash('sha256').update(preimage).digest('hex'));
    });
  });

  describe('signing', function () {
    before(function () {
      if (!passport || typeof passport.createPeerChallenge !== 'function') this.skip();
    });

    it('signs for the peer with a per-peer pairwise identity, and verifies the audience and session key', function () {
      const master = accountKeys.importSeed(accountKeys.generateMnemonic());
      const peerKey = new Key();
      const sessionKey = new Key();
      const peer = String(peerKey.pubkey).toLowerCase();
      const c = passport.createPeerChallenge({ clientNonce: 'aa'.repeat(32), origin: PAGE, network: 'regtest' }, peerKey);
      const signed = signPassportAssertion({
        challenge: c.uri,
        origin: PAGE,
        masterXprv: master,
        account: 0,
        network: 'regtest',
        pairwise: true,
        peer,
        sessionKey: sessionKey.pubkey
      });
      const pairwise = siteIdentityKey(master, { account: 0, network: 'regtest' }, identityScope({ origin: PAGE, peer }), true);
      assert.strictEqual(signed.identity.pubkey, pairwise.pubkey, 'pairwise by peer, not page');
      assert.notStrictEqual(pairwise.pubkey, siteIdentityKey(master, { account: 0, network: 'regtest' }, PAGE, true).pubkey);

      const expected = { origin: PAGE, peer, sessionKey: sessionKey.pubkey, nonce: c.nonce, challengeHash: c.hash, challengeExpiresAt: c.expiresAt, network: 'regtest', allow: [], signers: ['passport'] };
      const ok = verifyPageAssertion(signed.uri, expected);
      assert.strictEqual(ok.ok, true, ok.ok ? '' : ok.error);
      const otherKey = verifyPageAssertion(signed.uri, Object.assign({}, expected, { sessionKey: new Key().pubkey }));
      assert.deepStrictEqual(otherKey, { ok: false, error: 'the assertion names another session key' });
      const otherPeer = verifyPageAssertion(signed.uri, Object.assign({}, expected, { peer: String(new Key().pubkey) }));
      assert.strictEqual(otherPeer.ok, false);
    });
  });
});
