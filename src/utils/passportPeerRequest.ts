'use strict';

/**
 * Mirrors `@fabric/http/functions/passportPeerRequest` for the extension
 * bundle: the `X-Fabric-Request` that authorizes one HTTP request as a
 * Passport peer session. A core `CONTRACT_MESSAGE` under the contract id
 * `sha256("@fabric/http:PassportRequest:1")`, signed by the session key, with
 * `recipient` the peer, `ref` the session id, and a JSON payload binding the
 * method, path and query, body hash, a one-time nonce, and a short lifetime.
 * Keep the two in step; `tests/passportPeer.unit.ts` checks this one.
 */

import { crypto as bcrypto } from 'bitcoinjs-lib';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('./loadFabricPassport');

function sha256Hex (bytes: Buffer): string {
  return Buffer.from(bcrypto.sha256(bytes)).toString('hex');
}

export const PASSPORT_REQUEST_CONTRACT = sha256Hex(Buffer.from('@fabric/http:PassportRequest:1', 'utf8'));
export const PASSPORT_REQUEST_TTL_MS = 60 * 1000;
const MAX_TARGET_LENGTH = 4096;

/** sha256 of an HTTP body, hex (the empty body when there is none). */
export function requestBodyHash (body: string | Buffer | null | undefined): string {
  const bytes = body == null ? Buffer.alloc(0) : (typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body));
  return sha256Hex(bytes);
}

/** Path and query as signed, or null. */
export function normalizeTarget (value: unknown): string | null {
  const text = String(value == null ? '' : value);
  if (!text.startsWith('/') || text.startsWith('//') || text.length > MAX_TARGET_LENGTH || /[\s#]/.test(text)) return null;
  return text;
}

/** Sign one HTTP request as a peer session; the result goes in `X-Fabric-Request`. */
export function createPeerRequest (params: {
  sessionId: string;
  peer: string;
  method: string;
  target: string;
  body?: string;
  now?: number;
}, sessionKey: any): { uri: string; nonce: string; expiresAt: number } {
  const sessionId = String(params.sessionId || '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sessionId)) throw new TypeError('sessionId required');
  const peer = String(params.peer || '').toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(peer)) throw new TypeError('peer must be a compressed pubkey');
  const method = String(params.method || '').toUpperCase();
  if (!/^[A-Z]{1,16}$/.test(method)) throw new TypeError('method required');
  const target = normalizeTarget(params.target);
  if (!target) throw new TypeError('target must be a path (and query)');
  const issuedAt = Number.isFinite(params.now) ? Number(params.now) : Date.now();
  const nonceBytes = new Uint8Array(32);
  crypto.getRandomValues(nonceBytes);
  const nonce = Buffer.from(nonceBytes).toString('hex');
  const payload = JSON.stringify({
    type: 'PassportRequest',
    v: 1,
    method,
    target,
    bodyHash: requestBodyHash(params.body),
    nonce,
    issuedAt,
    expiresAt: issuedAt + PASSPORT_REQUEST_TTL_MS
  });
  const message = core.Message.fromFields('CONTRACT_MESSAGE', {
    contract: PASSPORT_REQUEST_CONTRACT,
    payload,
    recipient: peer,
    ref: sessionId
  });
  message.signWithKey(sessionKey);
  return { uri: core.fabricUri.encodeFabricUri(message), nonce, expiresAt: issuedAt + PASSPORT_REQUEST_TTL_MS };
}
