'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');
import { buildClientSignedBody, fabricSigningIdentity, parseHubLoginChallenge } from '../src/utils/fabricSiteLoginSign';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyIdentitySchnorr } = require('@fabric/http/functions/fabricSiteLoginVerify');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SIGNING_TAGS = require('@fabric/core/functions/signingTags');

describe('fabricSiteLoginSign', function () {
  it('reads origin and nonce from a /sessions challenge for its own session only', function () {
    const nonce = 'ab'.repeat(32);
    const sessionId = 'cd'.repeat(24);
    const message = `fabric:hub-login:1:${nonce}:${sessionId}:https://relay.goon.vc`;
    assert.deepStrictEqual(parseHubLoginChallenge(message, sessionId), { origin: 'https://relay.goon.vc', nonce });
    assert.strictEqual(parseHubLoginChallenge(message, 'ef'.repeat(24)), null);
    assert.strictEqual(parseHubLoginChallenge('fabric:hub-login:1:nope', sessionId), null);
  });

  it('signs under the given tag and verifies only under it', function () {
    const key = new Key();
    const ident = new Identity(key);
    const message = 'fabric:device-link:3:link:example';
    const body = buildClientSignedBody(message, SIGNING_TAGS.DEVICE_LINK, { xprv: key.xprv });
    assert.match(body.signature, /^[a-f0-9]{128}$/i);
    assert.strictEqual(body.pubkeyHex, ident.fabricKey.pubkey);
    assert.strictEqual(body.identity.xpub, ident.fabricKey.xpub);
    assert.strictEqual(String(body.identity.id), String(ident.id));
    const ok = verifyIdentitySchnorr(message, body.signature, body.pubkeyHex, body.identity, SIGNING_TAGS.DEVICE_LINK);
    assert.strictEqual(ok.ok, true);
    const other = verifyIdentitySchnorr(message, body.signature, body.pubkeyHex, body.identity, SIGNING_TAGS.DEVICE_LINK_OFFER);
    assert.strictEqual(other.ok, false);
  });

  it('refuses to sign without a tag', function () {
    const key = new Key();
    assert.throws(() => buildClientSignedBody('x', '', { xprv: key.xprv }), /tag/);
  });

  it('accepts Passport leaf privateKeyHex + fabric-path xpub', function () {
    const master = new Key();
    const ident = new Identity(master);
    const fabric = ident.fabricKey;
    const priv = Buffer.isBuffer(fabric.private)
      ? fabric.private.toString('hex')
      : String(fabric.private);
    const own = fabricSigningIdentity(priv, fabric.xpub);
    assert.strictEqual(own.id, String(ident.id));
    assert.strictEqual(own.pubkeyHex, fabric.pubkey);
    assert.strictEqual(own.xpub, fabric.xpub);
    const body = buildClientSignedBody('m', SIGNING_TAGS.DEVICE_LINK_OFFER, priv, fabric.xpub);
    assert.strictEqual(body.identity.id, String(ident.id));
  });
});
