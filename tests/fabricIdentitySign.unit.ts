'use strict';

import assert from 'assert';
import { buildClientSignedBody, fabricSigningIdentity, signingKeyOfAccount } from '../src/utils/fabricIdentitySign';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricPassport');

describe('fabricIdentitySign', function () {
  before(function () {
    if (!core.passport || !core.identitySchnorr) this.skip();
  });

  // Same strings as core functions/signingTags.
  const tags = () => ({ DEVICE_LINK: 'Fabric/DeviceLink', DEVICE_LINK_OFFER: 'Fabric/DeviceLinkOffer' });

  function account (n = 0, network = 'regtest') {
    const master = core.accountKeys.importSeed(core.accountKeys.generateMnemonic());
    return core.accountKeys.deriveAccount(master, { account: n, network });
  }

  it('signs with the identity key of the account and verifies only under the same tag', function () {
    const acct = account();
    const signer = signingKeyOfAccount(acct);
    const message = 'fabric:device-link:3:link:example';
    const body = buildClientSignedBody(message, tags().DEVICE_LINK, signer);
    assert.match(body.signature, /^[a-f0-9]{128}$/i);
    assert.strictEqual(body.pubkeyHex, acct.identity.pubkey);
    assert.strictEqual(body.identity.id, String(acct.identity.id));
    const ok = core.identitySchnorr.verifyIdentitySchnorr(message, body.signature, body.pubkeyHex, body.identity, tags().DEVICE_LINK);
    assert.strictEqual(ok.ok, true);
    const other = core.identitySchnorr.verifyIdentitySchnorr(message, body.signature, body.pubkeyHex, body.identity, tags().DEVICE_LINK_OFFER);
    assert.strictEqual(other.ok, false);
  });

  it('refuses to sign without a tag', function () {
    assert.throws(() => buildClientSignedBody('x', '', signingKeyOfAccount(account())), /tag/);
  });

  it('gives each account and network its own identity', function () {
    const master = core.accountKeys.importSeed(core.accountKeys.generateMnemonic());
    const a0 = fabricSigningIdentity(signingKeyOfAccount(core.accountKeys.deriveAccount(master, { account: 0, network: 'mainnet' })));
    const a1 = fabricSigningIdentity(signingKeyOfAccount(core.accountKeys.deriveAccount(master, { account: 1, network: 'mainnet' })));
    const t0 = fabricSigningIdentity(signingKeyOfAccount(core.accountKeys.deriveAccount(master, { account: 0, network: 'testnet' })));
    assert.notStrictEqual(a0.pubkeyHex, a1.pubkeyHex);
    assert.notStrictEqual(a0.pubkeyHex, t0.pubkeyHex);
    assert.notStrictEqual(a0.id, t0.id);
  });
});
