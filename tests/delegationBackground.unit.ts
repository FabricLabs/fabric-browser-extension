'use strict';

import assert from 'assert';
import { formatSas, latestPerRequester, mailboxOrigins, type LinkedSigner } from '../src/background/delegation';

function signer (over: Partial<LinkedSigner>): LinkedSigner {
  return {
    pubkey: '02' + 'ab'.repeat(32),
    name: 'Fabric Hub',
    signer: 'hub',
    network: 'regtest',
    via: 'local',
    base: null,
    hub: null,
    linkedAt: 1,
    ...over
  };
}

describe('delegation background', function () {
  it('shows the six-digit code in two halves', function () {
    assert.strictEqual(formatSas('123456'), '123 456');
    assert.strictEqual(formatSas('12345'), null);
    assert.strictEqual(formatSas(null), null);
  });

  it('keeps one waiting request per requester, the newest', function () {
    const a = '02' + '11'.repeat(32);
    const b = '03' + '22'.repeat(32);
    const items = [
      { hash: 'h1', receivedAt: 1, from: { pubkey: a } },
      { hash: 'h2', receivedAt: 3, from: { pubkey: '03' + a.slice(2) } },
      { hash: 'h3', receivedAt: 2, from: { pubkey: b } }
    ];
    const { keep, superseded } = latestPerRequester(items);
    assert.deepStrictEqual(keep.map((i) => i.hash).sort(), ['h2', 'h3']);
    assert.deepStrictEqual(superseded.map((i) => i.hash), ['h1']);
  });

  it('reads mailboxes only on loopback apps and trusted Hubs', function () {
    const trusted = (o: string) => o === 'https://hub.fabric.pub';
    const list = mailboxOrigins([
      signer({ via: 'local', base: 'http://127.0.0.1:8080' }),
      signer({ via: 'local', base: 'http://192.168.1.4:8080' }),
      signer({ via: 'hub', hub: 'https://hub.fabric.pub/' }),
      signer({ via: 'hub', hub: 'https://evil.example' })
    ], 'https://hub.fabric.pub', trusted);
    assert.deepStrictEqual(list, ['http://127.0.0.1:8080', 'https://hub.fabric.pub']);
    assert.deepStrictEqual(mailboxOrigins([], 'https://evil.example', trusted), []);
  });
});
