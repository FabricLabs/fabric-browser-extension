'use strict';

import React, { useState } from 'react';
import { Button, Message } from 'semantic-ui-react';
import './settings.css';
import { PASSPORT_EXTENSION_VERSION } from '../../constants/extensionVersion';
import { MarketAgentPanel } from '../MarketAgentPanel';
import { PageIndexPanel } from '../PageIndexPanel';
import AboutSection from './AboutSection';
import BitcoinNodesSection from './BitcoinNodesSection';
import FabricNodesSection from './FabricNodesSection';
import LockSection from './LockSection';
import type { BitcoinNode, FabricNode } from './nodeCatalog';
import SecuritySection from './SecuritySection';
import SettingsMenu, { type SettingsMenuItem, type SettingsSectionId } from './SettingsMenu';

const leadStyle: React.CSSProperties = {
  margin: '0 0 0.75em',
  color: 'rgba(0, 0, 0, 0.72)',
  fontSize: '0.9em'
};

type Props = {
  autoLockTimer: number;
  onAutoLockTimer: (minutes: number) => void;
  unlocked: boolean;
  onLock: () => void;
  bitcoinNodes: BitcoinNode[];
  onBitcoinNodes: (nodes: BitcoinNode[]) => void;
  xpubQueryToken: string;
  onXpubQueryToken: (token: string) => void;
  fabricNodes: FabricNode[];
  onFabricNodes: (nodes: FabricNode[]) => void;
  pairingHubs: string[];
  signersDisabled: boolean;
  canExport: boolean;
  onExport: () => void;
  onClearData: () => void;
  onBack: () => void;
};

function fabricHubLabel (nodes: FabricNode[]): string {
  const active = nodes.find((node) => node.isActive);
  if (!active) return 'No active hub';
  try {
    return new URL(active.hubAddress).host;
  } catch {
    return active.hubAddress;
  }
}

function nodeCount (n: number): string {
  if (n === 0) return 'No nodes';
  return `${n} ${n === 1 ? 'node' : 'nodes'}`;
}

function menuItems (props: Props): SettingsMenuItem[] {
  return [
    {
      id: 'lock',
      title: 'Lock',
      blurb: props.autoLockTimer === 0 ? 'Auto-lock off' : `${props.autoLockTimer} min of inactivity`,
      icon: 'lock'
    },
    {
      id: 'security',
      title: 'Security',
      blurb: 'Signers, backup, and erase',
      icon: 'shield alternate'
    },
    {
      id: 'bitcoin',
      title: 'Bitcoin',
      blurb: nodeCount(props.bitcoinNodes.length),
      icon: 'bitcoin'
    },
    {
      id: 'fabric',
      title: 'Fabric',
      blurb: fabricHubLabel(props.fabricNodes),
      icon: 'sitemap'
    },
    {
      id: 'pages',
      title: 'Pages',
      blurb: 'Captured on this device',
      icon: 'file alternate outline'
    },
    {
      id: 'budget',
      title: 'Budget',
      blurb: 'Plans for paid blobs',
      icon: 'bolt'
    },
    {
      id: 'about',
      title: 'About',
      blurb: PASSPORT_EXTENSION_VERSION,
      icon: 'info circle'
    }
  ];
}

function PagesSection (): React.ReactElement {
  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Page index</h4>
      <p style={leadStyle}>
        Pages this Passport has captured as Fabric blob trees. Peers locate chunks by Tree root and blob hash only; titles and URLs never leave this device.
      </p>
      <PageIndexPanel />
    </>
  );
}

function BudgetSection (): React.ReactElement {
  return (
    <>
      <h4 style={{ margin: '0 0 0.75em' }}>Budget agent</h4>
      <p style={leadStyle}>
        Set a sats budget and let Passport plan the cheapest / nearest / most reliable provider per blob. Paid blobs wait for a funder; free blobs are requested at once.
      </p>
      <MarketAgentPanel />
    </>
  );
}

export default function SettingsView (props: Props): React.ReactElement {
  const [section, setSection] = useState<SettingsSectionId | null>(null);

  let body: React.ReactNode;
  if (section === null) {
    body = (
      <>
        <SettingsMenu items={menuItems(props)} onOpen={setSection} />
        <Button.Group vertical fluid style={{ marginTop: '1.25em' }}>
          <Button color="black" content="Back" onClick={props.onBack} />
        </Button.Group>
      </>
    );
  } else {
    body = (
      <>
        <div className="passport-settings-sticky">
          <Button
            type="button"
            basic
            size="small"
            icon="angle left"
            labelPosition="left"
            content="All settings"
            onClick={() => setSection(null)}
          />
        </div>
        {section === 'lock' && (
          <LockSection
            minutes={props.autoLockTimer}
            unlocked={props.unlocked}
            onMinutes={props.onAutoLockTimer}
            onLock={props.onLock}
          />
        )}
        {section === 'security' && (
          <SecuritySection
            pairingHubs={props.pairingHubs}
            signersDisabled={props.signersDisabled}
            canExport={props.canExport}
            onExport={props.onExport}
            onClearData={props.onClearData}
          />
        )}
        {section === 'bitcoin' && (
          <BitcoinNodesSection
            nodes={props.bitcoinNodes}
            onNodes={props.onBitcoinNodes}
            xpubQueryToken={props.xpubQueryToken}
            onXpubQueryToken={props.onXpubQueryToken}
          />
        )}
        {section === 'fabric' && (
          <FabricNodesSection nodes={props.fabricNodes} onNodes={props.onFabricNodes} />
        )}
        {section === 'pages' && <PagesSection />}
        {section === 'budget' && <BudgetSection />}
        {section === 'about' && <AboutSection />}
      </>
    );
  }

  return (
    <Message className="fade-in">
      <Message.Header>Settings</Message.Header>
      <Message.Content>
        {body}
      </Message.Content>
    </Message>
  );
}
