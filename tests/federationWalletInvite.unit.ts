'use strict';

import assert from 'assert';
import {
  buildMultisigWalletInviteJson,
  parseFederationWalletInvite,
  summarizeMultisigWalletInvite,
  normalizeProposedPolicy,
  normalizeSpendingTerms,
  formatInviteSpendingSummary,
  publishMultisigWalletInvite,
  respondToMultisigWalletInvite
} from '../src/utils/federationWalletInvite';

describe('federationWalletInvite (@fabric/http)', function () {
  const alice = '02' + '11'.repeat(32);
  const bob = '03' + '22'.repeat(32);

  it('builds and parses a v2 multisig invite with policy + spend', function () {
    const json = buildMultisigWalletInviteJson({
      inviteId: 'inv-test-1',
      inviterHubId: alice,
      note: 'treasury',
      groupName: 'Ops wallet',
      spendingTerms: { mode: 'percent', value: 10 },
      proposedPolicy: { validators: [alice, bob], threshold: 2 },
      termsSummary: 'No solo spends'
    });
    const parsed = parseFederationWalletInvite(json);
    assert.ok(parsed);
    assert.strictEqual(parsed!.type, 'FederationContractInvite');
    assert.strictEqual(parsed!.v, 2);
    assert.strictEqual(parsed!.groupName, 'Ops wallet');
    const policy = normalizeProposedPolicy(parsed!.proposedPolicy);
    assert.ok(policy);
    assert.strictEqual(policy!.threshold, 2);
    assert.strictEqual(policy!.validators.length, 2);
    const spend = normalizeSpendingTerms(parsed!.spendingTerms);
    assert.ok(spend);
    assert.strictEqual(spend!.mode, 'percent');
    assert.match(formatInviteSpendingSummary(parsed!), /10%/);
  });

  it('summarizes invite for notifications with m-of-n and cap', function () {
    const summary = summarizeMultisigWalletInvite({
      type: 'FederationContractInvite',
      v: 2,
      inviteId: 'x',
      groupName: 'Ops wallet',
      proposedPolicy: { validators: [alice, bob], threshold: 2 },
      spendingTerms: { mode: 'percent', value: 10 }
    }, 'hub.example');
    assert.match(summary, /2-of-2/);
    assert.match(summary, /10%/);
    assert.match(summary, /Ops wallet/);
    assert.match(summary, /hub\.example/);
  });

  it('publishes a v2 invite over SendPeerMessage and can reject it', async function () {
    const posts: Array<{ method: string; params: unknown[] }> = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init && init.body)) as { method: string; params: unknown[] };
      posts.push({ method: body.method, params: body.params || [] });
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { status: 'ok' } })
      } as Response;
    }) as typeof fetch;
    try {
      const published = await publishMultisigWalletInvite({
        hubBase: 'https://relay.goon.vc',
        peerIdOrAddress: bob,
        inviterHubId: alice,
        inviterPubkey: alice,
        peerPubkey: bob,
        threshold: 2,
        spendingTerms: { mode: 'percent', value: 10 },
        groupName: 'Ops wallet'
      });
      assert.ok(published.inviteId);
      assert.strictEqual(posts[0].method, 'SendPeerMessage');
      const invite = parseFederationWalletInvite(published.inviteJson);
      assert.ok(invite);
      await respondToMultisigWalletInvite({
        hubBase: 'https://relay.goon.vc',
        invite: invite!,
        accept: false,
        responderPubkey: bob
      });
      assert.strictEqual(posts[1].method, 'SendPeerMessage');
      const reply = String(posts[1].params[1] || '');
      assert.match(reply, /FederationContractInviteResponse/);
      assert.match(reply, /"accept":false/);
    } finally {
      delete (globalThis as { fetch?: unknown }).fetch;
    }
  });
});
