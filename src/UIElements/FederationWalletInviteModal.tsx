'use strict';

/**
 * Review / accept or reject a multisig (federation) wallet invitation.
 * Mirrors Hub FederationContractInviteModal; uses @fabric/http builders via
 * federationWalletInvite helpers.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { Button, Header, Icon, List, Message, Modal, Segment } from 'semantic-ui-react';
import {
  FederationWalletInvite,
  formatInviteSpendingSummary,
  normalizeProposedPolicy,
  normalizeSpendingTerms,
  PUBKEY_RE,
  respondToMultisigWalletInvite
} from '../utils/federationWalletInvite';
import { swallowNonFatal } from '../utils/nonFatal';

export type FederationWalletInviteModalProps = {
  open: boolean;
  invite: FederationWalletInvite | null;
  hubBase: string | null;
  responderPubkey: string | null;
  /** Peer id/address to reply to when inviterHubId is missing. */
  replyPeerId?: string | null;
  onClose: () => void;
  onResolved?: (accept: boolean) => void;
};

export default function FederationWalletInviteModal (props: FederationWalletInviteModalProps) {
  const {
    open,
    invite,
    hubBase,
    responderPubkey,
    replyPeerId,
    onClose,
    onResolved
  } = props;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const spendingTerms = useMemo(
    () => (invite ? normalizeSpendingTerms(invite.spendingTerms) : null),
    [invite]
  );
  const proposedPolicy = useMemo(
    () => (invite ? normalizeProposedPolicy(invite.proposedPolicy) : null),
    [invite]
  );
  const capLine = useMemo(
    () => (invite ? formatInviteSpendingSummary(invite) : ''),
    [invite]
  );
  const pkOk = !!(responderPubkey && PUBKEY_RE.test(responderPubkey));

  const send = useCallback(async (accept: boolean) => {
    if (!invite || !hubBase) {
      onClose();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await respondToMultisigWalletInvite({
        hubBase,
        invite,
        accept,
        responderPubkey,
        toPeerId: replyPeerId || invite.inviterHubId
      });
      if (onResolved) onResolved(accept);
      onClose();
    } catch (err: unknown) {
      swallowNonFatal('federation-wallet-invite-respond', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [invite, hubBase, responderPubkey, replyPeerId, onClose, onResolved]);

  if (!open || !invite) return null;

  const note = invite.note ? String(invite.note) : '';
  const contractId = invite.contractId ? String(invite.contractId) : '';
  const termsSummary = invite.termsSummary ? String(invite.termsSummary).trim() : '';
  const walletName = invite.groupName || 'Shared multisig wallet';

  return (
    <Modal open={open} onClose={onClose} size='small' closeIcon>
      <Header>
        <Icon name='bitcoin' />
        Multisig wallet invitation
      </Header>
      <Modal.Content>
        <p style={{ marginTop: 0 }}>
          You were invited to co-sign a <strong>shared Bitcoin treasury</strong>
          {' '}(<em>{walletName}</em>). Review the spending limit and validator set
          before accepting — Accept sends your compressed pubkey to the inviter via
          the active Fabric hub.
        </p>
        {contractId ? (
          <p style={{ fontSize: '0.9em' }}>
            Contract id: <code style={{ wordBreak: 'break-all' }}>{contractId}</code>
          </p>
        ) : null}

        {(spendingTerms || capLine) ? (
          <Segment secondary>
            <Header as='h4' style={{ marginTop: 0 }}>Spending limit</Header>
            {capLine ? <p style={{ margin: '0.25em 0', fontWeight: 600 }}>{capLine}</p> : null}
            {spendingTerms ? (
              <p style={{ margin: '0.25em 0', color: '#555', fontSize: '0.9em' }}>
                Mode: <code>{spendingTerms.mode}</code>
                {' · '}
                Value: <code>{spendingTerms.value}</code>
                {spendingTerms.mode === 'percent' ? '%' : ' sats'}
              </p>
            ) : null}
          </Segment>
        ) : null}

        {termsSummary ? (
          <Segment>
            <Header as='h4' style={{ marginTop: 0 }}>Agreement</Header>
            <pre style={{
              margin: 0,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'inherit',
              fontSize: '0.9em',
              maxHeight: '10rem',
              overflow: 'auto'
            }}
            >
              {termsSummary}
            </pre>
          </Segment>
        ) : null}

        {proposedPolicy ? (
          <Segment>
            <Header as='h4' style={{ marginTop: 0 }}>Proposed signers</Header>
            <p style={{ margin: '0.25em 0 0.5em', color: '#555' }}>
              Threshold: <strong>{proposedPolicy.threshold}</strong> of{' '}
              <strong>{proposedPolicy.validators.length}</strong>
            </p>
            <List relaxed size='small' style={{ fontFamily: 'monospace', fontSize: '0.82em' }}>
              {proposedPolicy.validators.map((v, i) => (
                <List.Item key={v}>
                  <List.Content>
                    <List.Header>{`Signer ${i + 1}`}</List.Header>
                    <span style={{ wordBreak: 'break-all' }}>{v}</span>
                  </List.Content>
                </List.Item>
              ))}
            </List>
          </Segment>
        ) : (
          <Message warning size='small'>
            This invite has no proposedPolicy — accepting still notifies the inviter,
            but you should confirm the co-signer set out of band.
          </Message>
        )}

        {note ? <p><strong>Note:</strong> {note}</p> : null}

        {error ? <Message negative size='small'>{error}</Message> : null}

        <Message info size='small'>
          {pkOk ? (
            <p style={{ margin: 0, fontSize: '0.88em' }}>
              Pubkey that would be shared:{' '}
              <code style={{ wordBreak: 'break-all' }}>{responderPubkey}</code>
            </p>
          ) : (
            <p style={{ margin: 0 }}>
              Unlock a full identity (02/03… pubkey) before accepting.
            </p>
          )}
        </Message>
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => void send(false)} inverted color='grey' loading={busy} disabled={busy || !hubBase}>
          Reject
        </Button>
        <Button
          onClick={() => void send(true)}
          primary
          loading={busy}
          disabled={busy || !hubBase || !pkOk}
        >
          Accept (send pubkey)
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
