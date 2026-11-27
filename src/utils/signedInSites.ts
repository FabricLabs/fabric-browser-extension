'use strict';

/**
 * Sites the user signed in to, and which identity each one saw. Kept in
 * the extension's private store under a MAC keyed from the unlocked master, so a
 * forged entry is ignored.
 */

import { privateGet, privateSet } from './privateStore';
import { openRecord, recordMacKey, sealRecord } from './recordSeal';

export const SIGNED_IN_SITES_KEY = 'fabric.passport.sites';
const RECORD_NAME = 'signed-in-sites';
const MAX_SITES = 500;

/** `main`: the account identity; `pairwise`: this site's own; `linked`: a linked signer answered. */
export type SiteIdentityKind = 'main' | 'pairwise' | 'linked';

export type SignedInSite = { first: number; last: number; identity: SiteIdentityKind };

export async function readSignedInSites (master: string): Promise<Record<string, SignedInSite>> {
  if (!master || typeof chrome === 'undefined') return {};
  const data = await openRecord<Record<string, SignedInSite>>(await recordMacKey(master), RECORD_NAME, await privateGet(SIGNED_IN_SITES_KEY));
  return data && typeof data === 'object' ? data : {};
}

export async function rememberSignIn (master: string, origin: string, identity: SiteIdentityKind, now: number = Date.now()): Promise<void> {
  if (!master || typeof chrome === 'undefined') return;
  const sites = await readSignedInSites(master);
  const prev = sites[origin];
  sites[origin] = { first: prev ? prev.first : now, last: now, identity };
  const kept = Object.entries(sites).sort((a, b) => b[1].last - a[1].last).slice(0, MAX_SITES);
  const sealed = await sealRecord(await recordMacKey(master), RECORD_NAME, Object.fromEntries(kept));
  await privateSet(SIGNED_IN_SITES_KEY, sealed);
}
