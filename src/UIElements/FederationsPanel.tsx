'use strict';

/**
 * Federations: k-of-n multisig vaults shared with other Passports and Hubs.
 * Passport is a member like any Hub (`@fabric/core` `types/federation`); the
 * active Hub carries its signed messages (see `services/federations.ts`).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Button, Checkbox, Form, Icon, Label, List, Message, Segment
} from 'semantic-ui-react';
import {
  FederationMember,
  federationsAvailable,
  loadFederationMember,
  saveFederationMember as saveState,
  type FederationRecord,
  type FederationVault,
  type FederationWithdrawal,
  type HubFederationsStatus
} from '../services/federations';
import { DELEGATION_ASK } from '../constants/delegation';
import { delegationCall, useDelegationState, walletSigners } from './delegationApi';

const SYNC_EVERY_MS = 30000;
const PUBKEY_RE = /^0[23][0-9a-f]{64}$/i;

export type FederationsPanelProps = {
  hubBase: string | null;
  /** Session private key of the current identity (null while locked). */
  privateKeyHex: string | null;
  /** Invites and withdrawals waiting for this identity. */
  onPendingChange?: (count: number) => void;
};

function short (hex: string): string {
  const s = String(hex || '');
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-6)}` : s;
}

function sats (n: number): string {
  return `${Number(n || 0).toLocaleString()} sats`;
}

export default function FederationsPanel (props: FederationsPanelProps) {
  const { hubBase, privateKeyHex, onPendingChange } = props;
  const [member, setMember] = useState<FederationMember | null>(null);
  const [hub, setHub] = useState<HubFederationsStatus | null>(null);
  const [version, setVersion] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [vaults, setVaults] = useState<Record<string, FederationVault>>({});
  const [creating, setCreating] = useState(false);
  const memberRef = useRef<FederationMember | null>(null);
  const inFlight = useRef(false);

  // Rebuild the member when the identity or Hub changes.
  useEffect(() => {
    let cancelled = false;
    setMember(null);
    setHub(null);
    setErr(null);
    memberRef.current = null;
    if (!hubBase || !privateKeyHex || !federationsAvailable()) return undefined;
    (async () => {
      try {
        const m = await loadFederationMember(hubBase, privateKeyHex);
        if (cancelled) return;
        memberRef.current = m;
        setMember(m);
        setHub(await m.hub());
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [hubBase, privateKeyHex]);

  const run = useCallback(async (label: string, fn: (m: FederationMember) => Promise<unknown>, done?: string) => {
    const m = memberRef.current;
    if (!m || inFlight.current) return;
    inFlight.current = true;
    setBusy(label);
    setErr(null);
    setNotice(null);
    try {
      await fn(m);
      if (done) setNotice(done);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      await saveState(m);
      setVersion((v) => v + 1);
      setBusy(null);
      inFlight.current = false;
    }
  }, []);

  const sync = useCallback(() => run('sync', async (m) => { await m.sync(); }), [run]);

  useEffect(() => {
    if (!member) return undefined;
    void sync();
    const t = setInterval(() => { void sync(); }, SYNC_EVERY_MS);
    return () => clearInterval(t);
  }, [member, sync]);

  const records = useMemo(() => (member ? member.list() : []), [member, version]);
  const invites = useMemo(() => (member ? member.pendingInvites() : []), [member, version]);
  const approvals = useMemo(() => (member ? member.pendingApprovals() : []), [member, version]);

  useEffect(() => {
    if (onPendingChange) onPendingChange(invites.length + approvals.length);
  }, [invites.length, approvals.length, onPendingChange]);

  const loadVault = useCallback(async (id: string) => {
    const m = memberRef.current;
    if (!m) return;
    try {
      const v = await m.vault(id);
      setVaults((prev) => ({ ...prev, [id]: v }));
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  if (!federationsAvailable()) {
    return <Message warning size='small' content='This Passport build has no Federation support (it needs a newer @fabric/core).' />;
  }
  if (!hubBase) {
    return <Message info size='small' content='Choose an active Fabric Hub (Settings → Fabric Nodes): it carries federation messages for Passport.' />;
  }
  if (!privateKeyHex) {
    return <Message info size='small' content='Unlock this identity to use federations; its key signs as a member.' />;
  }

  const label = (record: FederationRecord, pubkey: string) => {
    const x = pubkey.slice(2);
    if (member && x === member.xonly) return 'you';
    if (hub && hub.pubkey && x === hub.pubkey.slice(2)) return 'this Hub';
    const hint = record.members.find((m) => m.pubkey.slice(2) === x);
    return (hint && hint.alias) || short(x);
  };

  return (
    <Segment inverted style={{ marginTop: '1em', background: 'rgba(30,40,60,0.45)', border: '1px solid rgba(120,150,220,0.35)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.5em' }}>
        <h4 style={{ margin: 0, color: 'white', fontSize: '0.95em' }}>
          <Icon name='users' style={{ marginRight: '0.35em' }} />
          Federations
          {hub ? <Label size='mini' style={{ marginLeft: '0.5em' }}>{hub.network}</Label> : null}
        </h4>
        <div>
          <Button size='mini' inverted color='grey' icon='refresh' loading={busy === 'sync'} disabled={!member || !!busy} onClick={() => void sync()} title='Check the Hub for new messages' />
          <Button size='mini' primary disabled={!member} onClick={() => setCreating((c) => !c)} content={creating ? 'Close' : 'New'} />
          <SharedWalletButton member={member} busy={busy} run={run} setOpen={setOpen} />
        </div>
      </div>
      <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.78em', margin: '0 0 0.6em' }}>
        Shared Bitcoin vaults: spending needs signatures from enough members. Passport signs with this
        identity&apos;s co-signing key, never its identity key; Hubs and other Passports can be members too.
      </p>

      {err ? <Message negative size='mini' content={err} onDismiss={() => setErr(null)} /> : null}
      {notice ? <Message positive size='mini' content={notice} onDismiss={() => setNotice(null)} /> : null}

      {creating && member ? (
        <CreateFederationForm
          hub={hub}
          busy={busy === 'create'}
          onCreate={(opts) => run('create', async (m) => {
            const r = await m.create(opts);
            setOpen(r.id);
            setCreating(false);
          }, 'Federation created; members were invited.')}
        />
      ) : null}

      {invites.length ? (
        <List divided inverted relaxed size='small'>
          {invites.map((r) => (
            <List.Item key={r.id}>
              <List.Content floated='right'>
                <Button size='mini' primary loading={busy === `accept:${r.id}`} disabled={!!busy} onClick={() => void run(`accept:${r.id}`, (m) => m.respond(r.id, true), 'Joined.')} content='Join' />
                <Button size='mini' inverted color='grey' disabled={!!busy} onClick={() => void run(`decline:${r.id}`, (m) => m.respond(r.id, false))} content='Decline' />
              </List.Content>
              <List.Content>
                <List.Header style={{ color: 'white', fontSize: '0.85em' }}>
                  Invitation: {r.name || 'Federation'} ({r.descriptor.threshold} of {r.descriptor.validators.length})
                </List.Header>
                <List.Description style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.75em' }}>
                  From {label(r, r.publisher)} · members: {r.descriptor.validators.map((v: string) => label(r, v)).join(', ')}
                </List.Description>
              </List.Content>
            </List.Item>
          ))}
        </List>
      ) : null}

      {approvals.map(({ record, withdrawal }) => (
        <Message key={withdrawal.requestId} warning size='mini'>
          <Message.Header>Approve a payment from {record.name || short(record.id)}?</Message.Header>
          <WithdrawalSummary withdrawal={withdrawal} requestedBy={label(record, `02${withdrawal.requestedBy}`)} />
          <p style={{ margin: '0.4em 0 0', fontSize: '0.9em' }}>
            Passport rebuilt this transaction from the vault and checked it matches the request.
          </p>
          <Button size='mini' primary style={{ marginTop: '0.5em' }} loading={busy === `approve:${withdrawal.requestId}`} disabled={!!busy}
            onClick={() => void run(`approve:${withdrawal.requestId}`, (m) => m.approve(record.id, withdrawal.requestId), 'Signed.')}
            content='Sign'
          />
        </Message>
      ))}

      {records.filter((r) => r.status === 'accepted').length === 0 && !invites.length ? (
        <p style={{ color: 'rgba(255,255,255,0.5)', fontSize: '0.8em', margin: 0 }}>No federations yet.</p>
      ) : null}

      <List divided inverted relaxed size='small'>
        {records.filter((r) => r.status === 'accepted').map((r) => {
          const acceptedBy = member ? member.accepted(r) : [];
          const ready = acceptedBy.length >= r.descriptor.validators.length;
          const isOpen = open === r.id;
          const vault = vaults[r.id];
          return (
            <List.Item key={r.id}>
              <List.Content>
                <List.Header
                  as='a'
                  style={{ color: 'white', fontSize: '0.85em', cursor: 'pointer' }}
                  onClick={() => {
                    const next = isOpen ? null : r.id;
                    setOpen(next);
                    if (next && ready) void loadVault(r.id);
                  }}
                >
                  <Icon name={isOpen ? 'caret down' : 'caret right'} />
                  {r.name || 'Federation'} · {r.descriptor.threshold} of {r.descriptor.validators.length}
                  {!ready ? <Label size='mini' color='yellow' style={{ marginLeft: '0.5em' }}>waiting for {r.descriptor.validators.length - acceptedBy.length}</Label> : null}
                </List.Header>
                {isOpen ? (
                  <div style={{ marginTop: '0.5em', fontSize: '0.78em', color: 'rgba(255,255,255,0.8)' }}>
                    <div>Vault: <code style={{ wordBreak: 'break-all' }}>{r.vaultAddress}</code></div>
                    {vault ? <div>Balance: {sats(vault.balanceSats)} in {vault.utxos.length} coin(s)</div> : null}
                    <div style={{ marginTop: '0.35em' }}>
                      {r.descriptor.validators.map((v: string) => (
                        <Label key={v} size='mini' color={r.responses[v.slice(2)] ? 'green' : (r.responses[v.slice(2)] === false ? 'red' : undefined)} style={{ marginBottom: '0.25em' }}>
                          {label(r, v)}
                        </Label>
                      ))}
                    </div>
                    {!ready ? <p style={{ margin: '0.4em 0' }}>Fund the vault once every member has joined.</p> : null}
                    <WithdrawalList record={r} member={member} />
                    {ready ? (
                      <WithdrawForm
                        maxSats={vault ? Math.max(0, ...vault.utxos.map((u) => u.amountSats)) : 0}
                        busy={busy === `withdraw:${r.id}`}
                        onSubmit={(o) => run(`withdraw:${r.id}`, async (m) => {
                          await m.requestWithdrawal(r.id, o);
                          await loadVault(r.id);
                        }, 'Payment requested and signed; waiting for the other members.')}
                      />
                    ) : null}
                  </div>
                ) : null}
              </List.Content>
            </List.Item>
          );
        })}
      </List>
    </Segment>
  );
}

function WithdrawalSummary (props: { withdrawal: FederationWithdrawal; requestedBy: string }) {
  const w = props.withdrawal;
  return (
    <div style={{ fontSize: '0.9em' }}>
      <div>Pay {sats(w.amountSats)} to <code style={{ wordBreak: 'break-all' }}>{w.destinationAddress}</code></div>
      <div>Fee {sats(w.feeSats)}{w.changeSats ? ` · ${sats(w.changeSats)} back to the vault` : ''} · asked by {props.requestedBy}</div>
    </div>
  );
}

function WithdrawalList (props: { record: FederationRecord; member: FederationMember | null }) {
  const rows = Object.values(props.record.withdrawals).sort((a, b) => b.at - a.at).slice(0, 10);
  if (!rows.length) return null;
  return (
    <List size='mini' inverted style={{ marginTop: '0.5em' }}>
      {rows.map((w) => (
        <List.Item key={w.requestId}>
          <Icon name={w.status === 'broadcast' ? 'check circle' : 'hourglass half'} />
          {sats(w.amountSats)} → {short(w.destinationAddress)} ·{' '}
          {w.status === 'broadcast'
            ? <span>sent <code>{short(w.txid || '')}</code></span>
            : <span>{Object.keys(w.signatures).length} of {props.record.descriptor.threshold} signatures</span>}
          {w.error ? <div style={{ color: '#f99' }}>{w.error}</div> : null}
        </List.Item>
      ))}
    </List>
  );
}

function WithdrawForm (props: { maxSats: number; busy: boolean; onSubmit: (o: { destinationAddress: string; amountSats: number; feeSats: number }) => void }) {
  const [destinationAddress, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('500');
  const amountSats = Math.floor(Number(amount));
  const feeSats = Math.floor(Number(fee));
  const valid = destinationAddress.trim().length > 10 && amountSats > 0 && feeSats > 0;
  return (
    <Form inverted size='mini' style={{ marginTop: '0.6em' }} onSubmit={() => valid && props.onSubmit({ destinationAddress: destinationAddress.trim(), amountSats, feeSats })}>
      <Form.Input label='Pay to' placeholder='bc1… / tb1… / bcrt1…' value={destinationAddress} onChange={(_, d) => setDestination(String(d.value))} />
      <Form.Group widths='equal'>
        <Form.Input label={props.maxSats ? `Amount (sats, up to ${props.maxSats.toLocaleString()} minus fee)` : 'Amount (sats)'} type='number' min={546} value={amount} onChange={(_, d) => setAmount(String(d.value))} />
        <Form.Input label='Fee (sats)' type='number' min={1} value={fee} onChange={(_, d) => setFee(String(d.value))} />
      </Form.Group>
      <Button size='mini' primary type='submit' loading={props.busy} disabled={!valid || props.busy} content='Request and sign' />
    </Form>
  );
}

function CreateFederationForm (props: {
  hub: HubFederationsStatus | null;
  busy: boolean;
  onCreate: (o: { name: string; threshold: number; members: string[]; includeHub: boolean }) => void;
}) {
  const [name, setName] = useState('Shared vault');
  const [membersText, setMembersText] = useState('');
  const [includeHub, setIncludeHub] = useState(false);
  const [threshold, setThreshold] = useState('2');
  const members = membersText.split(/[\s,]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  const bad = members.filter((m) => !PUBKEY_RE.test(m));
  const total = 1 + members.length + (includeHub && props.hub && props.hub.pubkey ? 1 : 0);
  const k = Math.floor(Number(threshold));
  const valid = !bad.length && total >= 2 && k >= 2 && k <= total;
  return (
    <Form inverted size='mini' style={{ marginBottom: '0.8em' }} onSubmit={() => valid && props.onCreate({ name: name.trim(), threshold: k, members, includeHub })}>
      <Form.Input label='Name' value={name} onChange={(_, d) => setName(String(d.value))} />
      <Form.TextArea
        label='Other members (their co-signing keys, 02/03…, one per line)'
        rows={3}
        value={membersText}
        onChange={(_, d) => setMembersText(String(d.value))}
        error={bad.length ? `Not a pubkey: ${short(bad[0])}` : undefined}
      />
      {props.hub && props.hub.pubkey ? (
        <Form.Field>
          <Checkbox toggle checked={includeHub} onChange={(_, d) => setIncludeHub(!!d.checked)} label={`Include this Hub as a member (${short(props.hub.pubkey)})`} />
        </Form.Field>
      ) : null}
      <Form.Input label={`Signatures needed (2 to ${Math.max(2, total)})`} type='number' min={2} max={Math.max(2, total)} value={threshold} onChange={(_, d) => setThreshold(String(d.value))} />
      <p style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.9em' }}>
        {total} member(s) on {props.hub ? props.hub.network : '…'}. Members get the invitation through their Hub; the vault is ready once all have joined.
      </p>
      <Button size='mini' primary type='submit' loading={props.busy} disabled={!valid || props.busy} content='Create and invite' />
    </Form>
  );
}

function SharedWalletButton (props: {
  member: FederationMember | null;
  busy: string | null;
  run: (label: string, fn: (m: FederationMember) => Promise<unknown>, done?: string) => void;
  setOpen: (id: string) => void;
}): React.ReactElement | null {
  const { state } = useDelegationState();
  const signers = walletSigners(state);
  if (!props.member || !signers.length) return null;
  const n = 1 + signers.length;
  const threshold = Math.floor(n / 2) + 1;
  return (
    <Button
      size='mini'
      disabled={!!props.busy}
      loading={props.busy === 'shared'}
      title={`A ${threshold}-of-${n} wallet with your linked signers that allow shared wallets`}
      onClick={() => void props.run('shared', async (m) => {
        const r = await m.create({
          name: 'Linked signers',
          threshold,
          members: signers.map((s) => s.cosigner)
        });
        props.setOpen(r.id);
        const missed: string[] = [];
        for (const s of signers) {
          const asked = await delegationCall(DELEGATION_ASK, {
            target: s.pubkey,
            request: r.invite,
            purpose: `Join the shared wallet "Linked signers" (${threshold} of ${n})`
          });
          if (!asked.ok) missed.push(`${s.name}: ${asked.error || 'not reachable'}`);
        }
        if (missed.length) {
          throw new Error(`Shared wallet created, but not every linked signer was asked; they can still join from their Hub. ${missed.join('; ')}`);
        }
      }, 'Shared wallet created; each linked signer was asked to join.')}
      content='Shared wallet with linked signers'
    />
  );
}
