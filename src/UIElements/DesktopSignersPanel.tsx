'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Input, Label, List } from 'semantic-ui-react';
import {
  discoverDesktopSigners,
  readDesktopPins,
  readDesktopSignerBases,
  unpinDesktop,
  writeDesktopSignerBases,
  type DesktopPin,
  type DesktopSigner
} from '../utils/fabricDesktopSigner';
import { shortKey } from '../utils/fabricSiteMessage';

type Props = {
  /** Passport pubkey (compressed hex) so each desktop says whether it is linked. */
  pubkey: string | null;
  /** Start a device-link offer with this desktop app. */
  onLink: (signer: DesktopSigner) => void;
  disabled?: boolean;
};

/**
 * Fabric Hub / GoonCitizen running on this computer. Once linked (the user
 * matched the pairing code and Passport pinned the desktop's key), either can
 * sign website logins with its own identity from the Passport sign-in prompt.
 */
export default function DesktopSignersPanel (props: Props): React.ReactElement {
  const { pubkey, onLink, disabled } = props;
  const [signers, setSigners] = useState<DesktopSigner[]>([]);
  const [pins, setPins] = useState<DesktopPin[]>([]);
  const [scanning, setScanning] = useState(false);
  const [bases, setBases] = useState('');
  const [saved, setSaved] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const [found, pinned] = await Promise.all([discoverDesktopSigners({ pubkey }), readDesktopPins()]);
      setSigners(found);
      setPins(pinned);
    } finally {
      setScanning(false);
    }
  }, [pubkey]);

  useEffect(() => {
    void readDesktopSignerBases().then((list) => setBases(list.join(', ')));
    void scan();
  }, [scan]);

  const save = useCallback(async () => {
    const list = await writeDesktopSignerBases(bases);
    setBases(list.join(', '));
    setSaved(true);
    void scan();
  }, [bases, scan]);

  const forget = useCallback(async (base: string) => {
    setPins(await unpinDesktop(base));
  }, []);

  const pinFor = (s: DesktopSigner): DesktopPin | undefined =>
    pins.find((p) => p.base === s.base && p.pubkey === s.pubkey);

  return (
    <div>
      <p>
        Fabric Hub and GoonCitizen on this computer can sign in to websites with their own
        identity. Link one here and approve it in the desktop app when both show the same
        six-digit code; then pick it in the sign-in prompt. Passport only talks to them on loopback.
      </p>
      {signers.length === 0 ? (
        <p style={{ color: 'rgba(255,255,255,0.65)' }}>
          {scanning ? 'Looking for desktop apps…' : 'No unlocked desktop app found on the addresses below.'}
        </p>
      ) : (
        <List divided>
          {signers.map((s) => {
            const pin = pinFor(s);
            const stale = !pin && pins.some((p) => p.base === s.base);
            return (
              <List.Item key={s.base}>
                <List.Content floated="right">
                  {pin ? (
                    <>
                      <Label color="green" size="tiny">Linked</Label>
                      <Button size="mini" basic style={{ marginLeft: '0.35em' }} onClick={() => void forget(s.base)} content="Forget" />
                    </>
                  ) : (
                    <Button size="mini" primary disabled={disabled} onClick={() => onLink(s)} content={stale ? 'Link again' : 'Link'} />
                  )}
                </List.Content>
                <List.Header>{s.name || s.signer}</List.Header>
                <List.Description style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
                  {s.base.replace(/^https?:\/\//, '')} · {shortKey(s.pubkey)}
                  {s.network ? ` · ${s.network}` : ''}
                  {pin ? ` · signs for account #${pin.device.account} on ${pin.device.network}` : ''}
                  {stale ? (
                    <div style={{ color: '#f2c037' }}>This app now answers with another key. Link it again before it can sign.</div>
                  ) : null}
                </List.Description>
              </List.Item>
            );
          })}
        </List>
      )}
      <Input
        size="small"
        fluid
        label="Addresses"
        placeholder="8080, 3041"
        value={bases}
        onChange={(e) => { setBases(e.target.value); setSaved(false); }}
        action={{ content: saved ? 'Saved' : 'Save', onClick: () => void save() }}
      />
      <Button size="mini" style={{ marginTop: '0.5em' }} loading={scanning} onClick={() => void scan()} content="Look again" />
    </div>
  );
}
