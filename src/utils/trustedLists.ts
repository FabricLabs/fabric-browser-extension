'use strict';

/**
 * Lists of places Passport trusts (extra Hubs, HTTP origins that get the
 * identity header), each sealed with a MAC keyed from the unlocked master
 * (`recordSeal`). The lists live in the extension's private store, which a
 * page's content script cannot open. An unsealed or forged list counts as
 * empty; while Passport is locked only the built-in defaults apply.
 */

import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import { isAccountVault, recallMaster } from './passportVault';
import { privateGet, privateSet } from './privateStore';
import { openRecord, recordMacKey, sealRecord } from './recordSeal';

/** MAC key for the open vault, or null while Passport is locked. */
export async function trustedListKey (): Promise<CryptoKey | null> {
  if (typeof chrome === 'undefined') return null;
  const state = await privateGet(FABRIC_STATE_STORAGE_KEY) as { vault?: unknown } | undefined;
  const vault = state && state.vault;
  if (!isAccountVault(vault)) return null;
  const master = await recallMaster(vault);
  return master ? recordMacKey(master) : null;
}

/** The list stored under `storageKey` when its MAC checks; `[]` otherwise. */
export async function readTrustedList (storageKey: string, key?: CryptoKey | null): Promise<string[]> {
  if (typeof chrome === 'undefined') return [];
  const mac = key === undefined ? await trustedListKey() : key;
  if (!mac) return [];
  const data = await openRecord<string[]>(mac, storageKey, await privateGet(storageKey));
  return Array.isArray(data) ? data.map((s) => String(s || '').trim()).filter(Boolean) : [];
}

/** Seal and store `list` under `storageKey`; needs Passport unlocked. */
export async function writeTrustedList (storageKey: string, list: string[], key?: CryptoKey | null): Promise<void> {
  const mac = key === undefined ? await trustedListKey() : key;
  if (!mac) throw new Error('Unlock Passport to change the places it trusts.');
  await privateSet(storageKey, await sealRecord(mac, storageKey, list));
}
