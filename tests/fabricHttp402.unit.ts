'use strict';

import * as assert from 'assert';
import { Buffer } from 'buffer';
import {
  decodeFabricPaymentRequestHeader,
  parseL402WWWAuthenticate,
  resolveBolt11From402
} from '../src/utils/fabricHttp402';

describe('fabricHttp402 (402 payment headers)', () => {
  it('decodes X-Fabric-Payment-Request base64url JSON', () => {
    const bolt11 =
      'lnbc1ptestinvoice';
    const payload = {
      detail: 'Pay to continue',
      invoice: { bolt11, amount: '0.00002', currency: 'BTC' }
    };
    const b64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    const decoded = decodeFabricPaymentRequestHeader(b64);
    assert.ok(decoded);
    assert.strictEqual(decoded?.detail, 'Pay to continue');
    assert.strictEqual(decoded?.invoice?.bolt11, bolt11);
  });

  it('parses L402 WWW-Authenticate invoice param', () => {
    const inv =
      'lnbc1ptestfrom401';
    const header = `L402 invoice="${inv}", macaroon="m00"`;
    const p = parseL402WWWAuthenticate(header);
    assert.strictEqual(p.invoice, inv);
    assert.strictEqual(p.macaroon, 'm00');
  });

  it('resolveBolt11 prefers Fabric header invoice bolt11 over L402', () => {
    const fromFabric =
      'lnbc1fabric';
    const fromL402 =
      'lnbc1l402';
    const fabric = decodeFabricPaymentRequestHeader(
      Buffer.from(JSON.stringify({ invoice: { bolt11: fromFabric } }), 'utf8').toString('base64url')
    );
    const u = resolveBolt11From402(fabric, `L402 invoice="${fromL402}"`);
    assert.strictEqual(u, fromFabric);
  });

  it('resolveBolt11 falls back to L402 when Fabric has no bolt11', () => {
    const fromL402 =
      'lnbc1fallback';
    const u = resolveBolt11From402(
      decodeFabricPaymentRequestHeader(
        Buffer.from(JSON.stringify({ detail: 'only detail' }), 'utf8').toString('base64url')
      ),
      `L402 invoice="${fromL402}"`
    );
    assert.strictEqual(u, fromL402);
  });
});
