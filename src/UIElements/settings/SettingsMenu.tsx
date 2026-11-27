'use strict';

import React from 'react';
import { Icon } from 'semantic-ui-react';

export type SettingsSectionId =
  | 'lock'
  | 'security'
  | 'bitcoin'
  | 'fabric'
  | 'pages'
  | 'budget'
  | 'about';

export type SettingsMenuItem = {
  id: SettingsSectionId;
  title: string;
  blurb: string;
  icon: 'lock' | 'shield alternate' | 'bitcoin' | 'sitemap' | 'file alternate outline' | 'bolt' | 'info circle';
};

type Props = {
  items: SettingsMenuItem[];
  onOpen: (id: SettingsSectionId) => void;
};

export default function SettingsMenu (props: Props): React.ReactElement {
  const { items, onOpen } = props;

  return (
    <nav className="passport-settings-menu" aria-label="Settings sections">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          aria-label={item.title}
          onClick={() => onOpen(item.id)}
        >
          <Icon
            name={item.icon}
            style={{
              margin: 0,
              width: '1.25em',
              flexShrink: 0,
              color: item.id === 'bitcoin' ? '#f7931a' : 'rgba(0, 0, 0, 0.72)'
            }}
          />
          <span className="passport-settings-copy">
            <span className="passport-settings-title">{item.title}</span>
            <span className="passport-settings-blurb">{item.blurb}</span>
          </span>
          <Icon name="angle right" className="passport-settings-chevron" style={{ margin: 0 }} />
        </button>
      ))}
    </nav>
  );
}
