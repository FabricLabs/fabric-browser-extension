'use strict';

import assert from 'assert';
import {
  broadcastTransaction,
  fetchBitcoinStatus,
  fetchWalletBalance,
  formatBtc,
  formatSats
} from '../src/fabric/bitcoinService';
import { requestHubRegtestFaucet } from '../src/utils/fabricHubFaucet';

function jsonResponse (status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

describe('Bitcoin withdrawals and Hub bitcoin HTTP', function () {
  afterEach(function () {
    delete (globalThis as { fetch?: unknown }).fetch;
  });

  it('broadcasts sendrawtransaction and surfaces RPC failures', async function () {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init && init.body)) as Record<string, unknown>;
      calls.push({ url: String(url), body });
      if (body.method === 'sendrawtransaction' && body.params && (body.params as string[])[0] === 'deadbeef') {
        return jsonResponse(200, { jsonrpc: '2.0', id: 1, result: 'txid-ok' });
      }
      return jsonResponse(200, {
        jsonrpc: '2.0',
        id: 1,
        error: { message: 'insufficient fee' }
      });
    }) as typeof fetch;

    const txid = await broadcastTransaction('https://relay.goon.vc', 'deadbeef');
    assert.strictEqual(txid, 'txid-ok');
    assert.ok(calls[0].url.endsWith('/services/bitcoin'));
    assert.strictEqual(calls[0].body.method, 'sendrawtransaction');

    await assert.rejects(
      () => broadcastTransaction('https://relay.goon.vc', '00'),
      /insufficient fee/
    );
  });

  it('requests a bounded faucet and rejects empty destinations', async function () {
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string, init?: RequestInit) => {
      assert.ok(String(url).endsWith('/services/bitcoin/faucet'));
      const body = JSON.parse(String(init && init.body)) as Record<string, unknown>;
      assert.strictEqual(body.address, 'bcrt1qdest');
      assert.strictEqual(body.amountSats, 1_000_000);
      return jsonResponse(200, {
        status: 'ok',
        network: 'regtest',
        faucet: { txid: 'faucet-txid', destination: 'bcrt1qdest', amountSats: 1_000_000 }
      });
    }) as typeof fetch;

    const empty = await requestHubRegtestFaucet('https://relay.goon.vc', { address: '' });
    assert.strictEqual(empty.ok, false);

    const noHub = await requestHubRegtestFaucet('', { address: 'bcrt1qdest' });
    assert.strictEqual(noHub.ok, false);

    const funded = await requestHubRegtestFaucet('https://relay.goon.vc', {
      address: 'bcrt1qdest',
      amountSats: 50_000_000
    });
    assert.strictEqual(funded.ok, true);
    if (funded.ok) {
      assert.strictEqual(funded.faucet.amountSats, 1_000_000);
      assert.strictEqual(funded.faucet.txid, 'faucet-txid');
    }
  });

  it('returns a zero balance when Hub bitcoin is unavailable', async function () {
    (globalThis as { fetch: typeof fetch }).fetch = (async (url: string) => {
      if (String(url).endsWith('/services/rpc')) {
        return jsonResponse(200, {
          jsonrpc: '2.0',
          id: 1,
          result: { available: false }
        });
      }
      throw new Error('unexpected ' + url);
    }) as typeof fetch;
    const status = await fetchBitcoinStatus('https://relay.goon.vc');
    assert.strictEqual(status.available, false);
    const bal = await fetchWalletBalance(
      'https://relay.goon.vc',
      'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TQg7usUCTdzkYYRLqRu6P',
      'regtest'
    );
    assert.strictEqual(bal.balanceSats, 0);
    assert.strictEqual(formatSats(Number.NaN), '0');
    assert.strictEqual(formatBtc(Number.NaN), '0.00000000');
  });
});
