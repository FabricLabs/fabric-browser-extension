'use strict';

/**
 * Canonical IdentityCrossSign strings — lockstep with
 * `@fabric/hub/functions/identityCrossSign.js` (and GoonCitizen until it
 * requires the Hub export). TS copy is required: webpack must not pull Hub Node.
 */

export const CROSS_SIGN_PREFIX = 'fabric:identity-cross-sign:1';
export const REVOKE_PREFIX = 'fabric:identity-cross-sign-revoke:1';
export const SIGN_TYPE = 'IdentityCrossSign';
export const REVOKE_TYPE = 'IdentityCrossSignRevoke';

function normHex (value: string): string {
  return String(value || '').trim().toLowerCase().replace(/^0x/, '');
}

function normNonce (nonce: string): string | null {
  const n = normHex(nonce);
  if (!/^[a-f0-9]{64}$/.test(n)) return null;
  return n;
}

export function buildCrossSignMessage (
  nonce: string,
  localPubkey: string,
  peerPubkey: string
): string | null {
  const n = normNonce(nonce);
  const local = normHex(localPubkey);
  const peer = normHex(peerPubkey);
  if (!n || !local || !peer) return null;
  return `${CROSS_SIGN_PREFIX}:${n}:${local}:${peer}`;
}

export function buildRevokeMessage (
  nonce: string,
  localPubkey: string,
  peerPubkey: string
): string | null {
  const n = normNonce(nonce);
  const local = normHex(localPubkey);
  const peer = normHex(peerPubkey);
  if (!n || !local || !peer) return null;
  return `${REVOKE_PREFIX}:${n}:${local}:${peer}`;
}
