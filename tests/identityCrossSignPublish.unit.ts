'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');
import { REVOKE_TYPE, SIGN_TYPE, verifyCrossSignObject } from '../src/utils/identityCrossSign';
import { publishIdentityCrossSignKind } from '../src/utils/identityCrossSignPublish';

describe('identityCrossSignPublish', () => {
  const prevFetch = globalThis.fetch;
  afterEach(() => {
    (globalThis as { fetch: typeof fetch }).fetch = prevFetch;
  });

  it('POSTs IdentityCrossSign then IdentityCrossSignRevoke to the hub', async () => {
    const master = new Key();
    const ident = new Identity(master);
    const fabric = ident.fabricKey;
    const priv = Buffer.isBuffer(fabric.private)
      ? fabric.private.toString('hex')
      : String(fabric.private);
    const posts: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      posts.push({ url: String(url), body: JSON.parse(String(init && init.body)) });
      return { ok: true, status: 200 } as Response;
    }) as typeof fetch;

    const common = {
      hubBase: 'https://relay.goon.vc',
      privateKeyHex: priv,
      xpub: fabric.xpub,
      peerPubkey: '02' + 'aa'.repeat(32),
      binding: { sessionId: '12'.repeat(24), nonce: 'ab'.repeat(32), origin: 'https://relay.goon.vc' }
    };

    const signed = await publishIdentityCrossSignKind(common);
    assert.strictEqual(signed.ok, true);
    assert.ok(posts[0].url.endsWith('/identity/cross-sign') || posts[0].url.includes('/identity/cross-sign'));
    assert.strictEqual(posts[0].body.type, SIGN_TYPE);
    assert.match(String(posts[0].body.signature), /^[a-f0-9]{128}$/i);
    assert.strictEqual(posts[0].body.localPubkey, fabric.pubkey);
    assert.strictEqual(posts[0].body.sessionId, '12'.repeat(24));
    assert.strictEqual(posts[0].body.origin, 'https://relay.goon.vc');
    assert.strictEqual(verifyCrossSignObject(posts[0].body).ok, true);

    const revoked = await publishIdentityCrossSignKind({
      ...common,
      kind: REVOKE_TYPE
    });
    assert.strictEqual(revoked.ok, true);
    const rev = posts.find((p) => p.body.type === REVOKE_TYPE);
    assert.ok(rev);
    assert.strictEqual(rev.body.type, REVOKE_TYPE);
    assert.strictEqual(verifyCrossSignObject(rev.body).ok, true);
  });

  it('returns an error when every hub POST fails', async () => {
    const master = new Key();
    const ident = new Identity(master);
    const fabric = ident.fabricKey;
    const priv = Buffer.isBuffer(fabric.private)
      ? fabric.private.toString('hex')
      : String(fabric.private);
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      return { ok: false, status: 401 } as Response;
    }) as typeof fetch;
    const r = await publishIdentityCrossSignKind({
      hubBase: 'https://relay.goon.vc',
      privateKeyHex: priv,
      xpub: fabric.xpub,
      peerPubkey: '02' + 'aa'.repeat(32),
      binding: { sessionId: '12'.repeat(24), nonce: 'ab'.repeat(32), origin: 'https://relay.goon.vc' }
    });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.match(r.error, /HTTP 401/);
  });

  it('rejects a link without a session binding or peer pubkey before POST', async function () {
    const master = new Key();
    const ident = new Identity(master);
    const fabric = ident.fabricKey;
    const priv = Buffer.isBuffer(fabric.private)
      ? fabric.private.toString('hex')
      : String(fabric.private);
    const r = await publishIdentityCrossSignKind({
      hubBase: 'https://relay.goon.vc',
      privateKeyHex: priv,
      xpub: fabric.xpub,
      peerPubkey: '',
      binding: { sessionId: '', nonce: 'zz', origin: 'https://relay.goon.vc' }
    });
    assert.strictEqual(r.ok, false);
    if (!r.ok) assert.match(r.error, /invalid cross-sign/);
  });
});
