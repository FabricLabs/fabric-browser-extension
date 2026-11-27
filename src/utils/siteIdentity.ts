'use strict';

/**
 * How Passport names a site in its prompts, and which identity it shows the
 * site.
 *
 * - The registrable domain is what a user has to check, so prompts emphasize
 *   it and show the rest of the host quietly. Without a public-suffix list the
 *   common two-level registries (`co.uk`, `com.au`, …) are handled by rule.
 * - A site whose domain is a near miss of one the user already trusts or signed
 *   in to (one edit away, or the same after folding look-alike characters), or
 *   that uses international characters, gets a warning.
 * - A site the user never signed in to is badged as new.
 * - New sites get their own identity: `m/7777'/F'/n'/0/<index>` with the index
 *   from the origin, so two sites can't match up the user by key. Sites the
 *   user signed in to with the main identity, and trusted Hubs, keep it.
 */

import { Buffer } from 'buffer';
import { crypto as bcrypto } from 'bitcoinjs-lib';

/** Second-level labels under a two-letter country code where names are registered one level down. */
const SECOND_LEVEL = new Set(['ac', 'co', 'com', 'edu', 'go', 'gob', 'gov', 'govt', 'ltd', 'me', 'mil', 'ne', 'net', 'nic', 'or', 'org', 'plc', 'sch']);

const PAIRWISE_LABEL = 'fabric-passport:pairwise:1';

export type SiteView = {
  origin: string;
  scheme: string;
  /** Labels in front of the registrable domain, with the trailing dot (may be empty). */
  prefix: string;
  registrable: string;
  /** `:port` or empty. */
  port: string;
  /** The host has punycode (`xn--`) labels. */
  international: boolean;
  /** A trusted or signed-in domain this one imitates, or null. */
  lookalike: string | null;
  /** The user has not signed in to this origin before. */
  firstSeen: boolean;
};

function isIpOrLocal (host: string): boolean {
  return host === 'localhost' || /^[\d.]+$/.test(host) || host.includes(':') || !host.includes('.');
}

/** The domain someone registered: `www.example.co.uk` → `example.co.uk`. */
export function registrableDomain (hostname: string): string {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || isIpOrLocal(host)) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take = tld.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join('.');
}

/** Fold characters people mistake for one another. */
export function skeleton (domain: string): string {
  return String(domain || '').toLowerCase()
    .replace(/rn/g, 'm')
    .replace(/vv/g, 'w')
    .replace(/cl/g, 'd')
    .replace(/0/g, 'o')
    .replace(/[1il|]/g, 'l')
    .replace(/5/g, 's')
    .replace(/8/g, 'b')
    .replace(/-/g, '');
}

function editDistanceAtMostOne (a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/** The known domain `registrable` imitates, or null. */
export function lookalikeOf (registrable: string, known: readonly string[]): string | null {
  const mine = String(registrable || '').toLowerCase();
  if (!mine || isIpOrLocal(mine)) return null;
  const name = mine.split('.')[0];
  for (const other of known) {
    const theirs = registrableDomain(hostOf(other));
    if (!theirs || theirs === mine || isIpOrLocal(theirs)) continue;
    if (skeleton(theirs) === skeleton(mine)) return theirs;
    const theirName = theirs.split('.')[0];
    // Same name under another TLD, or one character off.
    if (theirName.length >= 4 && (theirName === name || editDistanceAtMostOne(theirName, name))) return theirs;
  }
  return null;
}

function hostOf (raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return String(raw || '').toLowerCase();
  }
}

/**
 * Describe `origin` for a prompt.
 * @param known Origins (or hosts) the user trusts or signed in to.
 * @param signedIn Origins the user signed in to before.
 */
export function describeSite (origin: string, known: readonly string[] = [], signedIn: readonly string[] = []): SiteView {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return { origin, scheme: '', prefix: '', registrable: origin, port: '', international: false, lookalike: null, firstSeen: true };
  }
  const host = u.hostname.toLowerCase();
  const registrable = registrableDomain(host);
  const prefix = host.endsWith(registrable) ? host.slice(0, host.length - registrable.length) : '';
  return {
    origin: u.origin,
    scheme: u.protocol.replace(/:$/, ''),
    prefix,
    registrable,
    port: u.port ? `:${u.port}` : '',
    international: host.split('.').some((l) => l.startsWith('xn--')),
    lookalike: lookalikeOf(registrable, known.map(hostOf)),
    firstSeen: !signedIn.includes(u.origin)
  };
}

/** Child index of the identity Passport shows `origin` (never 0, the main identity). */
export function pairwiseIndex (origin: string): number {
  const digest = bcrypto.sha256(Buffer.from(`${PAIRWISE_LABEL}\n${String(origin)}`, 'utf8'));
  const index = digest.readUInt32BE(0) & 0x7fffffff;
  return index === 0 ? 1 : index;
}
