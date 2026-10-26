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
  countersignDeviceLink,
  keyFingerprint,
  startDeviceLinkAsInitiator,
  tickDeviceLinkAsInitiator,
  verifyPendingDeviceLink
} from '../src/utils/fabricDeviceLinkSign';
import { REVOKE_TYPE, SIGN_TYPE } from '../src/utils/identityCrossSign';
import { publishIdentityCrossSignKind } from '../src/utils/identityCrossSignPublish';
import {
  linkBindingOf,
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

  async function offerFrom (alice: ReturnType<typeof leaf>) {
    const offer = await startDeviceLinkAsInitiator({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: HUB,
      label: 'Passport'
    });
    assert.strictEqual(offer.ok, true, offer.ok === false ? offer.error : '');
    if (!offer.ok) throw new Error('offer');
    return offer;
  }

  function tickOpts (
    alice: ReturnType<typeof leaf>,
    offer: Awaited<ReturnType<typeof offerFrom>>,
    countersigned: string | null = null
  ) {
    return {
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      sessionId: offer.sessionId,
      hubBase: offer.hubBase,
      origin: offer.origin,
      nonce: offer.nonce,
      label: offer.label,
      countersigned
    };
  }

  it('runs offer → verified prompt → responder accept → confirmed countersign → cross-sign → revoke', async function () {
    const alice = leaf(new Key());
    const bob = leaf(new Key());
    assert.notStrictEqual(alice.ident.id, bob.ident.id);

    const offer = await offerFrom(alice);
    assert.match(offer.protocolUrl, /^fabric:\/\/link\?/);
    assert.ok(offer.httpsUrl.includes('#device-link='));

    const pendingTick = await tickDeviceLinkAsInitiator(tickOpts(alice, offer));
    assert.strictEqual(pendingTick.ok, true);
    if (pendingTick.ok) assert.strictEqual(pendingTick.status, 'pending');

    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    assert.strictEqual(fetched.ok, true);
    if (!fetched.ok) return;
    assert.strictEqual(fetched.initiator.id, String(alice.ident.id));

    const shown = await verifyPendingDeviceLink(fetched);
    assert.strictEqual(shown.ok, true, shown.ok === false ? shown.error : '');
    if (!shown.ok) return;
    assert.strictEqual(shown.offer.origin, HUB);
    assert.strictEqual(shown.offer.initiator.pubkeyHex, alice.fabric.pubkey);
    assert.strictEqual(shown.offer.fingerprint, keyFingerprint(alice.fabric.pubkey));

    const accepted = await completeDeviceLinkAsResponder(shown.offer, bob.privateKeyHex, bob.xpub);
    assert.strictEqual(accepted.ok, true, accepted.ok === false ? accepted.error : '');
    if (!accepted.ok) return;
    assert.strictEqual(accepted.status, 'accepted');
    assert.strictEqual(accepted.peerFabricId, String(alice.ident.id));
    assert.strictEqual(accepted.peerPubkey, alice.fabric.pubkey);

    const asking = await tickDeviceLinkAsInitiator(tickOpts(alice, offer));
    assert.strictEqual(asking.ok, true, asking.ok === false ? asking.error : '');
    if (!asking.ok || asking.status !== 'accepted' || !('responder' in asking)) throw new Error('expected accepted');
    assert.strictEqual(asking.responder.id, String(bob.ident.id));
    assert.strictEqual(asking.responder.pubkeyHex, bob.fabric.pubkey);
    assert.strictEqual(stub.sessions.get(offer.sessionId)?.status, 'accepted', 'a tick never countersigns');

    const countersigned = await countersignDeviceLink({
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      hubBase: HUB,
      accepted: asking
    });
    assert.strictEqual(countersigned.ok, true, countersigned.ok === false ? countersigned.error : '');

    const unasked = await tickDeviceLinkAsInitiator(tickOpts(alice, offer));
    assert.strictEqual(unasked.ok, false, 'linked is reported only for the responder this Passport countersigned');

    const linked = await tickDeviceLinkAsInitiator(tickOpts(alice, offer, asking.responder.id));
    assert.strictEqual(linked.ok, true, linked.ok === false ? linked.error : '');
    if (!linked.ok || linked.status !== 'linked' || !('responder' in linked)) throw new Error('expected linked');
    const binding = { sessionId: linked.sessionId, nonce: linked.nonce, origin: linked.origin };

    const signed = await publishIdentityCrossSignKind({
      hubBase: HUB,
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      peerPubkey: linked.responder.pubkeyHex,
      binding
    });
    assert.strictEqual(signed.ok, true);
    assert.strictEqual(stub.crossSigns[0].type, SIGN_TYPE);
    assert.strictEqual(stub.crossSigns[0].sessionId, offer.sessionId);
    assert.strictEqual(stub.crossSigns[0].origin, HUB);

    await mergeLinkedDevice({
      kind: 'device-link',
      peerFabricId: String(bob.ident.id),
      peerPubkey: linked.responder.pubkeyHex,
      sessionId: linked.sessionId,
      nonce: linked.nonce,
      hubOrigin: linked.origin,
      label: 'Passport',
      role: 'initiator'
    });
    const rows = await readLinkedDevices();
    assert.strictEqual(rows.length, 1);
    assert.deepStrictEqual(linkBindingOf(rows[0]), binding);
    assert.strictEqual(linkBindingOf({ kind: 'device-link', nonce: offer.nonce, hubOrigin: HUB }), null);

    const revoked = await publishIdentityCrossSignKind({
      hubBase: HUB,
      privateKeyHex: alice.privateKeyHex,
      xpub: alice.xpub,
      peerPubkey: linked.responder.pubkeyHex,
      binding,
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

  it('refuses an offer whose initiator key, id, or label was changed by the Hub', async function () {
    const alice = leaf(new Key());
    const mallory = leaf(new Key());
    const offer = await offerFrom(alice);
    const session = stub.sessions.get(offer.sessionId);
    if (!session) throw new Error('session');
    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    if (!fetched.ok) throw new Error(fetched.error);

    session.initiator.xpub = mallory.xpub;
    session.initiator.pubkeyHex = mallory.fabric.pubkey;
    const swappedKey = await verifyPendingDeviceLink(fetched);
    assert.strictEqual(swappedKey.ok, false);

    session.initiator.xpub = alice.xpub;
    session.initiator.pubkeyHex = alice.fabric.pubkey;
    const named = await verifyPendingDeviceLink({
      ...fetched,
      initiator: { id: String(mallory.ident.id), xpub: mallory.xpub }
    });
    assert.strictEqual(named.ok, false);
    if (!named.ok) assert.match(named.error, /another device/);

    session.label = 'Passport-2';
    const relabeled = await verifyPendingDeviceLink(fetched);
    assert.strictEqual(relabeled.ok, false);
  });

  it('refuses an offer served for another Hub origin', async function () {
    const alice = leaf(new Key());
    const offer = await offerFrom(alice);
    const session = stub.sessions.get(offer.sessionId);
    if (!session) throw new Error('session');
    session.origin = 'https://hub.fabric.pub';
    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    if (!fetched.ok) throw new Error(fetched.error);
    const checked = await verifyPendingDeviceLink(fetched);
    assert.strictEqual(checked.ok, false);
  });

  it('refuses to approve when the offer changed after the prompt', async function () {
    const alice = leaf(new Key());
    const bob = leaf(new Key());
    const offer = await offerFrom(alice);
    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    if (!fetched.ok) throw new Error(fetched.error);
    const shown = await verifyPendingDeviceLink(fetched);
    if (!shown.ok) throw new Error(shown.error);
    const stale = { ...shown.offer, initiator: { ...shown.offer.initiator, pubkeyHex: bob.fabric.pubkey } };
    const refused = await completeDeviceLinkAsResponder(stale, bob.privateKeyHex, bob.xpub);
    assert.strictEqual(refused.ok, false);
    if (!refused.ok) assert.match(refused.error, /changed/);
    assert.strictEqual(stub.sessions.get(offer.sessionId)?.status, 'pending');
  });

  it('refuses an accepted session whose responder signature does not check out', async function () {
    const alice = leaf(new Key());
    const bob = leaf(new Key());
    const mallory = leaf(new Key());
    const offer = await offerFrom(alice);
    const fetched = await fetchPendingDeviceLink(HUB, offer.sessionId);
    if (!fetched.ok) throw new Error(fetched.error);
    const shown = await verifyPendingDeviceLink(fetched);
    if (!shown.ok) throw new Error(shown.error);
    const accepted = await completeDeviceLinkAsResponder(shown.offer, bob.privateKeyHex, bob.xpub);
    assert.strictEqual(accepted.ok, true);
    const session = stub.sessions.get(offer.sessionId);
    if (!session || !session.responder) throw new Error('session');
    session.responder.xpub = mallory.xpub;
    session.responder.pubkeyHex = mallory.fabric.pubkey;
    const tick = await tickDeviceLinkAsInitiator(tickOpts(alice, offer));
    assert.strictEqual(tick.ok, false);
  });

  it('refuses self-link and invalid hub bases', async function () {
    const alice = leaf(new Key());
    const own = await offerFrom(alice);
    const ownPending = await fetchPendingDeviceLink(HUB, own.sessionId);
    if (!ownPending.ok) throw new Error(ownPending.error);
    const ownShown = await verifyPendingDeviceLink(ownPending);
    if (!ownShown.ok) throw new Error(ownShown.error);
    const self = await completeDeviceLinkAsResponder(ownShown.offer, alice.privateKeyHex, alice.xpub);
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
    const shown = await verifyPendingDeviceLink(fetched);
    if (!shown.ok) throw new Error(shown.error);

    stub.restore();
    (globalThis as { fetch: typeof fetch }).fetch = (async () => {
      return { ok: false, status: 500, json: async () => ({ error: 'hub down' }) } as Response;
    }) as typeof fetch;
    const failed = await completeDeviceLinkAsResponder(shown.offer, bob.privateKeyHex, bob.xpub);
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
    const cancelled = await cancelDeviceLinkSession(HUB, offer.sessionId, {
      pollSecret: offer.pollSecret
    });
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
