'use strict';

import React from 'react';
import { Button, Form, Input, List } from 'semantic-ui-react';
import { clampAutoLockMinutes, DEFAULT_AUTO_LOCK_MINUTES, MAX_AUTO_LOCK_MINUTES } from './lockTimer';

const helpStyle: React.CSSProperties = {
  marginTop: '0.5em',
  fontSize: '0.85em',
  color: 'rgba(0, 0, 0, 0.62)'
};

type Props = {
  minutes: number;
  unlocked: boolean;
  onMinutes: (minutes: number) => void;
  onLock: () => void;
};

export default function LockSection (props: Props): React.ReactElement {
  const { minutes, unlocked, onMinutes, onLock } = props;

  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Lock</h4>
      <List divided relaxed>
        <List.Item>
          <List.Content>
            <List.Header>Auto-Lock Timer</List.Header>
            <List.Description>
              <Form.Field>
                <label>Lock wallet after inactivity (minutes, 0 = off):</label>
                <Input
                  type="number"
                  min={0}
                  max={MAX_AUTO_LOCK_MINUTES}
                  value={minutes}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    onMinutes(Number.isNaN(v) ? DEFAULT_AUTO_LOCK_MINUTES : clampAutoLockMinutes(v));
                  }}
                  fluid
                />
                <p style={helpStyle}>
                  After this many minutes without keyboard or pointer activity in the popup, Passport locks: the open master key and any seed phrase in memory are cleared. The timer uses the same clock when you close and reopen the popup.
                </p>
              </Form.Field>
            </List.Description>
          </List.Content>
        </List.Item>
        <List.Item>
          <List.Content>
            <List.Header>Lock now</List.Header>
            <List.Description>
              <Button
                size="small"
                disabled={!unlocked}
                onClick={onLock}
                content={unlocked ? 'Lock Passport' : 'Locked'}
              />
            </List.Description>
          </List.Content>
        </List.Item>
      </List>
    </>
  );
}
