'use strict';

import React, { useMemo, useState } from 'react';
import { Button, Message, Modal } from 'semantic-ui-react';
import { DELEGATION_ANSWER } from '../constants/delegation';
import type { PendingView } from '../background/delegation';
import { loadFederationMember, saveFederationMember } from '../services/federations';
import { shortKey } from '../utils/fabricSiteMessage';
import { describeSite } from '../utils/siteIdentity';
import { delegationCall, useDelegationState } from './delegationApi';
import SiteName from './SiteName';
import { useArmDelay } from './useArmDelay';

type Props = {
  hubBase: string | null;
  cosignerHex: string | null;
};

const DISCLOSURE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  wallet: 'your wallet’s public keys (to see your balance)',
  cosigner: 'your co-signing key (to add you to shared wallets)'
});

/**
 * Requests linked signers send for this Passport to sign: a sign-in on their
 * behalf, a shared-wallet invitation or withdrawal, or another message. One at
 * a time; the one a notification was clicked for comes first.
 */
export default function DelegationRequestPrompt (props: Props): React.ReactElement | null {
  const { hubBase, cosignerHex } = props;
  const { state, refresh } = useDelegationState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [later, setLater] = useState<string[]>([]);

  const list = ((state && state.pending) || []).filter((p) => p.expiresAt > Date.now() && !later.includes(p.hash));
  const pending: PendingView | null = (state && state.focus && list.find((p) => p.hash === state.focus)) || list[0] || null;
  const armed = useArmDelay(pending ? pending.hash : '');
  const site = useMemo(() => (pending && pending.origin ? describeSite(pending.origin) : null), [pending ? pending.origin : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pending || (state && state.locked)) return null;

  const federationFrame = async (): Promise<string> => {
    if (!cosignerHex) throw new Error('Unlock Passport to co-sign a shared wallet.');
    if (!hubBase) throw new Error('Choose an active Fabric node to reach the shared wallet.');
    const member = await loadFederationMember(hubBase, cosignerHex);
    const frame = await member.answerDelegated(pending.inner);
    await saveFederationMember(member);
    return frame;
  };

  const answer = async (action: 'sign' | 'decline') => {
    setBusy(true);
    setError(null);
    try {
      const frame = action === 'sign' && pending.scope === 'federation' ? await federationFrame() : null;
      const res = await delegationCall(DELEGATION_ANSWER, { hash: pending.hash, action, frame });
      if (!res.ok) setError(res.error || 'Could not answer');
      else refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const from = pending.from.label || 'A linked signer';

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>{pending.title}</Modal.Header>
      <Modal.Content>
        <p>
          <strong>{from}</strong> ({shortKey(pending.from.pubkey)}) asks this Passport to sign.
        </p>
        {pending.scope === 'passport' ? (
          <>
            <p>Sign in on its behalf to:</p>
            {site ? <SiteName site={site} /> : <p>{pending.origin}</p>}
            {pending.disclose.length ? (
              <>
                <p style={{ marginTop: '0.75em' }}>It also asks to see:</p>
                <ul>
                  {pending.disclose.map((d) => <li key={d}>{DISCLOSURE_LABELS[d] || d}</li>)}
                </ul>
              </>
            ) : null}
          </>
        ) : pending.scope === 'federation' ? (
          <p>{pending.summary || 'A shared wallet asks for your co-signature.'}</p>
        ) : (
          <>
            {pending.summary ? <p>{pending.summary}</p> : null}
            <p style={{ fontSize: '0.85em' }}>Message type: <code>{pending.innerType}</code></p>
          </>
        )}
        <p style={{ fontSize: '0.85em', color: 'rgba(0,0,0,0.6)' }}>
          Expires {new Date(pending.expiresAt).toLocaleTimeString()}.
          {list.length > 1 ? ` ${list.length - 1} more waiting.` : ''}
        </p>
        {error ? <Message negative size="small">{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button disabled={busy} onClick={() => setLater((cur) => cur.concat(pending.hash))} content="Later" />
        <Button disabled={busy} onClick={() => void answer('decline')} content="Decline" />
        <Button primary loading={busy} disabled={busy || !armed} onClick={() => void answer('sign')} content="Sign" />
      </Modal.Actions>
    </Modal>
  );
}
