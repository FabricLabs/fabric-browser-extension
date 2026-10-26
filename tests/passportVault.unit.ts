'use strict';

import assert from 'assert';
import {
  createVault,
  cosignerPrivateKeyHex,
  currentView,
  forgetMaster,
  generateSeedPhrase,
  masterFromSeedPhrase,
  masterFromXprv,
  pairKey,
  publicIdentities,
  readVaultBackup,
  recallMaster,
  rememberMaster,
  renameAccount,
  switchAccount,
  unlockVault,
  vaultAccounts,
  vaultBackup,
  vaultIdentities,
  PASSPORT_MASTER_SESSION_KEY
} from '../src/utils/passportVault';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../src/utils/loadFabricPassport');

const LOCK = 'correct horse battery';

describe('passportVault', function () {
  this.timeout(20000);

  before(function () {
    if (!core.accountKeys) this.skip();
  });

  it('derives a different master for each BIP39 passphrase', function () {
    const phrase = generateSeedPhrase();
    const plain = masterFromSeedPhrase(phrase);
    assert.strictEqual(masterFromSeedPhrase(`  ${phrase.toUpperCase()} `), plain);
    assert.notStrictEqual(masterFromSeedPhrase(phrase, 'second password'), plain);
    assert.strictEqual(masterFromXprv(plain), plain);
    assert.throws(() => masterFromSeedPhrase('not a real phrase'));
  });

  it('accepts only a master (depth 0) private key', function () {
    const master = masterFromSeedPhrase(generateSeedPhrase());
    const child = core.accountKeys.deriveAccount(master, { account: 0, network: 'mainnet' }).wallet.segwit.xpub;
    assert.throws(() => masterFromXprv(child));
  });

  it('seals the master under the lock password and keeps only public material in the clear', function () {
    const master = masterFromSeedPhrase(generateSeedPhrase());
    const vault = createVault({ master, lockPassword: LOCK });
    assert.throws(() => createVault({ master, lockPassword: 'short' }));
    const text = JSON.stringify(vault);
    assert.ok(!text.includes(master));
    assert.ok(!/xprv|tprv/.test(text));
    assert.strictEqual(unlockVault(vault, LOCK), master);
    assert.throws(() => unlockVault(vault, 'wrong password'));
    const view = currentView(vault);
    assert.ok(view);
    assert.strictEqual(view && view.account, 0);
    assert.strictEqual(view && view.network, 'mainnet');
  });

  it('switches account and network under one master, each with its own identity', function () {
    const master = masterFromSeedPhrase(generateSeedPhrase());
    let vault = createVault({ master, lockPassword: LOCK });
    const main0 = currentView(vault);
    vault = switchAccount(vault, { account: 0, network: 'testnet', master });
    const test0 = currentView(vault);
    vault = switchAccount(vault, { account: 3, network: 'testnet', master, label: 'Trading' });
    const test3 = currentView(vault);
    assert.ok(main0 && test0 && test3);
    if (!main0 || !test0 || !test3) return;
    assert.notStrictEqual(main0.identity.pubkey, test0.identity.pubkey);
    assert.notStrictEqual(test0.identity.pubkey, test3.identity.pubkey);
    assert.notStrictEqual(main0.wallet.segwit.xpub, test0.wallet.segwit.xpub);
    assert.strictEqual(test3.label, 'Trading');
    assert.deepStrictEqual(vaultAccounts(vault).map(pairKey), ['mainnet:0', 'testnet:0', 'testnet:3']);

    const back = switchAccount(vault, { account: 0, network: 'mainnet' });
    assert.strictEqual(currentView(back)?.identity.pubkey, main0.identity.pubkey);
    assert.throws(() => switchAccount(vault, { account: 9, network: 'mainnet' }), (err: { code?: string }) => err.code === 'FABRIC_ACCOUNT_LOCKED');

    const renamed = renameAccount(vault, { account: 0, network: 'testnet' }, '  Spare  ');
    assert.strictEqual(renamed.accounts['testnet:0'].label, 'Spare');
    assert.strictEqual(pairKey(renamed.current), 'testnet:3');
  });

  it('gives the current pair its identity key only while unlocked, and never the wallet or cosigner key', function () {
    const master = masterFromSeedPhrase(generateSeedPhrase());
    let vault = createVault({ master, lockPassword: LOCK });
    vault = switchAccount(vault, { account: 1, network: 'regtest', master });
    const open = vaultIdentities(vault, master);
    const current = open.find((i) => i.isCurrent);
    const other = open.find((i) => !i.isCurrent);
    assert.ok(current && other);
    if (!current || !other) return;
    const keys = core.accountKeys.deriveAccount(master, { account: 1, network: 'regtest' });
    assert.match(String(current.privateKeyHex), /^[0-9a-f]{64}$/);
    assert.strictEqual(current.publicKeyHex, keys.identity.pubkey);
    assert.strictEqual(other.privateKeyHex, undefined);
    assert.strictEqual(vaultIdentities(vault, null).some((i) => i.privateKeyHex), false);

    const cosigner = cosignerPrivateKeyHex(master, current);
    assert.match(String(cosigner), /^[0-9a-f]{64}$/);
    assert.notStrictEqual(cosigner, current.privateKeyHex);
    assert.strictEqual(cosignerPrivateKeyHex(null, current), null);

    const pub = publicIdentities(vault);
    assert.deepStrictEqual(Object.keys(pub[0]).sort(), ['account', 'id', 'isCurrent', 'name', 'network', 'publicKeyHex']);
  });

  it('backs up the sealed vault only and reads it back', function () {
    const master = masterFromSeedPhrase(generateSeedPhrase());
    const vault = createVault({ master, lockPassword: LOCK });
    const backup = JSON.parse(JSON.stringify(vaultBackup(vault)));
    assert.ok(!JSON.stringify(backup).includes(master));
    const restored = readVaultBackup(backup);
    assert.strictEqual(unlockVault(restored, LOCK), master);
    assert.throws(() => readVaultBackup({ type: 'FabricPassportBackup', v: 1, vault }));
    assert.throws(() => readVaultBackup({ identities: [] }));
  });

  describe('session master', function () {
    let store: Record<string, unknown>;

    beforeEach(function () {
      store = {};
      (globalThis as { chrome?: unknown }).chrome = {
        storage: {
          session: {
            get: async (k: string) => (k in store ? { [k]: store[k] } : {}),
            set: async (v: Record<string, unknown>) => { Object.assign(store, v); },
            remove: async (k: string) => { delete store[k]; }
          }
        }
      };
    });

    afterEach(function () {
      delete (globalThis as { chrome?: unknown }).chrome;
    });

    it('recalls the master only for the vault it opens, and forgets it on lock', async function () {
      const master = masterFromSeedPhrase(generateSeedPhrase());
      const vault = createVault({ master, lockPassword: LOCK });
      await rememberMaster(master);
      assert.strictEqual(await recallMaster(vault), master);

      const other = createVault({ master: masterFromSeedPhrase(generateSeedPhrase()), lockPassword: LOCK });
      assert.strictEqual(await recallMaster(other), null);
      assert.ok(!(PASSPORT_MASTER_SESSION_KEY in store));

      await rememberMaster(master);
      await forgetMaster();
      assert.strictEqual(await recallMaster(vault), null);
    });
  });
});
