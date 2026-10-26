'use strict';

/**
 * After D-013 pairing, publish IdentityCrossSign so the mesh can union this
 * Passport key with the peer device. Does not copy a mnemonic.
 */

import { REVOKE_TYPE, SIGN_TYPE, signCrossSign } from './identityCrossSign';
import type { CrossSignBinding } from './identityCrossSign';
import { swallowNonFatal } from './nonFatal';

function bases (origin: string): string[] {
  const base = String(origin || '').replace(/\/$/, '');
  return [
    `${base}/identity/cross-sign`,
    `${base}/services/star-citizen/identity/cross-sign`
  ];
}

export type CrossSignKind = typeof SIGN_TYPE | typeof REVOKE_TYPE;

/**
 * Sign for the device-link session in `binding` (its id, nonce, and the Hub
 * origin it was made on) and POST to `hubBase`.
 */
export async function publishIdentityCrossSignKind (opts: {
  hubBase: string;
  privateKeyHex: string;
  xpub: string;
  peerPubkey: string;
  binding: CrossSignBinding;
  kind?: CrossSignKind;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const kind = opts.kind || SIGN_TYPE;
  let body: Record<string, unknown>;
  try {
    body = signCrossSign(
      { privateKeyHex: opts.privateKeyHex, xpub: opts.xpub },
      { ...opts.binding, peerPubkey: opts.peerPubkey },
      kind
    );
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  let last = 'no hub';
  for (const url of bases(opts.hubBase)) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        cache: 'no-store'
      });
      if (res.ok) return { ok: true };
      last = `HTTP ${res.status}`;
    } catch (err: unknown) {
      last = err instanceof Error ? err.message : String(err);
      swallowNonFatal('identity-cross-sign', err);
    }
  }
  return { ok: false, error: last };
}

export async function publishIdentityCrossSign (opts: {
  hubBase: string;
  privateKeyHex: string;
  xpub: string;
  peerPubkey: string;
  binding: CrossSignBinding;
}): Promise<void> {
  await publishIdentityCrossSignKind(opts);
}
