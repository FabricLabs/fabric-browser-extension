'use strict';

/**
 * After D-013 pairing, publish IdentityCrossSign so the mesh can union this
 * Passport key with the peer device. Does not copy a mnemonic.
 */

import { buildClientSignedLoginBody } from './fabricSiteLoginSign';
import {
  buildCrossSignMessage,
  buildRevokeMessage,
  REVOKE_TYPE,
  SIGN_TYPE
} from './identityCrossSign';
import { swallowNonFatal } from './nonFatal';

function bases (origin: string): string[] {
  const base = String(origin || '').replace(/\/$/, '');
  return [
    `${base}/identity/cross-sign`,
    `${base}/services/star-citizen/identity/cross-sign`
  ];
}

export type CrossSignKind = typeof SIGN_TYPE | typeof REVOKE_TYPE;

export async function publishIdentityCrossSignKind (opts: {
  hubBase: string;
  privateKeyHex: string;
  xpub: string;
  peerPubkey: string;
  nonce: string;
  kind?: CrossSignKind;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const kind = opts.kind || SIGN_TYPE;
  const probe = buildClientSignedLoginBody('fabric:device-link:id-probe', opts.privateKeyHex, opts.xpub);
  const localPubkey = probe.pubkeyHex;
  const message = kind === REVOKE_TYPE
    ? buildRevokeMessage(opts.nonce, localPubkey, opts.peerPubkey)
    : buildCrossSignMessage(opts.nonce, localPubkey, opts.peerPubkey);
  if (!message) return { ok: false, error: 'invalid cross-sign fields' };
  const signed = buildClientSignedLoginBody(message, opts.privateKeyHex, opts.xpub);
  const body = {
    type: kind,
    '@type': kind,
    localPubkey,
    peerPubkey: opts.peerPubkey,
    nonce: opts.nonce,
    createdAt: new Date().toISOString(),
    signature: signed.signature,
    pubkeyHex: signed.pubkeyHex,
    identity: signed.identity
  };
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
  nonce: string;
}): Promise<void> {
  await publishIdentityCrossSignKind(opts);
}
