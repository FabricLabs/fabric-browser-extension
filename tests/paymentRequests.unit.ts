'use strict';

import assert from 'assert';
import { queuePayment, readPaymentRequest, type PaymentRequest } from '../src/background/paymentRequests';

const BOLT11 = 'lnbcrt10u1pjexampleinvoicepayload0000';

function sender (url: string, extra: Record<string, unknown> = {}): chrome.runtime.MessageSender {
  return { tab: { id: 7 } as chrome.tabs.Tab, frameId: 0, url, ...extra } as chrome.runtime.MessageSender;
}

describe('payment requests', function () {
  it('reads a top frame’s 402 invoice with its labels and nothing else', function () {
    const r = readPaymentRequest({
      bolt11: ` ${BOLT11} `,
      requestUrl: 'https://shop.example/doc/1',
      fabric: { detail: 'Buy document 1', invoice: { amount: 0.0001, currency: 'BTC' }, documentOffer: { purchasePriceSats: 1000 } },
      l402: false
    }, sender('https://shop.example/page'), 1000);
    assert.ok(r);
    if (!r) return;
    assert.strictEqual(r.origin, 'https://shop.example');
    assert.strictEqual(r.bolt11, BOLT11);
    assert.strictEqual(r.detail, 'Buy document 1');
    assert.strictEqual(r.amount, '0.0001 BTC');
    assert.strictEqual(r.priceSats, 1000);
    assert.strictEqual(r.expiresAt, 1000 + 30 * 60 * 1000);
    assert.match(r.id, /^[0-9a-f]{16}$/);
  });

  it('refuses subframes, non-web pages, and anything that is not an invoice', function () {
    assert.strictEqual(readPaymentRequest({ bolt11: BOLT11 }, sender('https://shop.example/', { frameId: 3 })), null);
    assert.strictEqual(readPaymentRequest({ bolt11: BOLT11 }, sender('file:///tmp/x.html')), null);
    assert.strictEqual(readPaymentRequest({ bolt11: BOLT11 }, { url: 'https://shop.example/' } as chrome.runtime.MessageSender), null);
    assert.strictEqual(readPaymentRequest({ bolt11: 'bitcoin:bc1qxyz' }, sender('https://shop.example/')), null);
    assert.strictEqual(readPaymentRequest({ bolt11: 'ln<script>' }, sender('https://shop.example/')), null);
  });

  it('keeps one request per site, newest first, and drops expired ones', function () {
    const make = (origin: string, at: number, expiresAt = at + 1000): PaymentRequest => ({
      id: `${origin}-${at}`, origin, requestUrl: origin, bolt11: BOLT11, detail: null, amount: null, priceSats: null, l402: false, receivedAt: at, expiresAt
    });
    let list: PaymentRequest[] = [];
    list = queuePayment(list, make('https://a.example', 1), 1);
    list = queuePayment(list, make('https://b.example', 2), 2);
    list = queuePayment(list, make('https://a.example', 3), 3);
    assert.deepStrictEqual(list.map((r) => r.id), ['https://a.example-3', 'https://b.example-2']);
    list = queuePayment(list, make('https://c.example', 5000), 5000);
    assert.deepStrictEqual(list.map((r) => r.id), ['https://c.example-5000']);
    for (let i = 0; i < 12; i++) list = queuePayment(list, make(`https://s${i}.example`, 6000 + i), 6000 + i);
    assert.strictEqual(list.length, 8);
  });
});
