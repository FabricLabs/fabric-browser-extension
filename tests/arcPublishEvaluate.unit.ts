'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Message = require('@fabric/core/types/message');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
import { tryParseNotifiableFabricFrame } from '../src/fabric/fabricWireNotify';
import {
  CONTRACT_PUBLISH,
  CONTRACT_PUBLISH_LOG,
  CONTRACT_WITHDRAWAL_REQUEST,
  CONTRACT_WITHDRAWAL_WITNESS,
  extractInnerMessageType,
  listArcMessageTypes,
  summarizeNotifiablePayload,
  tryParseNotifiableMessage
} from '../src/fabric/messageTypes';

describe('ARC publish and evaluation (Passport notify surface)', function () {
  const key = new Key();

  it('catalogues Application Resource Contract types including withdrawals', function () {
    const arcs = listArcMessageTypes();
    const types = arcs.map((d) => d.type);
    assert.ok(types.includes(CONTRACT_PUBLISH_LOG));
    assert.ok(types.includes(CONTRACT_WITHDRAWAL_REQUEST));
    assert.ok(types.includes(CONTRACT_WITHDRAWAL_WITNESS));
    assert.ok(types.includes('GroupChangeProposal'));
    assert.ok(types.includes('FederationContractInvite'));
    assert.ok(arcs.every((d) => d.arc === true));
  });

  it('evaluates CONTRACT_PUBLISH frames as ContractPublish', function () {
    const raw = JSON.stringify({
      type: CONTRACT_PUBLISH,
      object: {
        contractId: 'ab'.repeat(32),
        definitionDigest: 'cd'.repeat(32)
      }
    });
    const parsed = tryParseNotifiableMessage(raw);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, CONTRACT_PUBLISH_LOG);
    assert.strictEqual(extractInnerMessageType(JSON.parse(raw)), CONTRACT_PUBLISH_LOG);

    const wire = Message.fromVector([CONTRACT_PUBLISH, raw]).signWithKey(key).toBuffer();
    const fromWire = tryParseNotifiableFabricFrame(wire);
    assert.ok(fromWire);
    assert.strictEqual(fromWire!.messageType, CONTRACT_PUBLISH_LOG);
    assert.match(
      summarizeNotifiablePayload(fromWire!.messageType, fromWire!.payload, 'relay.goon.vc'),
      /contract /
    );
  });

  it('evaluates ContractWithdrawalRequest / Witness inside CONTRACT_MESSAGE', function () {
    const request = {
      type: 'CONTRACT_MESSAGE',
      contract: '11'.repeat(32),
      object: {
        type: CONTRACT_WITHDRAWAL_REQUEST,
        amountSats: 50_000,
        address: 'bcrt1qwithdraw',
        note: 'ops payout'
      }
    };
    const parsed = tryParseNotifiableMessage(JSON.stringify(request));
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, CONTRACT_WITHDRAWAL_REQUEST);
    assert.match(
      summarizeNotifiablePayload(parsed!.messageType, parsed!.payload, 'Passport'),
      /ops payout/
    );

    const witnessBody = JSON.stringify({
      type: 'CONTRACT_MESSAGE',
      object: {
        '@type': CONTRACT_WITHDRAWAL_WITNESS,
        contractId: '11'.repeat(32),
        signature: 'ab'.repeat(64)
      }
    });
    const witness = tryParseNotifiableMessage(witnessBody);
    assert.ok(witness);
    assert.strictEqual(witness!.messageType, CONTRACT_WITHDRAWAL_WITNESS);

    const wire = Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(request)]).signWithKey(key).toBuffer();
    const fromWire = tryParseNotifiableFabricFrame(wire);
    assert.ok(fromWire);
    assert.strictEqual(fromWire!.messageType, CONTRACT_WITHDRAWAL_REQUEST);
  });

  it('ignores unknown inner ARC bodies', function () {
    const raw = JSON.stringify({
      type: 'CONTRACT_MESSAGE',
      object: { type: 'NotARealArcType', foo: 1 }
    });
    assert.strictEqual(tryParseNotifiableMessage(raw), null);
  });
});
