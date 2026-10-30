'use strict';

/**
 * Passport v2 sign-in for the extension: read a page's `PASSPORT_CHALLENGE`,
 * sign a `PASSPORT_ASSERTION` with the identity key of the chosen account and
 * network, and check every assertion (this Passport's or a linked signer's)
 * before the page sees it. Asking a linked signer is `background/delegation.ts`.
 *
 * The page never names its own origin here: callers pass the origin the browser
 * reported (`sender.origin`), and every challenge and assertion is bound to it.
 */

import { pairwiseIndex } from './siteIdentity';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./loadFabricPassport');

/** Longest `fabric:` string a page may post (header + 32 KiB body, base64url). */
export const MAX_PAGE_FABRIC_CHARS = 48 * 1024;

/** What a site may ask Passport to share besides the identity. */
export type PassportDisclosure = 'wallet' | 'cosigner';

export const PASSPORT_SIGNER = 'passport';
export const DESKTOP_SIGNERS: readonly string[] = Object.freeze(['hub', 'gooncitizen']);

export type PageChallenge = {
  origin: string;
  nonce: string;
  purpose: string | null;
  issuedAt: number;
  expiresAt: number;
  /** Network the site requires, or null when the user picks. */
  network: string | null;
  request: PassportDisclosure[];
  /** sha256 of the challenge frame (what the assertion commits to). */
  hash: string;
  /** x-only pubkey of the site key that signed the challenge, or null when unsigned. */
  siteAuthor: string | null;
  uri: string;
};

export type VerifiedAssertion = {
  identity: { id: string; pubkey: string };
  network: string;
  signer: string;
  device: string | null;
  disclosed: PassportDisclosure[];
  expiresAt: number;
};

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export function passportAvailable (): boolean {
  return !!(core && core.passport && core.accountKeys && core.Key);
}

function requireCore (): void {
  if (!passportAvailable()) throw new Error('Passport is unavailable in this build');
}

/** http(s) origin of a URL, or null. */
export function originOfUrl (url: unknown): string | null {
  if (typeof url !== 'string' || !url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
}

/**
 * Origin the browser reported for a runtime message sender, never one the page
 * supplied. An opaque (`"null"`) origin is refused. Firefox reports no
 * `origin`, only the frame's `url`, which the browser fills in as well.
 */
export function originOfSender (sender: { origin?: string; url?: string } | null | undefined): string | null {
  if (!sender) return null;
  if (typeof sender.origin === 'string') return sender.origin === 'null' ? null : originOfUrl(sender.origin);
  return originOfUrl(sender.url);
}

/** True for loopback and HTTPS origins (the only sites Passport signs in to). */
export function isSignableSiteOrigin (origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol === 'https:') return true;
    const h = u.hostname.toLowerCase();
    return u.protocol === 'http:' && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1');
  } catch {
    return false;
  }
}

/** Read a page's `PASSPORT_CHALLENGE` against the origin the browser reported. */
export function readPageChallenge (
  uri: unknown,
  realOrigin: string,
  now: number = Date.now()
): Result<{ challenge: PageChallenge }> {
  if (!passportAvailable()) return { ok: false, error: 'passport_unavailable' };
  if (typeof uri !== 'string' || !/^fabric:/i.test(uri) || uri.length > MAX_PAGE_FABRIC_CHARS) {
    return { ok: false, error: 'invalid_challenge' };
  }
  const origin = core.passport.normalizeOrigin(realOrigin);
  if (!origin || !isSignableSiteOrigin(origin)) return { ok: false, error: 'origin_not_signable' };
  const read = core.passport.readChallenge(uri, { now });
  if (!read.ok) return { ok: false, error: String(read.error || 'invalid_challenge') };
  const c = read.challenge;
  if (c.origin !== origin) return { ok: false, error: 'origin_mismatch' };
  return {
    ok: true,
    challenge: {
      origin,
      nonce: String(c.nonce),
      purpose: c.purpose ? String(c.purpose) : null,
      issuedAt: Number(c.issuedAt),
      expiresAt: Number(c.expiresAt),
      network: c.network ? String(c.network) : null,
      request: (c.request || []) as PassportDisclosure[],
      hash: String(read.hash),
      siteAuthor: read.author || null,
      uri
    }
  };
}

/** Keys of one (account, network) pair of the unlocked master (core `deriveAccount`). */
export function deriveAccountKeys (masterXprv: string, pair: { account: number; network: string }): any {
  requireCore();
  return core.accountKeys.deriveAccount(masterXprv, { account: pair.account, network: pair.network });
}

/** Only what the challenge asked for and the user ticked, in core order. */
export function consentedDisclosures (request: readonly string[], ticked: readonly string[]): PassportDisclosure[] {
  const asked = new Set(request || []);
  const out: PassportDisclosure[] = [];
  for (const item of ['wallet', 'cosigner'] as PassportDisclosure[]) {
    if (asked.has(item) && (ticked || []).includes(item)) out.push(item);
  }
  return out;
}

/**
 * The identity key Passport shows `origin`: the account identity
 * (`m/7777'/F'/n'/0/0`), or with `pairwise` the site's own at
 * `m/7777'/F'/n'/0/<index from the origin>`.
 */
export function siteIdentityKey (
  masterXprv: string,
  pair: { account: number; network: string },
  origin: string,
  pairwise: boolean
): { key: any; pubkey: string } {
  const keys = deriveAccountKeys(masterXprv, pair);
  if (!pairwise) return { key: keys.identity.key, pubkey: String(keys.identity.pubkey).toLowerCase() };
  const path = String(keys.identity.path).replace(/\/0$/, `/${pairwiseIndex(origin)}`);
  const root = new core.Key({ xprv: core.accountKeys.normalizeMasterXprv(masterXprv) });
  const key = root.derive(path);
  return { key, pubkey: String(key.pubkey).toLowerCase() };
}

/**
 * Sign a `PASSPORT_ASSERTION` with this Passport's identity for the chosen
 * account and network (the site's own identity with `pairwise`). Wallet xpubs
 * and the cosigner key go only when listed in `disclose`.
 */
export function signPassportAssertion (params: {
  challenge: string;
  origin: string;
  masterXprv: string;
  account: number;
  network: string;
  pairwise?: boolean;
  disclose?: PassportDisclosure[];
  now?: number;
}): { uri: string; identity: { id: string; pubkey: string }; network: string; disclosed: PassportDisclosure[]; expiresAt: number } {
  const keys = deriveAccountKeys(params.masterXprv, { account: params.account, network: params.network });
  const signer = siteIdentityKey(params.masterXprv, params, params.origin, !!params.pairwise);
  const disclose = params.disclose || [];
  const signed = core.passport.signAssertion({
    challenge: params.challenge,
    origin: params.origin,
    signer: PASSPORT_SIGNER,
    network: keys.network,
    disclose,
    wallet: disclose.includes('wallet') ? keys.wallet : undefined,
    cosignerKey: disclose.includes('cosigner') ? keys.cosigner.key : undefined,
    now: params.now
  }, signer.key);
  return {
    uri: signed.uri,
    identity: signed.identity,
    network: signed.network,
    disclosed: signed.disclosed,
    expiresAt: signed.expiresAt
  };
}

/**
 * Verify an assertion before handing it to the page: bound to the challenge,
 * signed by an accepted signer, disclosing nothing it wasn't asked, and (for a
 * linked signer) signed by its key and naming this Passport as `device`.
 */
export function verifyPageAssertion (uri: unknown, expected: {
  origin: string;
  nonce: string;
  challengeHash: string;
  challengeExpiresAt: number;
  network?: string | null;
  allow: readonly string[];
  signers: readonly string[];
  pubkey?: string | null;
  device?: string | null;
  now?: number;
}): Result<{ assertion: VerifiedAssertion }> {
  if (!passportAvailable()) return { ok: false, error: 'passport_unavailable' };
  if (typeof uri !== 'string' || uri.length > MAX_PAGE_FABRIC_CHARS) return { ok: false, error: 'invalid assertion' };
  const verified = core.passport.verifyAssertion(uri, {
    origin: expected.origin,
    nonce: expected.nonce,
    challengeHash: expected.challengeHash,
    challengeExpiresAt: expected.challengeExpiresAt,
    network: expected.network || undefined,
    allow: [...expected.allow],
    signers: [...expected.signers],
    now: expected.now
  });
  if (!verified.ok) return { ok: false, error: String(verified.error) };
  const pubkey = String(verified.identity.pubkey).toLowerCase();
  if (expected.pubkey && pubkey !== String(expected.pubkey).toLowerCase()) {
    return { ok: false, error: 'signed by a different key than the one linked' };
  }
  if (expected.device && String(verified.device || '') !== String(expected.device).toLowerCase()) {
    return { ok: false, error: 'the linked signer answered for someone else' };
  }
  const disclosed: PassportDisclosure[] = [];
  if (verified.wallet) disclosed.push('wallet');
  if (verified.cosigner) disclosed.push('cosigner');
  return {
    ok: true,
    assertion: {
      identity: { id: String(verified.identity.id), pubkey },
      network: String(verified.network),
      signer: String(verified.signer),
      device: verified.device || null,
      disclosed,
      expiresAt: Number(verified.expiresAt)
    }
  };
}

/** What the user is about to share, in the words the prompt uses. */
export function describeDisclosures (disclose: readonly string[]): string[] {
  const out = ['Your Fabric identity (public key) for this site'];
  if (disclose.includes('wallet')) out.push('Your wallet: balance, history, and addresses (account xpubs)');
  if (disclose.includes('cosigner')) out.push('Your escrow key, for multisig with this site');
  return out;
}

/** Longest site-supplied purpose text a prompt shows. */
export const MAX_SITE_PURPOSE_CHARS = 140;

const HIDDEN_OR_REORDERING = /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb]/g;

/**
 * Site-supplied text as a prompt may show it: no control, invisible, or
 * direction-changing characters, whitespace collapsed, at most
 * {@link MAX_SITE_PURPOSE_CHARS}. Null when nothing is left.
 */
export function sanitizeSitePurpose (text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const flat = text.normalize('NFKC').replace(HIDDEN_OR_REORDERING, ' ').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > MAX_SITE_PURPOSE_CHARS
    ? `${chars.slice(0, MAX_SITE_PURPOSE_CHARS - 1).join('')}…`
    : flat;
}

/** Short fingerprint for prompts. */
export function shortKey (hex: string | null | undefined): string {
  const s = String(hex || '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
