'use strict';

import React, { useState } from 'react';
import { Button, Form, Input, List, Loader, Message, Modal, Popup } from 'semantic-ui-react';
import { FabricBackgroundMeshActions } from '../FabricBackgroundMeshActions';
import { testFabricSignalingReachable, type FabricSignalingTestOk } from '../../fabric/fabricWebRTCPeering';
import { FABRIC_HUB_PRESETS, type FabricNode } from './nodeCatalog';
import { passportNodeListId } from './nodeListId';
import { truncateMiddle } from './truncateMiddle';

const leadStyle: React.CSSProperties = {
  margin: '0 0 0.75em',
  color: 'rgba(0, 0, 0, 0.72)',
  fontSize: '0.9em'
};

type Props = {
  nodes: FabricNode[];
  onNodes: (nodes: FabricNode[]) => void;
};

export default function FabricNodesSection (props: Props): React.ReactElement {
  const { nodes, onNodes } = props;
  const [draft, setDraft] = useState('');
  const [testing, setTesting] = useState<FabricNode | null>(null);
  const [ok, setOk] = useState<FabricSignalingTestOk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const add = () => {
    const hubAddress = draft.trim();
    if (!hubAddress) return;
    onNodes([...nodes, {
      id: passportNodeListId(`fabric:${hubAddress}`),
      hubAddress,
      isActive: false
    }]);
    setDraft('');
  };

  const toggle = (id: string) => {
    const activating = !nodes.find(node => node.id === id)?.isActive;
    onNodes(nodes.map(node => ({
      ...node,
      isActive: node.id === id ? activating : node.isActive && !activating
    })));
  };

  const test = async (node: FabricNode) => {
    setTesting(node);
    setOk(null);
    setError(null);
    setOpen(true);
    try {
      setOk(await testFabricSignalingReachable(node.hubAddress, '/'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error occurred');
    }
  };

  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Fabric Nodes</h4>
      <p style={leadStyle}>
        WebRTC data channels use the Hub WebSocket for signaling (same as hub.fabric.pub Bridge). Test opens <code style={{ fontSize: '0.85em' }}>wss://…/</code> then closes. Offscreen mesh registers via <code>RegisterWebRTCPeer</code>, discovers peers, completes offer/answer, and relays binary AMP (<code>CONTRACT_MESSAGE</code> / fabric-message) through <code>RelayFromWebRTC</code> — no HTTP for mesh traffic.
      </p>
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
                      content={node.hubAddress}
                      trigger={<span style={{ cursor: 'pointer' }}>{truncateMiddle(node.hubAddress, 22, 10)}</span>}
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
                      title="Test WebSocket signaling"
                    />
                    <Button
                      icon={node.isActive ? 'pause' : 'play'}
                      color={node.isActive ? 'orange' : 'green'}
                      onClick={() => toggle(node.id)}
                      title={node.isActive ? 'Deactivate (background mesh uses the active hub)' : 'Set active for mesh'}
                    />
                    <Button
                      icon="trash"
                      color="red"
                      onClick={() => onNodes(nodes.filter(row => row.id !== node.id))}
                      title="Remove Fabric node"
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
                <label>Fabric Hub (signaling)</label>
                <Input
                  placeholder="https://hub.fabric.pub or http://127.0.0.1:3003"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                />
                <Button.Group size="mini" style={{ marginTop: '0.5em', flexWrap: 'wrap' }}>
                  {FABRIC_HUB_PRESETS.map(p => (
                    <Button
                      key={p.id}
                      type="button"
                      content={p.label}
                      onClick={() => setDraft(p.hubAddress)}
                    />
                  ))}
                </Button.Group>
              </Form.Field>
              <Button
                primary
                content="Add Fabric Node"
                onClick={add}
                disabled={!draft.trim()}
              />
            </Form>
          </List.Content>
        </List.Item>
      </List>
      <div style={{ marginTop: '1em' }}>
        <FabricBackgroundMeshActions fabricNodes={nodes} />
      </div>

      <Modal open={open} onClose={() => setOpen(false)} size="small">
        <Modal.Header>
          Test Fabric signaling (WebSocket)
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
              ) : !ok ? (
                <div style={{ textAlign: 'center', padding: '2em' }}>
                  <Loader active inline="centered" />
                  <p style={{ marginTop: '1em' }}>Opening WebSocket…</p>
                </div>
              ) : (
                <Message positive>
                  <Message.Header>Signaling endpoint reachable</Message.Header>
                  <p style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85em' }}>
                    {ok.url}
                  </p>
                  <p style={{ marginTop: '0.5em' }}>
                    Subprotocol: <code>{ok.subprotocol}</code>
                  </p>
                </Message>
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
