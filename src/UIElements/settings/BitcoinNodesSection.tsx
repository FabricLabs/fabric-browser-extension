'use strict';

import React, { useState } from 'react';
import { Button, Form, Input, List, Loader, Message, Modal, Popup, Table } from 'semantic-ui-react';
import { BITCOIN_HOST_PRESETS, type BitcoinNode } from './nodeCatalog';
import { passportNodeListId } from './nodeListId';
import { truncateMiddle } from './truncateMiddle';

interface BitcoinNodeTestResult {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  chainwork: string;
  mediantime: number;
}

const helpStyle: React.CSSProperties = {
  marginTop: '0.5em',
  fontSize: '0.85em',
  color: 'rgba(0, 0, 0, 0.62)'
};

type Props = {
  nodes: BitcoinNode[];
  onNodes: (nodes: BitcoinNode[]) => void;
  xpubQueryToken: string;
  onXpubQueryToken: (token: string) => void;
};

function bitcoinRpcPostUrl (connectionString: string): string {
  const base = new URL(connectionString);
  const path = (base.pathname || '').replace(/\/+$/, '');
  if (path && path !== '/') {
    return `${base.origin}${path}`;
  }
  return base.origin;
}

function bitcoinRpcHeaders (connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (url.username || url.password) {
    headers.Authorization = `Basic ${btoa(`${url.username}:${url.password}`)}`;
  }
  return headers;
}

export default function BitcoinNodesSection (props: Props): React.ReactElement {
  const { nodes, onNodes, xpubQueryToken, onXpubQueryToken } = props;
  const [draft, setDraft] = useState('');
  const [testing, setTesting] = useState<BitcoinNode | null>(null);
  const [result, setResult] = useState<BitcoinNodeTestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const add = () => {
    if (!draft.trim()) return;
    const connectionString = draft.trim();
    onNodes([...nodes, {
      id: passportNodeListId(connectionString),
      connectionString,
      isActive: false
    }]);
    setDraft('');
  };

  const test = async (node: BitcoinNode) => {
    setTesting(node);
    setResult(null);
    setError(null);
    setOpen(true);
    try {
      const response = await fetch(bitcoinRpcPostUrl(node.connectionString), {
        method: 'POST',
        headers: bitcoinRpcHeaders(node.connectionString),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test',
          method: 'getblockchaininfo',
          params: []
        })
      });
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      if (data.error) throw new Error(data.error.message || 'RPC Error');
      setResult(data.result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    }
  };

  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Bitcoin Nodes</h4>
      <List divided relaxed>
        {nodes.map(node => (
          <List.Item key={node.id}>
            <List.Content>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1em' }}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <List.Header style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>
                    {node.id}
                  </List.Header>
                  <List.Description style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>
                    <Popup
                      content={node.connectionString}
                      trigger={<span style={{ cursor: 'pointer' }}>{truncateMiddle(node.connectionString, 20, 10)}</span>}
                      position="top left"
                      style={{ maxWidth: '500px', wordBreak: 'break-all' }}
                    />
                  </List.Description>
                </div>
                <div style={{ flexShrink: 0 }}>
                  <Button.Group size="mini">
                    <Button
                      icon="plug"
                      color="blue"
                      onClick={() => { void test(node); }}
                      title="Test connection"
                    />
                    <Button
                      icon={node.isActive ? 'pause' : 'play'}
                      color={node.isActive ? 'orange' : 'green'}
                      onClick={() => onNodes(nodes.map(row => ({
                        ...row,
                        isActive: row.id === node.id ? !row.isActive : row.isActive
                      })))}
                      title={node.isActive ? 'Deactivate (RPC signing uses the active node)' : 'Set active for RPC'}
                    />
                    <Button
                      icon="trash"
                      color="red"
                      onClick={() => onNodes(nodes.filter(row => row.id !== node.id))}
                      title="Remove node"
                    />
                  </Button.Group>
                </div>
              </div>
            </List.Content>
          </List.Item>
        ))}
        <List.Item>
          <List.Content>
            <Form>
              <Form.Field>
                <label>Bitcoin Host</label>
                <Input
                  placeholder="https://hub.fabric.pub/services/bitcoin or http://user:pass@host:port"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button.Group size="mini" style={{ marginTop: '0.5em', flexWrap: 'wrap' }}>
                  {BITCOIN_HOST_PRESETS.map(p => (
                    <Button
                      key={p.id}
                      type="button"
                      content={p.label}
                      onClick={() => setDraft(p.connectionString)}
                    />
                  ))}
                </Button.Group>
              </Form.Field>
              <Button
                primary
                content="Add Node"
                onClick={add}
                disabled={!draft.trim()}
              />
            </Form>
          </List.Content>
        </List.Item>
      </List>
      <Form.Field style={{ marginTop: '1em', maxWidth: '32rem' }}>
        <label>Hub xpub query token (optional)</label>
        <Input
          type="password"
          autoComplete="off"
          placeholder="Matches FABRIC_BITCOIN_XPUB_QUERY_TOKEN when the hub requires it"
          value={xpubQueryToken}
          onChange={(e) => onXpubQueryToken(e.target.value)}
          fluid
        />
        <p style={helpStyle}>
          When the Hub gates watch-only <code style={{ fontSize: '0.85em' }}>GET /services/bitcoin/xpub</code> (balance and transaction scans), paste the same shared secret here. Leave empty for hubs that allow anonymous xpub queries.
        </p>
      </Form.Field>

      <Modal open={open} onClose={() => setOpen(false)} size="small">
        <Modal.Header>
          Test Node Connection
          {testing && (
            <div style={{ fontSize: '0.8em', marginTop: '0.5em', fontFamily: 'monospace' }}>
              {testing.id}
            </div>
          )}
        </Modal.Header>
        <Modal.Content>
          {testing && (
            <div>
              {error ? (
                <Message negative>
                  <Message.Header>Connection Failed</Message.Header>
                  <p>{error}</p>
                </Message>
              ) : !result ? (
                <div style={{ textAlign: 'center', padding: '2em' }}>
                  <Loader active inline="centered" />
                  <p style={{ marginTop: '1em' }}>Testing connection...</p>
                </div>
              ) : (
                <div>
                  <Message positive>
                    <Message.Header>Connection Successful</Message.Header>
                    <p>Node is online and responding</p>
                  </Message>
                  <Table definition>
                    <Table.Body>
                      <Table.Row>
                        <Table.Cell>Chain</Table.Cell>
                        <Table.Cell>{result.chain}</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Blocks</Table.Cell>
                        <Table.Cell>{result.blocks}</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Headers</Table.Cell>
                        <Table.Cell>{result.headers}</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Best Block</Table.Cell>
                        <Table.Cell style={{ fontFamily: 'monospace', fontSize: '0.8em', wordBreak: 'break-all' }}>
                          {result.bestblockhash}
                        </Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Difficulty</Table.Cell>
                        <Table.Cell>{result.difficulty}</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Chain Work</Table.Cell>
                        <Table.Cell style={{ fontFamily: 'monospace' }}>{result.chainwork}</Table.Cell>
                      </Table.Row>
                      <Table.Row>
                        <Table.Cell>Median Time</Table.Cell>
                        <Table.Cell>{new Date(result.mediantime * 1000).toLocaleString()}</Table.Cell>
                      </Table.Row>
                    </Table.Body>
                  </Table>
                </div>
              )}
            </div>
          )}
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={() => setOpen(false)}>Close</Button>
        </Modal.Actions>
      </Modal>
    </>
  );
}
