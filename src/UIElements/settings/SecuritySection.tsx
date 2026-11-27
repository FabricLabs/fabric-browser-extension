'use strict';

import React from 'react';
import { Button, List } from 'semantic-ui-react';
import HubAllowlistPanel from '../HubAllowlistPanel';
import LinkedSignersPanel from '../LinkedSignersPanel';

type Props = {
  pairingHubs: string[];
  signersDisabled: boolean;
  canExport: boolean;
  onExport: () => void;
  onClearData: () => void;
};

export default function SecuritySection (props: Props): React.ReactElement {
  const { pairingHubs, signersDisabled, canExport, onExport, onClearData } = props;

  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Security &amp; privacy</h4>
      <List divided relaxed>
        <List.Item>
          <List.Content>
            <List.Header>Linked signers</List.Header>
            <List.Description>
              <LinkedSignersPanel hubs={pairingHubs} disabled={signersDisabled} />
            </List.Description>
          </List.Content>
        </List.Item>
        <List.Item>
          <List.Content>
            <List.Header>Trusted hubs</List.Header>
            <List.Description>
              <HubAllowlistPanel />
            </List.Description>
          </List.Content>
        </List.Item>
        <List.Item>
          <List.Content>
            <List.Header>Backup & Restore</List.Header>
            <List.Description>
              <p>
                The backup file holds your sealed master key (still locked with your lock password) and
                the accounts you have opened. It has no seed phrase; keep that written down separately.
              </p>
              <Button.Group>
                <Button
                  primary
                  content="Export Backup"
                  disabled={!canExport}
                  onClick={onExport}
                />
              </Button.Group>
            </List.Description>
          </List.Content>
        </List.Item>
        <List.Item>
          <List.Content>
            <List.Header>Clear All Data</List.Header>
            <List.Description>
              <p>Remove your Passport, its accounts, and settings from this device.</p>
              <Button
                negative
                content="Clear Data"
                onClick={onClearData}
              />
            </List.Description>
          </List.Content>
        </List.Item>
      </List>
    </>
  );
}
