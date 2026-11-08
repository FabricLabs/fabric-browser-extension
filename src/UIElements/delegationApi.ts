'use strict';

import { useCallback, useEffect, useState } from 'react';
import { DELEGATION_PAIRING_SESSION_KEY, DELEGATION_STATE } from '../constants/delegation';
import type { GrantView, LinkedSigner, PairingView, PendingView } from '../background/delegation';

export type SignerView = LinkedSigner & { given: GrantView[]; received: GrantView[] };

export type DelegationState = {
  ok: boolean;
  available: boolean;
  locked?: boolean;
  error?: string | null;
  pubkey?: string;
  network?: string;
  account?: number;
  signers?: SignerView[];
  given?: GrantView[];
  identityPeers?: string[];
  pending?: PendingView[];
  focus?: string | null;
  pairing?: PairingView | null;
};

/** Send a delegation message to the background; failures come back as `{ ok: false, error }`. */
export async function delegationCall<T extends Record<string, unknown> = Record<string, unknown>> (
  type: string,
  payload: Record<string, unknown> = {}
): Promise<T & { ok: boolean; error?: string }> {
  try {
    const res = await chrome.runtime.sendMessage({ type, ...payload });
    if (res && typeof res === 'object') return res as T & { ok: boolean; error?: string };
    return { ok: false, error: 'Passport did not answer' } as T & { ok: boolean; error?: string };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) } as T & { ok: boolean; error?: string };
  }
}

/** Live delegation state; refreshes when a pairing moves, every few seconds, or on `refresh`. */
export function useDelegationState (deps: unknown[] = []): { state: DelegationState | null; refresh: () => void } {
  const [state, setState] = useState<DelegationState | null>(null);
  const refresh = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void delegationCall<DelegationState>(DELEGATION_STATE).then((res) => setState(res as DelegationState));
  }, []);
  useEffect(() => {
    refresh();
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return undefined;
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && changes[DELEGATION_PAIRING_SESSION_KEY]) refresh();
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer = setInterval(refresh, 5000);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, [refresh, ...deps]); // eslint-disable-line react-hooks/exhaustive-deps
  return { state, refresh };
}

/** Linked signers that let this Passport ask them to sign in to sites. */
export function passportSigners (state: DelegationState | null): SignerView[] {
  if (!state || !Array.isArray(state.signers)) return [];
  return state.signers.filter((s) => s.received.some((g) => !g.revoked && g.scopes.includes('passport')));
}

/** Linked signers holding a federation grant from this Passport with a cosigner key, and one to us. */
export function walletSigners (state: DelegationState | null): Array<SignerView & { cosigner: string }> {
  if (!state || !Array.isArray(state.signers)) return [];
  const out: Array<SignerView & { cosigner: string }> = [];
  for (const s of state.signers) {
    const theirs = s.received.find((g) => !g.revoked && g.scopes.includes('federation') && g.cosigner);
    const ours = s.given.some((g) => !g.revoked && g.scopes.includes('federation'));
    if (theirs && ours && theirs.cosigner) out.push({ ...s, cosigner: theirs.cosigner });
  }
  return out;
}
