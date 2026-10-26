'use strict';

/**
 * Passport's only key record: a core `FabricAccountVault` (the master xprv
 * sealed by the lock password, the current account + network, and the public
 * data of every pair used so far). One seed per Passport; accounts and
 * networks are derivation paths under it:
 *
 * - identity `m/44'/F'/n'/0/0` signs Fabric messages and Passport assertions;
 * - wallet `m/84'/B'/n'` (new addresses) and `m/44'/B'/n'` (watched);
 * - cosigner `m/87'/B'/n'/0/0` signs federation withdrawals.
 *
 * Unlocking opens the master into memory (and `chrome.storage.session`, which
 * content scripts cannot read, until auto-lock). No mnemonic, plaintext key,
 * or derivation path setting is ever stored.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./loadFabricPassport');

export const ACCOUNT_NETWORKS: readonly string[] = Object.freeze(['mainnet', 'testnet', 'testnet4', 'signet', 'regtest']);
export const LOCK_PASSWORD_MIN = 8;
export const MAX_ACCOUNT_INDEX = 0x7fffffff;
export const MAX_ACCOUNT_LABEL = 64;
/** `chrome.storage.session` key holding the open master while unlocked. */
export const PASSPORT_MASTER_SESSION_KEY = 'fabric.passport.master';
export const PASSPORT_BACKUP_TYPE = 'FabricPassportBackup';

export type AccountPair = { account: number; network: string };

export type PublicWallet = {
  segwit: { xpub: string; path?: string };
  standard: { xpub: string; path?: string };
  receive: 'segwit';
};

export type AccountView = {
  account: number;
  network: string;
  label: string;
  identity: { pubkey: string; id: string };
  wallet: PublicWallet;
  cosigner: { pubkey: string };
};

export type AccountVault = {
  type: 'FabricAccountVault';
  v: 2;
  seal: Record<string, unknown>;
  current: AccountPair;
  accounts: Record<string, AccountView>;
};

/** One vault pair as the popup shows it. Keys are present only for the current pair while unlocked. */
export type VaultIdentity = {
  id: string;
  bech32: string;
  publicKeyHex: string;
  /** Identity key xpub (current pair, unlocked only); for device links. */
  xpub: string;
  privateKeyHex?: string;
  name: string;
  isCurrent: boolean;
  loadedAt: string;
  hasPrivateKey: true;
  account: number;
  network: string;
  wallet: PublicWallet;
  cosignerPubkey: string;
};

/** What other extension contexts may read from `fabric_state` (no keys). */
export type PublicIdentity = {
  id: string;
  publicKeyHex: string;
  name: string;
  isCurrent: boolean;
  account: number;
  network: string;
};

function accountKeys () {
  if (!core || !core.accountKeys) throw new Error('Passport accounts are unavailable in this build');
  return core.accountKeys;
}

export function isAccountVault (record: unknown): record is AccountVault {
  const r = record as AccountVault | null;
  return !!(
    r &&
    typeof r === 'object' &&
    r.type === 'FabricAccountVault' &&
    r.v === 2 &&
    r.seal && typeof r.seal === 'object' &&
    r.current && typeof r.current === 'object' &&
    r.accounts && typeof r.accounts === 'object'
  );
}

/** Canonical account network, or '' when unknown. */
export function accountNetwork (network: unknown): string {
  try {
    return accountKeys().normalizeAccountNetwork(network);
  } catch {
    return '';
  }
}

/** Account index, or -1 when invalid. */
export function accountIndex (value: unknown): number {
  if (value === '' || value == null) return -1;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_ACCOUNT_INDEX ? n : -1;
}

export function pairKey (pair: AccountPair): string {
  return `${accountNetwork(pair.network)}:${accountIndex(pair.account)}`;
}

function assertPair (pair: Partial<AccountPair>): AccountPair {
  const network = accountNetwork(pair.network);
  if (!network) throw new RangeError(`Unknown network: ${String(pair.network)}`);
  const account = accountIndex(pair.account);
  if (account < 0) throw new RangeError('Account must be a whole number from 0 to 2147483647.');
  return { account, network };
}

export function assertLockPassword (lockPassword: unknown): string {
  const pwd = String(lockPassword ?? '');
  if (pwd.trim().length < LOCK_PASSWORD_MIN) {
    throw new Error(`The lock password must be at least ${LOCK_PASSWORD_MIN} characters.`);
  }
  return pwd;
}

/** A new 24-word seed phrase. Shown once for backup; never stored. */
export function generateSeedPhrase (): string {
  return accountKeys().generateMnemonic(256);
}

export function normalizeSeedPhrase (phrase: unknown): string {
  return String(phrase ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Master xprv from a seed phrase and its optional BIP39 passphrase (the derivation password). */
export function masterFromSeedPhrase (phrase: string, passphrase = ''): string {
  return accountKeys().importSeed(normalizeSeedPhrase(phrase), passphrase);
}

/** Master xprv from an imported xprv / tprv; only a depth-0 (master) key is accepted. */
export function masterFromXprv (xprv: string): string {
  return accountKeys().normalizeMasterXprv(String(xprv || '').trim());
}

export function createVault (params: { master: string; lockPassword: string; account?: number; network?: string; label?: string }): AccountVault {
  const lockPassword = assertLockPassword(params.lockPassword);
  const pair = assertPair({ account: params.account ?? 0, network: params.network || 'mainnet' });
  return accountKeys().createAccountVault({
    master: params.master,
    lockPassword,
    account: pair.account,
    network: pair.network,
    label: params.label ? String(params.label).slice(0, MAX_ACCOUNT_LABEL) : undefined
  });
}

/** Open the sealed master with the lock password. Throws on a wrong password. */
export function unlockVault (vault: AccountVault, lockPassword: string): string {
  if (!isAccountVault(vault)) throw new TypeError('Passport vault required');
  return accountKeys().unsealMaster(vault.seal, String(lockPassword ?? ''));
}

/**
 * Switch to another account and/or network. With the master any pair derives
 * (and is cached); locked, only pairs already in the vault.
 */
export function switchAccount (vault: AccountVault, params: Partial<AccountPair> & { master?: string | null; label?: string }): AccountVault {
  if (!isAccountVault(vault)) throw new TypeError('Passport vault required');
  const pair = assertPair(params);
  return accountKeys().selectVaultAccount(vault, {
    account: pair.account,
    network: pair.network,
    master: params.master || undefined,
    label: params.label != null ? String(params.label).slice(0, MAX_ACCOUNT_LABEL) : undefined
  });
}

/** Rename a cached pair without changing the current one. */
export function renameAccount (vault: AccountVault, pair: AccountPair, label: string): AccountVault {
  if (!isAccountVault(vault)) throw new TypeError('Passport vault required');
  const key = pairKey(assertPair(pair));
  const view = vault.accounts[key];
  if (!view) return vault;
  const name = String(label ?? '').trim().slice(0, MAX_ACCOUNT_LABEL) || `Account ${view.account}`;
  return { ...vault, accounts: { ...vault.accounts, [key]: { ...view, label: name } } };
}

export function currentView (vault: AccountVault | null): AccountView | null {
  if (!isAccountVault(vault)) return null;
  return vault.accounts[pairKey(vault.current)] || null;
}

/** Cached pairs, by network then account. */
export function vaultAccounts (vault: AccountVault | null): AccountView[] {
  if (!isAccountVault(vault)) return [];
  return Object.values(vault.accounts)
    .filter((v): v is AccountView => !!(v && v.identity && v.wallet))
    .sort((a, b) => (a.network === b.network ? a.account - b.account : a.network.localeCompare(b.network)));
}

function derive (master: string, pair: AccountPair) {
  return accountKeys().deriveAccount(master, { account: pair.account, network: pair.network });
}

/** 32-byte private key hex of a core Key (its BIP32 node), or ''. */
function privateKeyHexOf (key: unknown): string {
  const k = key as { master?: { privateKey?: Uint8Array } } | null;
  const raw = k && k.master ? k.master.privateKey : null;
  return raw && raw.length === 32 ? Buffer.from(raw).toString('hex') : '';
}

function xpubOf (key: unknown): string {
  const k = key as { xpub?: string } | null;
  return k && typeof k.xpub === 'string' ? k.xpub : '';
}

/**
 * Every cached pair as a popup identity. With the master, the current pair
 * carries its identity private key and xpub; nothing else does.
 */
export function vaultIdentities (vault: AccountVault | null, master: string | null, loadedAt = ''): VaultIdentity[] {
  if (!isAccountVault(vault)) return [];
  const currentKey = pairKey(vault.current);
  return vaultAccounts(vault).map((view) => {
    const isCurrent = pairKey(view) === currentKey;
    const row: VaultIdentity = {
      id: view.identity.id,
      bech32: view.identity.id,
      publicKeyHex: view.identity.pubkey,
      xpub: '',
      name: view.label || `Account ${view.account}`,
      isCurrent,
      loadedAt,
      hasPrivateKey: true,
      account: view.account,
      network: view.network,
      wallet: view.wallet,
      cosignerPubkey: view.cosigner ? view.cosigner.pubkey : ''
    };
    if (isCurrent && master) {
      const key = derive(master, view).identity.key;
      const pk = privateKeyHexOf(key);
      if (pk) row.privateKeyHex = pk;
      row.xpub = xpubOf(key);
    }
    return row;
  });
}

/** Private key hex of a pair's cosigner (`m/87'/B'/n'/0/0`), for federation signing. */
export function cosignerPrivateKeyHex (master: string | null, pair: AccountPair | null): string | null {
  if (!master || !pair) return null;
  const hex = privateKeyHexOf(derive(master, assertPair(pair)).cosigner.key);
  return hex || null;
}

/** The public rows other extension contexts read (e.g. the `X-Fabric-Identity` header). */
export function publicIdentities (vault: AccountVault | null): PublicIdentity[] {
  return vaultIdentities(vault, null).map((row) => ({
    id: row.id,
    publicKeyHex: row.publicKeyHex,
    name: row.name,
    isCurrent: row.isCurrent,
    account: row.account,
    network: row.network
  }));
}

/** Backup file: the sealed vault only (no mnemonic, no unsealed key). */
export function vaultBackup (vault: AccountVault, now = Date.now()): { type: string; v: 2; createdAt: string; vault: AccountVault } {
  if (!isAccountVault(vault)) throw new TypeError('Passport vault required');
  return { type: PASSPORT_BACKUP_TYPE, v: 2, createdAt: new Date(now).toISOString(), vault };
}

/** Read a backup file; returns the vault or throws. */
export function readVaultBackup (data: unknown): AccountVault {
  const d = data as { type?: unknown; v?: unknown; vault?: unknown } | null;
  if (!d || d.type !== PASSPORT_BACKUP_TYPE || d.v !== 2 || !isAccountVault(d.vault)) {
    throw new Error('This is not a Passport v2 backup.');
  }
  if (!currentView(d.vault)) throw new Error('The backup has no current account.');
  return d.vault;
}

type SessionArea = { get (k: string): Promise<Record<string, unknown>>; set (v: Record<string, unknown>): Promise<void>; remove (k: string): Promise<void> };

function sessionArea (): SessionArea | null {
  const c = (globalThis as { chrome?: { storage?: { session?: SessionArea } } }).chrome;
  return c && c.storage && c.storage.session ? c.storage.session : null;
}

/** Keep the open master for other popup openings until auto-lock. */
export async function rememberMaster (master: string): Promise<void> {
  const area = sessionArea();
  if (area) await area.set({ [PASSPORT_MASTER_SESSION_KEY]: master });
}

export async function recallMaster (vault: AccountVault | null): Promise<string | null> {
  const area = sessionArea();
  if (!area || !isAccountVault(vault)) return null;
  const got = await area.get(PASSPORT_MASTER_SESSION_KEY);
  const master = typeof got[PASSPORT_MASTER_SESSION_KEY] === 'string' ? String(got[PASSPORT_MASTER_SESSION_KEY]) : '';
  if (!master) return null;
  try {
    const view = currentView(vault);
    if (!view || derive(master, view).identity.pubkey !== view.identity.pubkey) {
      await area.remove(PASSPORT_MASTER_SESSION_KEY);
      return null;
    }
    return accountKeys().normalizeMasterXprv(master);
  } catch {
    await area.remove(PASSPORT_MASTER_SESSION_KEY);
    return null;
  }
}

export async function forgetMaster (): Promise<void> {
  const area = sessionArea();
  if (area) await area.remove(PASSPORT_MASTER_SESSION_KEY);
}
