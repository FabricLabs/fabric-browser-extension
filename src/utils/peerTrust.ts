'use strict';

/**
 * Peers the user signed in to (Passport peer sessions), by key: when Passport
 * first saw each, a name the user gave it, and the page origins it was used
 * from. Sealed under a MAC keyed from the unlocked master, like
 * `signedInSites`, so a forged entry is ignored.
 *
 * The prompt warns on a peer it has never seen, and on a page origin it has
 * never seen with that peer, unless the peer's signed challenge lists that
 * origin among its `homes`.
 */

import { privateGet, privateSet } from './privateStore';
import { openRecord, recordMacKey, sealRecord } from './recordSeal';

export const PEER_TRUST_KEY = 'fabric.passport.peers';
const RECORD_NAME = 'signed-in-peers';
const MAX_PEERS = 500;
const MAX_ORIGINS_PER_PEER = 32;
const MAX_NAME_CHARS = 64;

export type KnownPeer = { first: number; last: number; name: string | null; origins: string[] };

/** How the prompt presents a peer sign-in. */
export type PeerTrust = 'new_peer' | 'new_site' | 'home' | 'known';

/**
 * Pure: what the prompt should say about signing in to `peer` from `origin`.
 * `known` — signed in to this peer from this origin before; `home` — the
 * peer lists this origin; `new_site` — a known peer, from an origin it never
 * was used from; `new_peer` — never seen.
 */
export function peerTrustStatus (
  peers: Record<string, KnownPeer>,
  peer: string,
  origin: string | null,
  homes: readonly string[] = []
): PeerTrust {
  const known = peers[String(peer || '').toLowerCase()];
  if (origin && known && known.origins.includes(origin)) return 'known';
  if (origin && homes.includes(origin)) return known ? 'known' : 'home';
  if (!known) return 'new_peer';
  return origin ? 'new_site' : 'known';
}

/** Pure: the record after one more sign-in. */
export function withSignIn (
  peers: Record<string, KnownPeer>,
  peer: string,
  origin: string | null,
  now: number = Date.now(),
  name?: string | null
): Record<string, KnownPeer> {
  const id = String(peer || '').toLowerCase();
  const prev = peers[id];
  const origins = prev ? prev.origins.filter((o) => o !== origin) : [];
  if (origin) origins.unshift(origin);
  const cleanName = name != null ? String(name).trim().slice(0, MAX_NAME_CHARS) || null : null;
  const next: Record<string, KnownPeer> = Object.assign({}, peers, {
    [id]: {
      first: prev ? prev.first : now,
      last: now,
      name: cleanName != null ? cleanName : (prev ? prev.name : null),
      origins: origins.slice(0, MAX_ORIGINS_PER_PEER)
    }
  });
  return Object.fromEntries(Object.entries(next).sort((a, b) => b[1].last - a[1].last).slice(0, MAX_PEERS));
}

export async function readKnownPeers (master: string): Promise<Record<string, KnownPeer>> {
  if (!master || typeof chrome === 'undefined') return {};
  const data = await openRecord<Record<string, KnownPeer>>(await recordMacKey(master), RECORD_NAME, await privateGet(PEER_TRUST_KEY));
  return data && typeof data === 'object' ? data : {};
}

export async function rememberPeerSignIn (master: string, peer: string, origin: string | null, name?: string | null, now: number = Date.now()): Promise<void> {
  if (!master || typeof chrome === 'undefined') return;
  const next = withSignIn(await readKnownPeers(master), peer, origin, now, name);
  await privateSet(PEER_TRUST_KEY, await sealRecord(await recordMacKey(master), RECORD_NAME, next));
}
