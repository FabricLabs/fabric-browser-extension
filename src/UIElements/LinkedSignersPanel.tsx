'use strict';

import React, { useEffect, useState } from 'react';
import { Button, Dropdown, Input, Label, List, Message } from 'semantic-ui-react';
import {
  DELEGATION_DISCOVER,
  DELEGATION_FORGET,
  DELEGATION_PAIR_HUB,
  DELEGATION_PAIR_INVITATION,
  DELEGATION_PAIR_LOCAL,
  DELEGATION_REVOKE,
  DELEGATION_SCOPE_LABELS
} from '../constants/delegation';
import type { GrantView } from '../background/delegation';
import { readDelegateBases, writeDelegateBases } from '../utils/delegationClient';
import { shortKey } from '../utils/fabricSiteMessage';
import { delegationCall, useDelegationState } from './delegationApi';
import PairingPrompt from './PairingPrompt';

type Delegate = { base: string; name: string | null; signer: string; pubkey: string; locked: boolean; granted: boolean };

type Props = {
  hubs: string[];
  disabled?: boolean;
};

function scopeLabels (grant: GrantView): string {
  return grant.scopes.map((s) => DELEGATION_SCOPE_LABELS[s] || s).join('; ');
}

function hostOf (base: string): string {
  return base.replace(/^https?:\/\//, '');
}

/**
 * Linked signers: other apps (Fabric Hub, GoonCitizen, another Passport) that
 * keep their own keys and may ask this Passport to sign, or be asked by it.
 * Linking shows a code on both sides; nothing is granted until they match.
 */
export default function LinkedSignersPanel (props: Props): React.ReactElement {
  const { hubs, disabled } = props;
  const { state, refresh } = useDelegationState();
  const [delegates, setDelegates] = useState<Delegate[]>([]);
  const [looked, setLooked] = useState(false);
  const [bases, setBases] = useState('');
  const [hub, setHub] = useState<string>(hubs[0] || '');
  const [invitation, setInvitation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signers = (state && state.signers) || [];
  const locked = !!(state && state.locked) || !!disabled;

  useEffect(() => {
    void readDelegateBases().then((list) => setBases(list.join(', ')));
  }, []);

  useEffect(() => {
    if (!hubs.includes(hub)) setHub(hubs[0] || '');
  }, [hubs.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (type: string, payload: Record<string, unknown> = {}): Promise<boolean> => {
    setBusy(true);
    setError(null);
    const res = await delegationCall(type, payload);
    setBusy(false);
    if (!res.ok) setError(res.error || 'Could not do that');
    refresh();
    return !!res.ok;
  };

  const look = async () => {
    setBusy(true);
    setError(null);
    const saved = await writeDelegateBases(bases);
    setBases(saved.join(', '));
    const res = await delegationCall<{ delegates?: Delegate[] }>(DELEGATION_DISCOVER);
    setBusy(false);
    setLooked(true);
    setDelegates(res.delegates || []);
    if (!res.ok && res.error) setError(res.error);
    refresh();
  };

  return (
    <div>
      <p>
        Linked signers are apps that keep their own keys, such as Fabric Hub or GoonCitizen. They can
        ask you to sign (you get a notification), and you can ask them. Both sides show a code;
        nothing is shared until you confirm the codes match.
      </p>
      {locked ? <p style={{ color: 'rgba(255,200,120,0.95)' }}>Unlock Passport to link, change, or unlink a signer.</p> : null}
      {error ? <Message negative size="small" onDismiss={() => setError(null)}>{error}</Message> : null}

      {signers.length === 0 ? (
        <p style={{ color: 'rgba(255,255,255,0.65)' }}>No linked signers yet.</p>
      ) : (
        <List divided>
          {signers.map((s) => {
            const given = s.given.filter((g) => !g.revoked);
            const received = s.received.filter((g) => !g.revoked);
            return (
              <List.Item key={s.pubkey}>
                <List.Content floated="right">
                  <Button size="mini" basic disabled={locked || busy}
                    onClick={() => void run(DELEGATION_FORGET, { pubkey: s.pubkey })} content="Unlink" />
                </List.Content>
                <List.Header>{s.name || s.signer || 'Linked signer'}</List.Header>
                <List.Description style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
                  {shortKey(s.pubkey)}
                  {s.base ? ` · ${hostOf(s.base)}` : s.hub ? ` · via ${hostOf(s.hub)}` : ''}
                  {given.length ? (
                    <div style={{ marginTop: '0.35em' }}>
                      It may ask me for:
                      {given.map((g) => (
                        <div key={g.hash}>
                          {scopeLabels(g)}{' '}
                          <Button size="mini" compact basic disabled={locked || busy}
                            onClick={() => void run(DELEGATION_REVOKE, { hash: g.hash })} content="Withdraw" />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {received.length ? (
                    <div style={{ marginTop: '0.35em' }}>
                      I may ask it for: {received.map(scopeLabels).join('; ')}
                    </div>
                  ) : null}
                </List.Description>
              </List.Item>
            );
          })}
        </List>
      )}

      <h5 style={{ marginTop: '0.75em' }}>On this computer</h5>
      {delegates.length === 0 ? (
        <p style={{ color: 'rgba(255,255,255,0.65)' }}>
          {looked ? 'No signer answered at these addresses.' : 'Look for Fabric Hub or GoonCitizen running on this computer.'}
        </p>
      ) : (
        <List divided>
          {delegates.map((d) => (
            <List.Item key={d.base}>
              <List.Content floated="right">
                {d.granted ? <Label color="green" size="tiny">Linked</Label> : (
                  <Button size="mini" primary disabled={locked || busy || d.locked}
                    onClick={() => void run(DELEGATION_PAIR_LOCAL, { base: d.base })} content="Link" />
                )}
              </List.Content>
              <List.Header>{d.name || d.signer}</List.Header>
              <List.Description style={{ fontSize: '0.85em' }}>
                {hostOf(d.base)} · {shortKey(d.pubkey)}{d.locked ? ' · locked: unlock it to link' : ''}
              </List.Description>
            </List.Item>
          ))}
        </List>
      )}
      <Input
        size="small"
        fluid
        label="Addresses"
        placeholder="8080, http://127.0.0.1:3041"
        value={bases}
        onChange={(e) => setBases(e.target.value)}
        action={{ content: 'Look again', disabled: busy, onClick: () => void look() }}
      />

      <h5 style={{ marginTop: '0.75em' }}>Somewhere else</h5>
      {hubs.length ? (
        <div style={{ display: 'flex', gap: '0.35em', alignItems: 'center' }}>
          <Dropdown
            selection
            compact
            value={hub}
            options={hubs.map((h) => ({ key: h, value: h, text: hostOf(h) }))}
            onChange={(_e, d) => setHub(String(d.value || ''))}
          />
          <Button size="small" disabled={locked || busy || !hub}
            onClick={() => void run(DELEGATION_PAIR_HUB, { hub })} content="Show an invitation" />
        </div>
      ) : (
        <p style={{ color: 'rgba(255,255,255,0.65)' }}>Add a trusted Hub to link signers on other computers.</p>
      )}
      <Input
        size="small"
        fluid
        style={{ marginTop: '0.6em' }}
        label="Invitation"
        placeholder="fabric:…"
        value={invitation}
        onChange={(e) => setInvitation(e.target.value)}
        action={{
          content: 'Link',
          disabled: locked || busy || !invitation.trim(),
          onClick: () => void run(DELEGATION_PAIR_INVITATION, { invitation }).then((ok) => { if (ok) setInvitation(''); })
        }}
      />
      <PairingPrompt />
    </div>
  );
}
