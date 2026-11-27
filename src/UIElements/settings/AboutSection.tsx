'use strict';

import React from 'react';
import { List } from 'semantic-ui-react';
import { PASSPORT_EXTENSION_VERSION } from '../../constants/extensionVersion';

export default function AboutSection (): React.ReactElement {
  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>About</h4>
      <List divided relaxed>
        <List.Item>
          <List.Content>
            <List.Header>Version</List.Header>
            <List.Description>{PASSPORT_EXTENSION_VERSION}</List.Description>
          </List.Content>
        </List.Item>
      </List>
    </>
  );
}
