'use strict';

/**
 * Canonical IdentityCrossSign strings — `@fabric/core/functions/identityCrossSign`.
 * TS re-export so webpack does not pull Hub Node.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('@fabric/core/functions/identityCrossSign');

export const CROSS_SIGN_PREFIX: string = core.CROSS_SIGN_PREFIX;
export const REVOKE_PREFIX: string = core.REVOKE_PREFIX;
export const SIGN_TYPE: string = core.SIGN_TYPE;
export const REVOKE_TYPE: string = core.REVOKE_TYPE;

export function buildCrossSignMessage (
  nonce: string,
  localPubkey: string,
  peerPubkey: string
): string | null {
  return core.buildCrossSignMessage(nonce, localPubkey, peerPubkey);
}

export function buildRevokeMessage (
  nonce: string,
  localPubkey: string,
  peerPubkey: string
): string | null {
  return core.buildRevokeMessage(nonce, localPubkey, peerPubkey);
}
