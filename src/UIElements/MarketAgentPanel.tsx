'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Form, Label, List, Message } from 'semantic-ui-react';
import type { MarketAgentStatus } from '../services/market';

function shortHex (v: string): string {
  const s = String(v || '');
  return s.length <= 16 ? s : `${s.slice(0, 8)}…${s.slice(-8)}`;
}

type Reply = { ok?: boolean; status?: MarketAgentStatus; error?: string } | undefined;

function send (msg: object, cb: (r: Reply) => void): void {
  if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) return;
  chrome.runtime.sendMessage(msg, (r: Reply) => {
    if (chrome.runtime.lastError) cb({ ok: false, error: chrome.runtime.lastError.message ?? 'Extension messaging error' });
    else cb(r);
  });
}

/**
 * Consumer budget agent controls (mirror of core `services/market`):
 * sats budget, per-plan cap, proximity preference, wanted Tree roots and
 * the sessions the agent opened. Paid sessions wait for a funder
 * (`awaiting_funding`); Passport never holds an L1 HTLC itself.
 */
export function MarketAgentPanel (props: { wantRoot?: string | null } = {}): React.ReactElement {
  const [status, setStatus] = useState<MarketAgentStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [budget, setBudget] = useState('');
  const [cap, setCap] = useState('');
  const [proximity, setProximity] = useState('');

  const apply = useCallback((r: Reply) => {
    if (r?.ok && r.status) {
      setStatus(r.status);
      setError(null);
      setBudget(String(r.status.budgetSats));
      setCap(String(r.status.perPlanMaxSats));
      setProximity(String(r.status.proximityWeight));
    } else setError(r?.error || 'Market agent unavailable.');
  }, []);

  const refresh = useCallback(() => send({ type: 'FABRIC_MARKET_STATUS' }, apply), [apply]);
  useEffect(() => { refresh(); }, [refresh]);

  const save = () => send({
    type: 'FABRIC_MARKET_CONFIGURE',
    settings: { budgetSats: Number(budget), perPlanMaxSats: Number(cap), proximityWeight: Number(proximity) }
  }, apply);
  const tick = () => send({ type: 'FABRIC_MARKET_TICK' }, apply);
  const want = (root: string) => send({ type: 'FABRIC_MARKET_WANT', merkleRootHex: root }, apply);
  const forget = (root: string) => send({ type: 'FABRIC_MARKET_FORGET', merkleRootHex: root }, apply);

  return (
    <div className="fabric-market-agent">
      {error && <Message negative size="mini">{error}</Message>}
      <Form size="mini" inverted onSubmit={save}>
        <Form.Group widths="equal">
          <Form.Input label="Budget (sats)" value={budget} onChange={(_, d) => setBudget(d.value)} type="number" min="0" />
          <Form.Input label="Per-plan cap" value={cap} onChange={(_, d) => setCap(d.value)} type="number" min="0" />
          <Form.Input label="Proximity 0–1" value={proximity} onChange={(_, d) => setProximity(d.value)} type="number" min="0" max="1" step="0.1" />
        </Form.Group>
        <Button size="mini" basic inverted type="submit">Save</Button>
        <Button size="mini" basic inverted type="button" onClick={tick}>Plan now</Button>
        {props.wantRoot && (
          <Button size="mini" basic inverted type="button" onClick={() => want(props.wantRoot as string)}>
            Want {shortHex(props.wantRoot)}
          </Button>
        )}
      </Form>
      {status && (
        <p style={{ marginTop: '0.5em', fontSize: '0.85em', color: 'rgba(255,255,255,0.65)' }}>
          spent {status.spentSats} · reserved {status.reservedSats} · remaining {status.remainingSats} sats
        </p>
      )}
      {status && status.wants.length > 0 && (
        <List divided relaxed inverted>
          {status.wants.map((w) => {
            const sessions = status.sessions.filter((s) => s.merkleRootHex === w.merkleRootHex);
            const done = sessions.filter((s) => s.status === 'complete').length;
            const funding = sessions.filter((s) => s.status === 'awaiting_funding').length;
            return (
              <List.Item key={w.merkleRootHex}>
                <List.Content>
                  <List.Header>
                    <code title={w.merkleRootHex} style={{ fontSize: '0.8em' }}>{shortHex(w.merkleRootHex)}</code>
                    {' '}
                    <Label size="mini" color={w.status === 'complete' ? 'green' : w.status === 'buying' ? 'blue' : undefined}>{w.status}</Label>
                    {w.blobTotal != null && <Label size="mini">{done}/{w.blobTotal} blobs</Label>}
                    {funding > 0 && <Label size="mini" color="orange">{funding} awaiting funding</Label>}
                    <Button size="mini" basic inverted floated="right" onClick={() => forget(w.merkleRootHex)}>Forget</Button>
                  </List.Header>
                  {w.lastError && <List.Description style={{ fontSize: '0.8em' }}>{w.lastError}</List.Description>}
                </List.Content>
              </List.Item>
            );
          })}
        </List>
      )}
    </div>
  );
}

export default MarketAgentPanel;
