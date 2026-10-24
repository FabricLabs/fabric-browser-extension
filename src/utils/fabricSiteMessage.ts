'use strict';

/**
 * `fabric:` site login for Passport: read what a page asks for, check legacy
 * `fabric:hub-login:1` challenges, and sign responses with the Passport key or
 * wrap them for a linked desktop app.
 *
 * The page never names its own origin here: callers pass the origin the browser
 * reported (`event.origin` / `sender.origin`), and every request and response is
 * bound to it.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./loadFabricSiteLogin');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  parseDesktopLoginMessage,
  originsMatchForDesktopSession
} = require('@fabric/http/functions/fabricSiteLoginVerify');

/** Longest `fabric:` string a page may post (header + 32 KiB body, base64url). */
export const MAX_PAGE_FABRIC_CHARS = 48 * 1024;

export type PageSiteLoginRequest = {
  origin: string;
  nonce: string;
  purpose: string | null;
  issuedAt: number;
  expiresAt: number;
  /** x-only pubkey of the site key that signed the request, or null when unsigned. */
  siteAuthor: string | null;
  /** The request frame to pass on to a desktop signer (rebuilt when the page sent it unsigned). */
  requestUri: string;
};

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export function siteLoginAvailable (): boolean {
  return !!(core && core.siteLogin && core.fabricUri && core.Key);
}

/** Origin the browser reported for a runtime message sender (never page-supplied). */
export function originOfSender (sender: { origin?: string; url?: string } | null | undefined): string | null {
  if (!sender) return null;
  const raw = typeof sender.origin === 'string' && sender.origin !== 'null'
    ? sender.origin
    : (typeof sender.url === 'string' ? sender.url : '');
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.origin;
  } catch {
    return null;
  }
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

/**
 * Read a page's `fabric:` `SiteLoginRequest` against the origin the browser reported.
 * A site-signed request must name that origin; an unsigned one is rebuilt with it.
 */
export function readPageSiteLoginRequest (
  uri: unknown,
  realOrigin: string,
  now: number = Date.now()
): Result<{ request: PageSiteLoginRequest }> {
  if (!siteLoginAvailable()) return { ok: false, error: 'fabric_unavailable' };
  if (typeof uri !== 'string' || !uri || uri.length > MAX_PAGE_FABRIC_CHARS) {
    return { ok: false, error: 'invalid_fabric_message' };
  }
  const origin = core.siteLogin.normalizeSiteOrigin(realOrigin);
  if (!origin || !isSignableSiteOrigin(origin)) return { ok: false, error: 'origin_not_signable' };
  const read = core.siteLogin.readSiteLoginRequest(uri, { now });
  if (!read.ok) return { ok: false, error: String(read.error || 'invalid_site_login_request') };
  const r = read.request;
  let requestUri = uri;
  if (r.origin !== origin) {
    if (read.author) return { ok: false, error: 'origin_mismatch' };
    requestUri = core.siteLogin.createSiteLoginRequest({
      origin,
      nonce: r.nonce,
      purpose: r.purpose || undefined,
      ttlMs: Math.max(1000, r.expiresAt - now),
      now
    }).uri;
  }
  return {
    ok: true,
    request: {
      origin,
      nonce: String(r.nonce),
      purpose: r.purpose ? String(r.purpose) : null,
      issuedAt: r.issuedAt,
      expiresAt: r.expiresAt,
      siteAuthor: read.author || null,
      requestUri
    }
  };
}

/**
 * Check a legacy `fabric:hub-login:1` challenge before Passport signs it: the
 * session id and origin inside it must be the page's own.
 */
export function checkHubLoginChallenge (
  message: unknown,
  expected: { sessionId: string; origin: string }
): Result<{ nonce: string }> {
  const parsed = parseDesktopLoginMessage(typeof message === 'string' ? message : '');
  if (!parsed) return { ok: false, error: 'invalid_challenge' };
  if (String(parsed.sessionId).toLowerCase() !== String(expected.sessionId || '').toLowerCase()) {
    return { ok: false, error: 'session_mismatch' };
  }
  if (!originsMatchForDesktopSession(parsed.origin, expected.origin)) {
    return { ok: false, error: 'origin_mismatch' };
  }
  return { ok: true, nonce: String(parsed.nonce) };
}

/** Passport signing key (core `Key` from the same tree as the message helpers). */
export function passportSigningKey (privateKeyHex: string, xpub?: string | null): { key: any; xpub: string | null } {
  if (!siteLoginAvailable()) throw new Error('fabric: site login unavailable in this build');
  const hex = String(privateKeyHex || '').replace(/^0x/i, '');
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('private key required');
  const key = new core.Key({ private: hex });
  let matched: string | null = null;
  if (xpub) {
    try {
      const neutered = new core.Key({ xpub });
      if (String(neutered.pubkey).toLowerCase() === String(key.pubkey).toLowerCase()) matched = xpub;
    } catch { /* xpub is optional */ }
  }
  return { key, xpub: matched };
}

/**
 * Sign a `SiteLoginResponse` with the Passport identity.
 * The xpub is attached only when `includeXpub` (Hub logins need it; other sites do not).
 */
export function signPassportSiteLogin (params: {
  origin: string;
  nonce: string;
  privateKeyHex: string;
  xpub?: string | null;
  includeXpub?: boolean;
  now?: number;
}): { uri: string; identity: { id: string; pubkey: string; xpub: string | null } } {
  const { key, xpub } = passportSigningKey(params.privateKeyHex, params.xpub);
  const signed = core.siteLogin.signSiteLoginResponse({
    origin: params.origin,
    nonce: params.nonce,
    signer: 'passport',
    xpub: params.includeXpub ? xpub : null,
    now: params.now
  }, key);
  return { uri: signed.uri, identity: signed.identity };
}

/**
 * Wrap a site request for a linked desktop app. Signed by the Passport key so the
 * desktop can check this device is in its identity cluster.
 */
export function buildDesktopSignRequest (params: {
  origin: string;
  nonce: string;
  purpose?: string | null;
  expiresAt?: number;
  requestUri?: string | null;
  privateKeyHex: string;
  now?: number;
}): { uri: string; nonce: string; expiresAt: number; device: string } {
  const now = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const { key } = passportSigningKey(params.privateKeyHex);
  const requestUri = params.requestUri || core.siteLogin.createSiteLoginRequest({
    origin: params.origin,
    nonce: params.nonce,
    purpose: params.purpose || undefined,
    ttlMs: params.expiresAt ? Math.max(1000, params.expiresAt - now) : undefined,
    now
  }).uri;
  const wrapped = core.siteLogin.createFabricSignRequest({ request: requestUri, origin: params.origin, now }, key);
  return { uri: wrapped.uri, nonce: wrapped.nonce, expiresAt: wrapped.expiresAt, device: String(key.pubkey).slice(2) };
}

/** Verify a desktop's `SiteLoginResponse` before handing it to the page. */
export function verifyDesktopSiteLogin (uri: unknown, expected: {
  origin: string;
  nonce: string;
  pubkey: string;
  now?: number;
}): Result<{ identity: { id: string; pubkey: string; xpub: string | null }; signer: string }> {
  if (!siteLoginAvailable()) return { ok: false, error: 'fabric_unavailable' };
  const verified = core.siteLogin.verifySiteLoginResponse(uri, {
    origin: expected.origin,
    nonce: expected.nonce,
    now: expected.now,
    signers: ['hub', 'gooncitizen', 'desktop']
  });
  if (!verified.ok) return { ok: false, error: String(verified.error) };
  if (String(verified.identity.pubkey).toLowerCase() !== String(expected.pubkey || '').toLowerCase()) {
    return { ok: false, error: 'signed by a different desktop key' };
  }
  return { ok: true, identity: verified.identity, signer: verified.signer };
}

/** Short fingerprint for prompts. */
export function shortKey (hex: string | null | undefined): string {
  const s = String(hex || '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}
