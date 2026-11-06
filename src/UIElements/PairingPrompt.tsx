'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Checkbox, Form, Message, Modal, TextArea } from 'semantic-ui-react';
import {
  DELEGATION_PAIR_CANCEL,
  DELEGATION_PAIR_CONFIRM,
  DELEGATION_PAIRING_GET,
  DELEGATION_PAIRING_SESSION_KEY,
  DELEGATION_SCOPE_LABELS
} from '../constants/delegation';
import type { PairingView } from '../background/delegation';
import { shortKey } from '../utils/fabricSiteMessage';
import { delegationCall } from './delegationApi';
import { useArmDelay } from './useArmDelay';

const SCOPES = Object.keys(DELEGATION_SCOPE_LABELS);
const DEFAULT_SCOPES = ['identity', 'passport'];

/**
 * The open pairing: the invitation to show, then the six-digit code once
 * both sides have committed. Matching codes grant the ticked scopes; nothing
 * is granted before that.
 */
export default function PairingPrompt (): React.ReactElement | null {
  const [pairing, setPairing] = useState<PairingView | null>(null);
  const [scopes, setScopes] = useState<string[]>(DEFAULT_SCOPES);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const armed = useArmDelay(pairing && pairing.sas ? `${pairing.id}|${pairing.sas}` : '');

  const pull = useCallback(() => {
    void delegationCall<{ pairing?: PairingView | null }>(DELEGATION_PAIRING_GET).then((res) => {
      setPairing(res && res.pairing ? res.pairing : null);
    });
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return undefined;
    pull();
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && changes[DELEGATION_PAIRING_SESSION_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    const timer = setInterval(pull, 1500);
    return () => {
      chrome.storage.onChanged.removeListener(onChange);
      clearInterval(timer);
    };
  }, [pull]);

  useEffect(() => {
    setScopes(DEFAULT_SCOPES);
    setError(null);
    setCopied(false);
  }, [pairing ? pairing.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!pairing || pairing.status === 'cancelled') return null;

  const call = async (type: string, payload: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    const res = await delegationCall(type, payload);
    setBusy(false);
    if (!res.ok) setError(res.error || 'Could not do that');
    pull();
  };

  const copy = async () => {
    if (!pairing.invitation) return;
    try {
      await navigator.clipboard.writeText(pairing.invitation);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const peer = pairing.peerName || 'The other signer';
  let body: React.ReactNode;
  let actions: React.ReactNode;

  if (pairing.status === 'failed') {
    body = <Message negative>{pairing.error || 'Linking failed. Start again from Linked signers.'}</Message>;
    actions = <Button onClick={() => void call(DELEGATION_PAIR_CANCEL)} content="Close" />;
  } else if (pairing.status === 'done') {
    body = (
      <Message positive>
        Linked with {peer}. It may ask you for: {pairing.scopes.map((s) => DELEGATION_SCOPE_LABELS[s] || s).join('; ') || 'nothing yet'}.
      </Message>
    );
    actions = <Button primary onClick={() => void call(DELEGATION_PAIR_CANCEL)} content="Close" />;
  } else if (pairing.status === 'granting') {
    body = <p>Saving the link…</p>;
    actions = null;
  } else if (pairing.status === 'confirm' && pairing.sas) {
    body = (
      <>
        <p>
          <strong>{peer}</strong>{pairing.peerPubkey ? ` (${shortKey(pairing.peerPubkey)})` : ''} should show this same code.
          If it shows anything else, someone is in the middle: press “The codes differ”.
        </p>
        <p style={{ fontSize: '2em', letterSpacing: '0.15em', textAlign: 'center', fontFamily: 'monospace' }}>{pairing.sas}</p>
        {pairing.localConfirmed ? (
          <p>Waiting for {peer} to confirm the code on its side.</p>
        ) : (
          <>
            <p>It may ask this Passport for:</p>
            {SCOPES.map((scope) => (
              <Checkbox
                key={scope}
                label={DELEGATION_SCOPE_LABELS[scope]}
                checked={scopes.includes(scope)}
                onChange={() => setScopes((cur) => cur.includes(scope) ? cur.filter((s) => s !== scope) : cur.concat(scope))}
                style={{ display: 'block', margin: '0.35em 0' }}
              />
            ))}
            <p style={{ fontSize: '0.85em', marginTop: '0.5em' }}>
              Every request still asks you first. You can withdraw any of these later.
            </p>
          </>
        )}
      </>
    );
    actions = (
      <>
        <Button disabled={busy} onClick={() => void call(DELEGATION_PAIR_CANCEL)} content="The codes differ" />
        {pairing.localConfirmed ? null : (
          <Button primary loading={busy} disabled={busy || !armed || scopes.length === 0}
            onClick={() => void call(DELEGATION_PAIR_CONFIRM, { scopes })} content="The codes match" />
        )}
      </>
    );
  } else if (pairing.invitation) {
    body = (
      <>
        <p>Paste this invitation into the other app (Fabric Hub, GoonCitizen, or another Passport):</p>
        <Form>
          <TextArea readOnly rows={4} value={pairing.invitation} style={{ fontFamily: 'monospace', fontSize: '0.8em' }} />
        </Form>
        <p style={{ marginTop: '0.5em' }}>A code appears here once it answers.</p>
      </>
    );
    actions = (
      <>
        <Button onClick={() => void call(DELEGATION_PAIR_CANCEL)} content="Cancel" />
        <Button onClick={() => void copy()} content={copied ? 'Copied' : 'Copy'} />
      </>
    );
  } else {
    body = <p>Waiting for {pairing.peerName || 'the other signer'}. The code appears here once both sides have committed.</p>;
    actions = <Button onClick={() => void call(DELEGATION_PAIR_CANCEL)} content="Cancel" />;
  }

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Link a signer</Modal.Header>
      <Modal.Content>
        {body}
        {error ? <Message negative size="small">{error}</Message> : null}
      </Modal.Content>
      {actions ? <Modal.Actions>{actions}</Modal.Actions> : null}
    </Modal>
  );
}
