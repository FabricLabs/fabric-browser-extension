'use strict';

/**
 * IdentityCrossSign v2 — `@fabric/core/functions/identityCrossSign` strings and
 * `identityCrossSignVerify` signing. Each one names the device-link session and
 * the Hub origin it was made on. TS re-export so webpack does not pull Hub Node.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('@fabric/core/functions/identityCrossSign');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const coreVerify = require('@fabric/core/functions/identityCrossSignVerify');

export const CROSS_SIGN_PREFIX: string = core.CROSS_SIGN_PREFIX;
export const REVOKE_PREFIX: string = core.REVOKE_PREFIX;
export const CROSS_SIGN_TAG: string = core.CROSS_SIGN_TAG;
export const REVOKE_TAG: string = core.REVOKE_TAG;
export const SIGN_TYPE: string = core.SIGN_TYPE;
export const REVOKE_TYPE: string = core.REVOKE_TYPE;

export type CrossSignBinding = {
  sessionId: string;
  nonce: string;
  origin: string;
};

export type CrossSignFields = CrossSignBinding & {
  localPubkey: string;
  peerPubkey: string;
};

export function buildCrossSignMessage (fields: CrossSignFields): string | null {
  return core.buildCrossSignMessage(fields);
}

export function buildRevokeMessage (fields: CrossSignFields & { revokedAt: number }): string | null {
  return core.buildRevokeMessage(fields);
}

/**
 * Signed IdentityCrossSign (or Revoke) object; the signer's own Fabric key is
 * `localPubkey`. Throws when a field is missing or malformed.
 */
export function signCrossSign (
  input: unknown,
  fields: CrossSignBinding & { peerPubkey: string; revokedAt?: number },
  kind: string = SIGN_TYPE
): Record<string, unknown> {
  return coreVerify.signCrossSign(input, fields, kind);
}

export function verifyCrossSignObject (
  object: unknown
): { ok: true; kind: string; record: Record<string, unknown> } | { ok: false; error: string } {
  return coreVerify.verifyCrossSignObject(object);
}
