'use strict';

import assert from 'assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Key = require('@fabric/core/types/key');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Identity = require('@fabric/core/types/identity');
import {
  deviceLinkFetchHeaders,
  evaluateDeviceLinkPageRequest,
  fetchPendingDeviceLink,
  cancelDeviceLinkSession,
  validateQueuedDeviceLinkOffer
} from '../src/utils/fabricDeviceLinkFetch';
import {
  completeDeviceLinkAsResponder,
  startDeviceLinkAsInitiator,
  tickDeviceLinkAsInitiator
} from '../src/utils/fabricDeviceLinkSign';
import { REVOKE_TYPE, SIGN_TYPE } from '../src/utils/identityCrossSign';
import { publishIdentityCrossSignKind } from '../src/utils/identityCrossSignPublish';
import {
  mergeLinkedDevice,
  readLinkedDevices,
  removeLinkedDevice
} from '../src/utils/linkedDevices';
import { installDeviceLinkHubStub } from './helpers/deviceLinkHubStub';

function leaf (master: { xprv?: string }) {
  const ident = new Identity(master);
  const fabric = ident.fabricKey;
  const privateKeyHex = Buffer.isBuffer(fabric.private)
    ? fabric.private.toString('hex')
    : String(fabric.private);
  return { ident, fabric, privateKeyHex, xpub: fabric.xpub };
}

function mockChromeStorage () {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get (key: string, cb: (res: Record<string, unknown>) => void) {
          cb({ [key]: mem[key] });
        },
        set (obj: Record<string, unknown>, cb: () => void) {
          Object.assign(mem, obj);
          cb();
        }
      }
    }
  };
}

describe('device-link flow (Passport client ↔ Hub protocol)', function () {
  this.timeout(15000);
  const HUB = 'https://relay.goon.vc';
  let stub: ReturnType<typeof installDeviceLinkHubStub>;

  beforeEach(function () {
    stub = installDeviceLinkHubStub(HUB);
    mockChromeStorage();
  });

  afterEach(function () {
    stub.restore();
  });

  it('runs initiator offer → responder accept → initiator countersign → cross-sign → revoke', async function () {
    const alice = leaf(new Key());
    const bob = leaf(new Key());
    assert.notStrictEqual(alice.ident.id, bob.ident.id);

    const offer = await startDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: HUB,
      label: 'Passport'
    });
    assert.strictEqual(offer.ok, true);
    if (!offer.ok) return;
    assert.ok(offer.sessionId);
    assert.match(offer.protocolUrl, /^fabric:\/\/link\?/);
    assert.ok(offer.httpsUrl.includes('#device-link='));

    const pendingTick = await tickDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      sessionId: offer.sessionId,
      hubBase: offer.hubBase,
      origin: offer.origin,
      nonce: offer.nonce,
      label: offer.label
    });
    assert.strictEqual(pendingTick.ok, true);
    if (pendingTick.ok) assert.strictEqual(pendingTick.status, 'pending');

    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    assert.strictEqual(fetched.ok, true);
    if (!fetched.ok) return;
    assert.strictEqual(fetched.status, 'pending');
    assert.strictEqual(fetched.initiator.id, String(alice.ident.id));

    const accepted = await completeDeviceLinkAsResponder(fetched, bob.privateKeyHex, bob.xpub);
    assert.strictEqual(accepted.ok, true);
    if (!accepted.ok) return;
    assert.strictEqual(accepted.status, 'accepted');
    assert.strictEqual(accepted.peerFabricId, String(alice.ident.id));

    const linked = await tickDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      sessionId: offer.sessionId,
      hubBase: offer.hubBase,
      origin: offer.origin,
      nonce: offer.nonce,
      label: offer.label
    });
    assert.strictEqual(linked.ok, true);
    if (!linked.ok) return;
    assert.strictEqual(linked.status, 'linked');
    assert.strictEqual(linked.peerFabricId, String(bob.ident.id));
    assert.ok(linked.peerPubkey);

    const signed = await publishIdentityCrossSignKind({
      hubBase: HUB,
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      peerPubkey: String(linked.peerPubkey),
      nonce: offer.nonce
    });
    assert.strictEqual(signed.ok, true);
    assert.strictEqual(stub.crossSigns[0].type, SIGN_TYPE);

    await mergeLinkedDevice({
      kind: 'device-link',
      peerFabricId: String(bob.ident.id),
      peerPubkey: String(linked.peerPubkey),
      nonce: offer.nonce,
      label: 'Passport',
      role: 'initiator'
    });
    assert.strictEqual((await readLinkedDevices()).length, 1);

    const revoked = await publishIdentityCrossSignKind({
      hubBase: HUB,
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      peerPubkey: String(linked.peerPubkey),
      nonce: offer.nonce,
      kind: REVOKE_TYPE
    });
    assert.strictEqual(revoked.ok, true);
    assert.ok(stub.crossSigns.some((row) => row.type === REVOKE_TYPE));
    await removeLinkedDevice(String(bob.ident.id));
    assert.strictEqual((await readLinkedDevices()).length, 0);

    const alreadyLinked = await fetchPendingDeviceLink(HUB, offer.sessionId);
    assert.strictEqual(alreadyLinked.ok, true);
    if (alreadyLinked.ok) assert.strictEqual(alreadyLinked.status, 'linked');
  });

  it('refuses self-link and invalid hub bases', async function () {
    const alice = leaf(new Key());
    const self = await completeDeviceLinkAsResponder({
      sessionId: 'aa'.repeat(24),
      hubBase: HUB,
      origin: HUB,
      nonce: 'ab'.repeat(32),
      label: 'Passport',
      initiator: { id: String(alice.ident.id), xpub: alice.xpub, pubkeyHex: alice.fabric.pubkey }
    }, alice.privateKeyHex, alice.xpub);
    assert.strictEqual(self.ok, false);
    if (!self.ok) assert.match(self.error, /itself/);

    const badHub = await startDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: 'not-a-url'
    });
    assert.strictEqual(badHub.ok, false);

    const missing = await fetchPendingDeviceLink(HUB, 'deadbeef');
    assert.strictEqual(missing.ok, false);
    if (!missing.ok) assert.match(missing.error, /unknown|expired|HTTP 404/i);

    const incomplete = await fetchPendingDeviceLink(':::bad', 'x');
    assert.strictEqual(incomplete.ok, false);
  });

  it('rejects phishing hubs and origin mismatches on the page gate', function () {
    const sessionId = 'aa'.repeat(24);
    const phish = evaluateDeviceLinkPageRequest({
      sessionId,
      hubRaw: 'https://evil.example',
      declaredOrigin: 'https://evil.example',
      pageOrigin: 'https://evil.example'
    });
    assert.strictEqual(phish.ok, false);
    if (!phish.ok) assert.strictEqual(phish.error, 'hub_not_allowed');

    const mismatch = evaluateDeviceLinkPageRequest({
      sessionId,
      hubRaw: HUB,
      declaredOrigin: HUB,
      pageOrigin: 'https://hub.fabric.pub'
    });
    assert.strictEqual(mismatch.ok, false);
    if (!mismatch.ok) assert.strictEqual(mismatch.error, 'origin_mismatch');

    const ok = evaluateDeviceLinkPageRequest({
      sessionId,
      hubRaw: HUB + '/#device-link=x',
      declaredOrigin: HUB,
      pageOrigin: HUB
    });
    assert.strictEqual(ok.ok, true);

    const queued = validateQueuedDeviceLinkOffer({
      sessionId,
      hubBase: HUB,
      origin: HUB,
      nonce: 'ab'.repeat(32),
      pageOrigin: 'https://other.example',
      initiator: { id: 'id1aaa', xpub: 'xpub1' }
    });
    assert.strictEqual(queued.ok, false);
    if (!queued.ok) assert.strictEqual(queued.error, 'invalid_device_link');
  });

  it('surfaces HTTP failures from GET and responder POST', async function () {
    const alice = leaf(new Key());
    const bob = leaf(new Key());
    const offer = await startDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: HUB
    });
    assert.strictEqual(offer.ok, true);
    if (!offer.ok) return;
    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    assert.strictEqual(fetched.ok, true);
    if (!fetched.ok) return;

    stub.restore();
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      return { ok: false, status: 500, json: async () => ({ error: 'hub down' }) } as Response;
    }) as typeof fetch;
    const failed = await completeDeviceLinkAsResponder(fetched, bob.privateKeyHex, bob.xpub);
    assert.strictEqual(failed.ok, false);
    if (!failed.ok) assert.match(failed.error, /hub down|HTTP 500/);
  });

  it('omits client-set Origin/Referer on device-link HTTP headers', function () {
    const getHeaders = deviceLinkFetchHeaders();
    assert.strictEqual(getHeaders.Accept, 'application/json');
    assert.strictEqual(getHeaders.Origin, undefined);
    assert.strictEqual(getHeaders.Referer, undefined);
    const jsonHeaders = deviceLinkFetchHeaders({ json: true });
    assert.strictEqual(jsonHeaders['Content-Type'], 'application/json');
    assert.strictEqual(jsonHeaders.Origin, undefined);
  });

  it('Cancel DELETE unsticks a pending offer (404 is success)', async function () {
    const alice = leaf(new Key());
    const offer = await startDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: HUB,
      label: 'Passport'
    });
    assert.strictEqual(offer.ok, true);
    if (!offer.ok) return;
    const cancelled = await cancelDeviceLinkSession(HUB, offer.sessionId);
    assert.strictEqual(cancelled.ok, true);
    if (cancelled.ok) assert.equal(cancelled.cancelled, true);
    const gone = await fetchPendingDeviceLink(HUB, offer.sessionId);
    assert.strictEqual(gone.ok, false);
    const again = await cancelDeviceLinkSession(HUB, offer.sessionId);
    assert.strictEqual(again.ok, true);
  });

  it('reports fetch rejection as a failed cancel', async function () {
    (globalThis as { fetch: typeof fetch }).fetch = async () => {
      throw new Error('hub unreachable');
    };
    const out = await cancelDeviceLinkSession(HUB, 'aa'.repeat(24));
    assert.strictEqual(out.ok, false);
    if (!out.ok) assert.match(out.error, /hub unreachable/);
  });
});
