import assert from 'assert';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { FederationMember, federationsAvailable } from '../src/services/federations';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricFederation');

/** bitcoinjs-lib of the same core tree (v7: bigint output values). */
function coreBitcoin (): any {
  const roots = [process.env.FABRIC_CORE, path.resolve(__dirname, '../../fabric-clean'), path.resolve(__dirname, '../node_modules/@fabric/core')]
    .filter(Boolean) as string[];
  const root = roots.find((r) => fs.existsSync(path.join(r, 'types', 'federation.js')));
  return require(require.resolve('bitcoinjs-lib', { paths: [root as string] }));
}

const priv = () => crypto.randomBytes(32).toString('hex');

/** In-memory Hub mailbox with the same contract as `/services/federations/*`. */
function fakeHub (opts: { member?: boolean } = {}) {
  const hubKey = new core.Key({ private: priv() });
  const frames: Array<{ seq: number; fabric: string; federationId: string }> = [];
  const descriptors = new Map<string, any>();
  const coins = new Map<string, Array<{ txid: string; vout: number; amountSats: number; txHex: string }>>();
  const sent: string[] = [];
  let seq = 0;

  function record (uri: string) {
    const d = core.fabricUri.decodeFabricUri(uri, { allowedTypes: ['CONTRACT_MESSAGE'] });
    if (!d.ok || !d.signed) throw new Error('unsigned');
    const body = JSON.parse(d.message.data);
    if (body.type === core.Federation.MESSAGE_TYPES.invite) {
      descriptors.set(body.federationId, core.Federation.verifyInvite(body, d.author));
    } else {
      const descriptor = descriptors.get(body.federationId);
      if (!descriptor) throw new Error('unknown federation');
      core.Federation.verifySender(descriptor, body, d.author);
    }
    frames.push({ seq: ++seq, fabric: uri, federationId: body.federationId });
  }

  function fund (federationId: string, amountSats: number) {
    const bitcoin = coreBitcoin();
    const vault = core.Federation.vaultForDescriptor(descriptors.get(federationId));
    const tx = new bitcoin.Transaction();
    tx.version = 2;
    tx.addInput(crypto.randomBytes(32), 0);
    tx.addOutput(vault.output, BigInt(amountSats));
    const list = coins.get(federationId) || [];
    list.push({ txid: tx.getId(), vout: 0, amountSats, txHex: tx.toHex() });
    coins.set(federationId, list);
  }

  const fetch = async (url: string, init: any = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    const reply = (status: number, data: any) => ({ ok: status < 400, status, json: async () => data });
    try {
      if (u.pathname === '/services/federations') {
        return reply(200, { network: 'regtest', pubkey: opts.member ? hubKey.pubkey : null });
      }
      if (u.pathname === '/services/federations/messages' && init.method === 'POST') {
        record(String(body.fabric));
        return reply(200, { duplicate: false });
      }
      if (u.pathname === '/services/federations/messages') {
        const x = String(u.searchParams.get('pubkey')).slice(2);
        const since = Number(u.searchParams.get('since')) || 0;
        const messages = frames.filter((f) => f.seq > since && core.Federation.isValidator(descriptors.get(f.federationId), x));
        return reply(200, { messages, next: seq, more: false });
      }
      const m = u.pathname.match(/^\/services\/federations\/([0-9a-f]{64})\/(vault|transactions)$/);
      if (m && m[2] === 'vault') {
        const utxos = coins.get(m[1]) || [];
        return reply(200, {
          federationId: m[1],
          address: core.Federation.vaultForDescriptor(descriptors.get(m[1])).address,
          balanceSats: utxos.reduce((n, c) => n + c.amountSats, 0),
          utxos
        });
      }
      if (m && m[2] === 'transactions') {
        sent.push(String(body.txHex));
        return reply(200, { txid: coreBitcoin().Transaction.fromHex(body.txHex).getId() });
      }
      return reply(404, { message: 'not found' });
    } catch (err: any) {
      return reply(400, { message: err.message });
    }
  };

  return { fetch, hubKey, fund, sent, frames };
}

describe('Passport federation member', () => {
  before(function () {
    if (!federationsAvailable()) this.skip();
  });

  it('creates, joins, and spends a 2-of-2 between two Passports', async () => {
    const hub = fakeHub();
    const aliceHex = priv();
    const alice = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: aliceHex, fetch: hub.fetch });
    const bob = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });

    const created = await alice.create({ name: 'Ops', threshold: 2, members: [bob.pubkey] });
    assert.strictEqual(created.status, 'accepted');
    assert.strictEqual(created.descriptor.network, 'regtest');

    await bob.sync();
    assert.deepStrictEqual(bob.pendingInvites().map((r) => r.id), [created.id]);
    assert.strictEqual(bob.get(created.id)!.vaultAddress, created.vaultAddress);
    await bob.respond(created.id, true);
    await alice.sync();
    assert.strictEqual(alice.accepted(alice.get(created.id)!).length, 2);

    hub.fund(created.id, 100000);
    const vault = await alice.vault(created.id);
    assert.strictEqual(vault.balanceSats, 100000);

    const w = await alice.requestWithdrawal(created.id, { destinationAddress: coreDest(), amountSats: 40000, feeSats: 500 });
    assert.ok(w.signatures[alice.xonly]);
    assert.strictEqual(hub.sent.length, 0);

    await bob.sync();
    assert.strictEqual(bob.pendingApprovals().length, 1);
    await bob.approve(created.id, w.requestId);
    assert.strictEqual(hub.sent.length, 1);
    assert.strictEqual(bob.get(created.id)!.withdrawals[w.requestId].status, 'broadcast');

    await alice.sync();
    assert.strictEqual(alice.get(created.id)!.withdrawals[w.requestId].status, 'broadcast');
    assert.strictEqual(alice.get(created.id)!.withdrawals[w.requestId].txid, bob.get(created.id)!.withdrawals[w.requestId].txid);

    // State survives a reload.
    const again = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: aliceHex, fetch: hub.fetch, state: alice.export() });
    assert.strictEqual(again.list().length, 1);
  });

  it('answers a linked signer\'s invite and withdrawal from the frames alone', async () => {
    const hub = fakeHub();
    const alice = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const bob = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const created = await alice.create({ name: 'Linked signers', threshold: 2, members: [bob.pubkey] });
    assert.match(created.invite, /^fabric:/);

    const joined = await bob.answerDelegated(created.invite);
    assert.match(joined, /^fabric:/);
    assert.strictEqual(bob.get(created.id)!.status, 'accepted');
    await assert.rejects(alice.answerDelegated(created.invite), /you created/);

    hub.fund(created.id, 60000);
    const w = await alice.requestWithdrawal(created.id, { destinationAddress: coreDest(), amountSats: 20000, feeSats: 400 });
    const request = hub.frames.map((f) => f.fabric).find((uri) => {
      const d = core.fabricUri.decodeFabricUri(uri, { allowedTypes: ['CONTRACT_MESSAGE'] });
      return JSON.parse(d.message.data).type === core.Federation.MESSAGE_TYPES.withdrawal;
    })!;
    await bob.sync();
    await bob.answerDelegated(request);
    assert.strictEqual(hub.sent.length, 1);
    assert.strictEqual(bob.get(created.id)!.withdrawals[w.requestId].status, 'broadcast');
  });

  it('leaves broadcasting to a member Hub', async () => {
    const hub = fakeHub({ member: true });
    const alice = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const bob = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const created = await alice.create({ threshold: 2, members: [bob.pubkey], includeHub: true });
    assert.strictEqual(created.descriptor.validators.length, 3);
    assert.strictEqual(created.members.find((m) => m.pubkey === hub.hubKey.pubkey)!.url, 'https://hub.example');
    await bob.sync();
    await bob.respond(created.id, true);
    hub.fund(created.id, 50000);
    const w = await alice.requestWithdrawal(created.id, { destinationAddress: coreDest(), amountSats: 20000, feeSats: 300 });
    await bob.sync();
    await bob.approve(created.id, w.requestId);
    assert.strictEqual(hub.sent.length, 0);
    assert.strictEqual(bob.get(created.id)!.withdrawals[w.requestId].status, 'pending');
  });

  it('keeps a sent withdrawal as broadcast when the notice post fails', async () => {
    const hub = fakeHub();
    let failNotice = false;
    const fetch = async (url: string, init: any = {}) => {
      if (failNotice && init.method === 'POST' && new URL(url).pathname === '/services/federations/messages') {
        failNotice = false;
        return { ok: false, status: 503, json: async () => ({ message: 'unavailable' }) };
      }
      const res = await hub.fetch(url, init);
      if (init.method === 'POST' && /\/transactions$/.test(new URL(url).pathname)) failNotice = true;
      return res;
    };
    const alice = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const bob = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch });
    const created = await alice.create({ threshold: 2, members: [bob.pubkey] });
    await bob.sync();
    await bob.respond(created.id, true);
    hub.fund(created.id, 100000);
    const w = await alice.requestWithdrawal(created.id, { destinationAddress: coreDest(), amountSats: 40000, feeSats: 500 });
    await bob.sync();
    await bob.approve(created.id, w.requestId);
    const mine = bob.get(created.id)!.withdrawals[w.requestId];
    assert.strictEqual(hub.sent.length, 1);
    assert.strictEqual(mine.status, 'broadcast');
    assert.match(String(mine.txid), /^[0-9a-f]{64}$/);
    assert.match(String(mine.error), /broadcast notice failed/);
    await bob.sync();
    assert.strictEqual(hub.sent.length, 1);
  });

  it('refuses frames that do not check out', async () => {
    const hub = fakeHub();
    const alice = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const bob = new FederationMember({ hubBase: 'https://hub.example', privateKeyHex: priv(), fetch: hub.fetch });
    const created = await alice.create({ threshold: 2, members: [bob.pubkey] });
    await bob.sync();

    const sign = (key: any, body: object) => {
      const msg = core.Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(body)]);
      msg.signWithKey(key);
      return core.fabricUri.encodeFabricUri(msg);
    };
    const stranger = new core.Key({ private: priv() });
    assert.throws(() => bob.receive(sign(stranger, core.Federation.responseMessage(created.id, true))), /not a member/);
    const unsigned = core.fabricUri.encodeFabricUri(core.Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(core.Federation.syncMessage(created.id))]));
    assert.throws(() => bob.receive(unsigned), /unsigned/);

    // A withdrawal whose id does not match what it pays.
    hub.fund(created.id, 100000);
    const vault = await alice.vault(created.id);
    const forged = core.Federation.withdrawalMessage(created.id, {
      requestId: 'ab'.repeat(32),
      fundedTxHex: vault.utxos[0].txHex,
      vout: 0,
      destinationAddress: coreDest(),
      amountSats: 90000,
      feeSats: 500
    });
    assert.throws(() => bob.receive(sign((alice as any).key, forged)), /does not match/);
    assert.strictEqual(bob.pendingApprovals().length, 0);

    // One-key "federations" are just wallets.
    await assert.rejects(alice.create({ threshold: 1, members: [bob.pubkey] }), /at least 2 signatures/);
  });
});

function coreDest (): string {
  const bitcoin = coreBitcoin();
  return bitcoin.address.toBech32(crypto.randomBytes(20), 0, 'bcrt');
}
