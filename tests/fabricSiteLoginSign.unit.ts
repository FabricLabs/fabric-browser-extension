'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  verifyFabricDesktopLoginSignedPayload
} = require('@fabric/http/functions/fabricSiteLoginVerify');
import { buildClientSignedLoginBody } from '../src/utils/fabricSiteLoginSign';

describe('fabricSiteLoginSign', function () {
  it('builds a Hub-verifiable client login body from HD Key', function () {
    const key = new Key();
    const ident = new Identity(key);
    const message = 'fabric:hub-login:1:' + 'ab'.repeat(32) + ':' + 'cd'.repeat(24) + ':https://relay.goon.vc';
    const body = buildClientSignedLoginBody(message, { xprv: key.xprv });
    assert.match(body.signature, /^[a-f0-9]{128}$/i);
    assert.strictEqual(body.pubkeyHex, ident.fabricKey.pubkey);
    assert.ok(body.identity.id.startsWith('id1'));
    assert.strictEqual(body.identity.xpub, ident.fabricKey.xpub);
    assert.strictEqual(String(body.identity.id), String(ident.id));
    const verified = verifyFabricDesktopLoginSignedPayload({
      ...body,
      message
    }, { sessionId: 'cd'.repeat(24), origin: 'https://relay.goon.vc' });
    assert.strictEqual(verified.ok, true);
  });

  it('accepts Passport leaf privateKeyHex + fabric-path xpub', function () {
    const master = new Key();
    const ident = new Identity(master);
    const fabric = ident.fabricKey;
    const priv = Buffer.isBuffer(fabric.private)
      ? fabric.private.toString('hex')
      : String(fabric.private);
    const message = 'fabric:hub-login:1:' + '11'.repeat(32) + ':' + '22'.repeat(24) + ':https://hub.fabric.pub';
    const body = buildClientSignedLoginBody(message, priv, fabric.xpub);
    assert.strictEqual(body.pubkeyHex, fabric.pubkey);
    assert.strictEqual(body.identity.id, String(ident.id));
    assert.strictEqual(body.identity.xpub, fabric.xpub);
    const verified = verifyFabricDesktopLoginSignedPayload({
      ...body,
      message
    }, { sessionId: '22'.repeat(24), origin: 'https://hub.fabric.pub' });
    assert.strictEqual(verified.ok, true);
  });
});
