'use strict';

/**
 * Passport client against a real GoonCitizen LiveRelay:
 * Hub-shaped `/device-links` (desktop/hosted) + Android local accept +
 * IdentityCrossSign HTTP. DeviceDataShare is GoonCitizen-only and is not
 * asserted here.
 */

import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const Key = require('@fabric/core/types/key');
const Identity = require('@fabric/core/types/identity');
import {
  completeDeviceLinkAsResponder,
  startDeviceLinkAsInitiator,
  tickDeviceLinkAsInitiator
} from '../src/utils/fabricDeviceLinkSign';
import { fetchPendingDeviceLink } from '../src/utils/fabricDeviceLinkFetch';
import { publishIdentityCrossSignKind } from '../src/utils/identityCrossSignPublish';
import { SIGN_TYPE } from '../src/utils/identityCrossSign';

const GOON_ROOT = process.env.GOONCITIZEN_ROOT ||
  path.join(__dirname, '..', '..', 'star-citizen-live');

function leaf (master: { xprv?: string }) {
  const ident = new Identity(master);
  const fabric = ident.fabricKey;
  const privateKeyHex = Buffer.isBuffer(fabric.private)
    ? fabric.private.toString('hex')
    : String(fabric.private);
  return { ident, fabric, privateKeyHex, xpub: fabric.xpub };
}

function tmpDir (prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function jsonFetch (url: string, init: RequestInit = {}) {
  const res = await fetch(url, init);
  const j = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, j };
}

describe('Passport ↔ GoonCitizen LiveRelay (desktop hub + Android)', function () {
  this.timeout(60000);

  let LiveRelay: { new (opts: object): {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    server: { address: () => { port: number } };
    setIdentity: (ident: unknown) => void;
    identityCluster: { clusterEquals: (a: string, b: string) => boolean };
  } };
  let createIdentity: () => { pubkey: string };
  let hub: { relay: { stop: () => Promise<void> }; origin: string; dir: string } | null = null;
  let phone: {
    relay: {
      stop: () => Promise<void>;
      setIdentity: (ident: unknown) => void;
      identityCluster: { clusterEquals: (a: string, b: string) => boolean };
    };
    origin: string;
    dir: string;
  } | null = null;
  let phoneIdent: { pubkey: string };

  before(async function () {
    try {
      LiveRelay = require(path.join(GOON_ROOT, 'services/LiveRelay'));
      ({ createIdentity } = require(path.join(GOON_ROOT, 'functions/identity')));
    } catch {
      this.skip();
    }
    if (typeof globalThis.fetch !== 'function') {
      try {
        const { fetch: undiciFetch } = require('undici') as { fetch: typeof fetch };
        globalThis.fetch = undiciFetch;
      } catch {
        this.skip();
      }
    }

    async function startRelay (mode: string, dir: string) {
      const relay = new LiveRelay({
        port: 0,
        listen: true,
        mode,
        settingsDir: dir,
        logfile: path.join(dir, 'missing.log'),
        fabric: { enable: false, listen: false, port: 0, peers: [] },
        missions: { enable: false },
        discord: { enable: false }
      });
      await relay.start();
      const port = relay.server.address().port;
      return { relay, origin: `http://127.0.0.1:${port}`, dir };
    }

    hub = await startRelay('server', tmpDir('pp-gc-hub-'));
    phone = await startRelay('android', tmpDir('pp-gc-phone-'));
    phoneIdent = createIdentity();
    phone.relay.setIdentity(phoneIdent);
  });

  after(async function () {
    if (phone && phone.relay) await phone.relay.stop();
    if (hub && hub.relay) await hub.relay.stop();
    for (const ctx of [phone, hub]) {
      if (ctx && ctx.dir) {
        try { fs.rmSync(ctx.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  });

  it('links Passport (initiator) to Android via LiveRelay /device-links then IdentityCrossSign', async function () {
    assert.ok(hub && phone);
    const passport = leaf(new Key());
    assert.notStrictEqual(passport.ident.pubkey, phoneIdent.pubkey);

    const offer = await startDeviceLinkAsInitiator({
      privateKeyHex: passport.privateKeyHex,
      xpub: passport.xpub,
      hubBase: hub.origin,
      label: 'Passport'
    });
    assert.strictEqual(offer.ok, true, offer.ok === false ? offer.error : '');
    if (!offer.ok) return;
    assert.match(offer.protocolUrl, /^fabric:\/\/link\?/);

    const pending = await jsonFetch(
      `${phone.origin}/services/star-citizen/device-links/pending?sessionId=${encodeURIComponent(offer.sessionId)}&hub=${encodeURIComponent(hub.origin)}`
    );
    assert.strictEqual(pending.status, 200, JSON.stringify(pending.j));
    assert.strictEqual(pending.j.status, 'pending');

    const accept = await jsonFetch(`${phone.origin}/services/star-citizen/device-links/accept`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        hubBase: hub.origin,
        sessionId: offer.sessionId,
        nonce: pending.j.nonce,
        label: pending.j.label,
        initiator: pending.j.initiator
      })
    });
    assert.strictEqual(accept.status, 200, JSON.stringify(accept.j));
    assert.strictEqual(accept.j.ok, true);

    const linked = await tickDeviceLinkAsInitiator({
      privateKeyHex: passport.privateKeyHex,
      xpub: passport.xpub,
      sessionId: offer.sessionId,
      hubBase: offer.hubBase,
      origin: offer.origin,
      nonce: offer.nonce,
      label: offer.label
    });
    assert.strictEqual(linked.ok, true, linked.ok === false ? linked.error : '');
    if (!linked.ok) return;
    assert.strictEqual(linked.status, 'linked');
    assert.ok(linked.peerPubkey);

    const signed = await publishIdentityCrossSignKind({
      hubBase: phone.origin,
      privateKeyHex: passport.privateKeyHex,
      xpub: passport.xpub,
      peerPubkey: phoneIdent.pubkey,
      nonce: offer.nonce
    });
    assert.strictEqual(signed.ok, true, signed.ok === false ? signed.error : '');

    assert.strictEqual(
      phone.relay.identityCluster.clusterEquals(phoneIdent.pubkey, passport.ident.pubkey),
      true
    );
  });

  it('lets Passport accept a GoonCitizen desktop offer on the same hub', async function () {
    assert.ok(hub);
    const { startDeviceLinkOffer, tickDeviceLinkOffer } = require(
      path.join(GOON_ROOT, 'functions/fabricDeviceLinkOffer')
    );
    const desktop = createIdentity();
    const passport = leaf(new Key());

    const offer = await startDeviceLinkOffer(desktop, {
      hubBase: hub.origin,
      label: 'GoonCitizen desktop'
    });
    assert.strictEqual(offer.ok, true, offer.error);

    const fetched = await fetchPendingDeviceLink(hub.origin, offer.sessionId);
    assert.strictEqual(fetched.ok, true, fetched.ok === false ? fetched.error : '');
    if (!fetched.ok) return;

    const accepted = await completeDeviceLinkAsResponder(
      fetched,
      passport.privateKeyHex,
      passport.xpub
    );
    assert.strictEqual(accepted.ok, true, accepted.ok === false ? accepted.error : '');

    const tick = await tickDeviceLinkOffer(desktop, offer);
    assert.strictEqual(tick.ok, true, tick.error);
    assert.strictEqual(tick.status, 'linked');
    assert.ok(tick.peerPubkey);

    const signed = await publishIdentityCrossSignKind({
      hubBase: hub.origin,
      privateKeyHex: passport.privateKeyHex,
      xpub: passport.xpub,
      peerPubkey: desktop.pubkey,
      nonce: offer.nonce
    });
    assert.strictEqual(signed.ok, true, signed.ok === false ? signed.error : '');
    assert.strictEqual(SIGN_TYPE, 'IdentityCrossSign');
  });
});
