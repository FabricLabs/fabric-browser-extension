'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Message = require('@fabric/core/types/message');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
import {
  tryParseNotifiableFabricFrame,
  tryParseNotifiableWireMessage
} from '../src/fabric/fabricWireNotify';

describe('fabricWireNotify', function () {
  const key = new Key();

  function sign (type: string, body: string | Buffer) {
    return Message.fromVector([type, body]).signWithKey(key);
  }

  it('parses binary GENERIC_MESSAGE Tombstone frames', function () {
    const body = JSON.stringify({ type: 'Tombstone', object: { documentId: 'doc-1' } });
    const wire = sign('GenericMessage', body).toBuffer();
    const parsed = tryParseNotifiableFabricFrame(wire);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'Tombstone');
    assert.strictEqual((parsed!.payload.object as { documentId: string }).documentId, 'doc-1');
  });

  it('parses binary P2P_CHAT_MESSAGE frames (ArrayBuffer)', function () {
    const chat = {
      type: 'P2P_CHAT_MESSAGE',
      object: { content: 'hello mesh', created: Date.now() }
    };
    const wire = sign('P2P_CHAT_MESSAGE', JSON.stringify(chat)).toBuffer();
    const ab = wire.buffer.slice(wire.byteOffset, wire.byteOffset + wire.byteLength);
    const parsed = tryParseNotifiableFabricFrame(ab);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'P2P_CHAT_MESSAGE');
  });

  it('unwraps Peer-mesh P2P_RELAY (raw inner Message bytes)', function () {
    const chat = {
      type: 'P2P_CHAT_MESSAGE',
      object: { content: 'via relay', created: 1 }
    };
    const inner = sign('P2P_CHAT_MESSAGE', JSON.stringify(chat)).toBuffer();
    const outer = sign('P2P_RELAY', inner);
    const parsed = tryParseNotifiableWireMessage(outer);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'P2P_CHAT_MESSAGE');
  });

  it('unwraps Hub JSON P2P_RELAY hops envelope', function () {
    const chat = {
      type: 'P2P_CHAT_MESSAGE',
      object: { content: 'ws hops', created: 2 }
    };
    const envelope = {
      original: JSON.stringify(chat),
      originalType: 'P2P_CHAT_MESSAGE',
      hops: [{ from: 'webrtc-a', at: Date.now() }]
    };
    const outer = sign('P2P_RELAY', JSON.stringify(envelope));
    const parsed = tryParseNotifiableFabricFrame(outer.toBuffer());
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'P2P_CHAT_MESSAGE');
  });

  it('still accepts legacy plain JSON string frames', function () {
    const raw = JSON.stringify({
      type: 'FederationContractInvite',
      inviteId: 'inv-1',
      inviterHubId: 'hub-1'
    });
    const parsed = tryParseNotifiableFabricFrame(raw);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'FederationContractInvite');
  });

  it('unwraps CONTRACT_MESSAGE GroupChangeProposal bodies', function () {
    const body = JSON.stringify({
      type: 'CONTRACT_MESSAGE',
      contract: 'ab'.repeat(32),
      object: {
        type: 'GroupChangeProposal',
        id: 'gprop-1',
        action: 'member.add',
        member: '02' + 'ab'.repeat(32),
        threshold: 2,
        signatures: { a: 'local:1' }
      }
    });
    const wire = sign('CONTRACT_MESSAGE', body).toBuffer();
    const parsed = tryParseNotifiableFabricFrame(wire);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'GroupChangeProposal');
    assert.strictEqual(parsed!.payload.action, 'member.add');
  });

  it('unwraps inner GroupChangeProposal without outer CONTRACT_MESSAGE wrapper', function () {
    const body = JSON.stringify({
      type: 'GroupChangeProposal',
      id: 'gprop-2',
      action: 'update',
      threshold: 1
    });
    const wire = sign('P2P_CONTRACT_MESSAGE', body).toBuffer();
    const parsed = tryParseNotifiableFabricFrame(wire);
    assert.ok(parsed);
    assert.strictEqual(parsed!.messageType, 'GroupChangeProposal');
  });

  it('ignores non-Fabric binary', function () {
    assert.strictEqual(tryParseNotifiableFabricFrame(Buffer.from([1, 2, 3, 4])), null);
  });
});
