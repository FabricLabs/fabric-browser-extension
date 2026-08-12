'use strict';

/**
 * Create and send a multisig wallet invitation to a connected Hub peer.
 * Uses `@fabric/http` invite JSON + Hub `SendPeerMessage` (same as Hub
 * FederationCoSignerSessionPanel).
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Button, Dropdown, Form, Header, Icon, Message, Segment
} from 'semantic-ui-react';
import {
  HubPeerRow,
  listHubPeersForInvite,
  publishMultisigWalletInvite,
  PUBKEY_RE
} from '../utils/federationWalletInvite';
import { swallowNonFatal } from '../utils/nonFatal';

export type MultisigWalletInvitePanelProps = {
  hubBase: string | null;
  inviterPubkey: string | null;
  /** Hub Fabric peer id when known (from GetNetworkStatus). */
  inviterHubId?: string | null;
  disabled?: boolean;
};

export default function MultisigWalletInvitePanel (props: MultisigWalletInvitePanelProps) {
  const { hubBase, inviterPubkey, inviterHubId, disabled } = props;
  const [peers, setPeers] = useState<HubPeerRow[]>([]);
  const [peerChoice, setPeerChoice] = useState('');
  const [peerPubkey, setPeerPubkey] = useState('');
  const [threshold, setThreshold] = useState('2');
  const [spendMode, setSpendMode] = useState<'percent' | 'sats'>('percent');
  const [spendValue, setSpendValue] = useState('10');
  const [walletName, setWalletName] = useState('Shared wallet');
  const [note, setNote] = useState('');
  const [termsSummary, setTermsSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refreshPeers = useCallback(async () => {
    if (!hubBase) {
      setPeers([]);
      return;
    }
    try {
      const list = await listHubPeersForInvite(hubBase);
      setPeers(list);
    } catch (e: unknown) {
      swallowNonFatal('multisig-list-peers', e);
      setPeers([]);
    }
  }, [hubBase]);

  useEffect(() => {
    void refreshPeers();
  }, [refreshPeers]);

  const sendInvite = useCallback(async () => {
    setMsg(null);
    setErr(null);
    if (!hubBase) {
      setErr('Connect an active Fabric hub first (Settings → Fabric Nodes).');
      return;
    }
    if (!inviterPubkey || !PUBKEY_RE.test(inviterPubkey)) {
      setErr('Unlock a compressed secp256k1 identity to invite co-signers.');
      return;
    }
    if (!peerChoice) {
      setErr('Select a connected peer to invite.');
      return;
    }
    const pkPeer = peerPubkey.trim();
    if (pkPeer && !PUBKEY_RE.test(pkPeer)) {
      setErr('Peer pubkey must be 02/03 + 64 hex (or leave blank).');
      return;
    }
    setBusy(true);
    try {
      const thr = Math.max(1, parseInt(threshold, 10) || 1);
      const { inviteId } = await publishMultisigWalletInvite({
        hubBase,
        peerIdOrAddress: peerChoice,
        inviterHubId: inviterHubId || inviterPubkey,
        inviterPubkey,
        peerPubkey: pkPeer || null,
        threshold: thr,
        spendingTerms: {
          mode: spendMode,
          value: Number(spendValue)
        },
        note: note || undefined,
        termsSummary: termsSummary || undefined,
        groupName: walletName || 'Shared wallet'
      });
      setMsg(`Multisig invite sent (${inviteId.slice(0, 12)}…). Peer can accept in Passport or Hub.`);
      setNote('');
    } catch (e: unknown) {
      swallowNonFatal('multisig-publish-invite', e);
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [
    hubBase, inviterPubkey, inviterHubId, peerChoice, peerPubkey, threshold,
    spendMode, spendValue, note, termsSummary, walletName
  ]);

  const peerOptions = peers.map((p) => ({
    key: p.address || p.id,
    value: p.address || p.id,
    text: p.label
      ? `${p.label} (${(p.address || p.id).slice(0, 18)}…)`
      : ((p.address || p.id).slice(0, 28) + (p.address && p.address.length > 28 ? '…' : ''))
  }));

  return (
    <Segment inverted style={{ marginTop: '1em', background: '#2a2b2d', border: '1px solid rgba(255,255,255,0.12)', color: 'rgba(255,255,255,0.92)' }}>
      <Header as='h4' inverted style={{ marginTop: 0 }}>
        <Icon name='users' />
        Multisig wallet invite
      </Header>
      <p style={{ fontSize: '0.8em', color: 'rgba(255,255,255,0.65)', marginTop: 0 }}>
        Invite a connected Fabric peer to co-sign a shared treasury. Builds the same
        FederationContractInvite JSON as hub.fabric.pub /{' '}
        <code style={{ fontSize: '0.9em' }}>@fabric/http</code>
        {' '}and delivers it over Hub{' '}
        <code style={{ fontSize: '0.9em' }}>SendPeerMessage</code>.
      </p>
      <Form inverted size='small'>
        <Form.Input
          label='Wallet name'
          value={walletName}
          disabled={!!disabled || busy}
          onChange={(_e, d) => setWalletName(String(d.value || ''))}
        />
        <Form.Field>
          <label>Peer</label>
          <Dropdown
            placeholder='Connected peer…'
            fluid
            selection
            search
            options={peerOptions}
            value={peerChoice}
            disabled={!!disabled || busy || !hubBase}
            onChange={(_e, d) => setPeerChoice(String(d.value || ''))}
            onClick={() => void refreshPeers()}
          />
        </Form.Field>
        <Form.Input
          label='Peer pubkey (optional, for 2-of-2 draft)'
          placeholder='02… / 03…'
          value={peerPubkey}
          disabled={!!disabled || busy}
          onChange={(_e, d) => setPeerPubkey(String(d.value || ''))}
        />
        <Form.Group widths='equal'>
          <Form.Input
            label='Threshold'
            type='number'
            min={1}
            value={threshold}
            disabled={!!disabled || busy}
            onChange={(_e, d) => setThreshold(String(d.value || '1'))}
          />
          <Form.Field>
            <label>Spend cap mode</label>
            <Dropdown
              fluid
              selection
              options={[
                { key: 'percent', value: 'percent', text: 'Percent of treasury' },
                { key: 'sats', value: 'sats', text: 'Sats per agreement' }
              ]}
              value={spendMode}
              disabled={!!disabled || busy}
              onChange={(_e, d) => setSpendMode((d.value as 'percent' | 'sats') || 'percent')}
            />
          </Form.Field>
          <Form.Input
            label='Cap value'
            type='number'
            min={0}
            value={spendValue}
            disabled={!!disabled || busy}
            onChange={(_e, d) => setSpendValue(String(d.value || '0'))}
          />
        </Form.Group>
        <Form.TextArea
          label='Short note'
          value={note}
          rows={2}
          disabled={!!disabled || busy}
          onChange={(_e, d) => setNote(String(d.value || ''))}
        />
        <Form.TextArea
          label='Agreement text (optional)'
          value={termsSummary}
          rows={3}
          disabled={!!disabled || busy}
          onChange={(_e, d) => setTermsSummary(String(d.value || ''))}
        />
        <Button
          primary
          size='small'
          loading={busy}
          disabled={!!disabled || busy || !hubBase || !inviterPubkey}
          onClick={() => void sendInvite()}
        >
          <Icon name='paper plane' />
          Send wallet invite
        </Button>
        <Button
          size='small'
          inverted
          color='grey'
          disabled={busy || !hubBase}
          onClick={() => void refreshPeers()}
          style={{ marginLeft: '0.5em' }}
        >
          Refresh peers
        </Button>
      </Form>
      {msg ? <Message positive size='small' style={{ marginTop: '0.75em' }}>{msg}</Message> : null}
      {err ? <Message negative size='small' style={{ marginTop: '0.75em' }}>{err}</Message> : null}
    </Segment>
  );
}
