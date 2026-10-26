'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Form, Message, TextArea } from 'semantic-ui-react';
import {
  DEFAULT_FABRIC_HUB_ORIGINS,
  lanHubPermissionPattern,
  loadFabricHubAllowlistExtras,
  saveFabricHubAllowlistExtras
} from '../utils/fabricHubAllowlist';

/**
 * Extra hubs Passport may send login and link data to (`fabric.hub.allowlist`).
 * Websites can still ask Passport to sign in to themselves; this list only limits
 * where Passport posts. A cleartext LAN hub (`http://192.168.x.y:8080`) also needs
 * its host permission, which Chrome asks for when you save.
 */
export default function HubAllowlistPanel (): React.ReactElement {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn'; text: string } | null>(null);

  useEffect(() => {
    void loadFabricHubAllowlistExtras().then((list) => setText(list.join('\n')));
  }, []);

  const save = useCallback(() => {
    const tokens = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const patterns = Array.from(new Set(tokens.map(lanHubPermissionPattern).filter((p): p is string => !!p)));
    const granted: Promise<boolean> = patterns.length && chrome.permissions?.request
      ? chrome.permissions.request({ origins: patterns })
      : Promise.resolve(true);
    void granted.then(async (ok) => {
      const kept = await saveFabricHubAllowlistExtras(tokens);
      setText(kept.join('\n'));
      const dropped = tokens.length - kept.length;
      if (!ok) {
        setStatus({ kind: 'warn', text: 'Saved, but Chrome did not grant access to the LAN hubs — Passport cannot reach them until you allow it.' });
      } else if (dropped > 0) {
        setStatus({ kind: 'warn', text: `Saved. ${dropped} entr${dropped === 1 ? 'y was' : 'ies were'} not a valid origin or *.suffix and were dropped.` });
      } else {
        setStatus({ kind: 'ok', text: 'Saved.' });
      }
    }).catch((e: unknown) => setStatus({ kind: 'warn', text: String(e instanceof Error ? e.message : e) }));
  }, [text]);

  return (
    <div>
      <p>
        Passport sends login and device-link data only to these hubs, this computer
        (<code>localhost</code>, <code>127.0.0.1</code>, <code>[::1]</code>), and the extra
        hubs you add below. Built in: {DEFAULT_FABRIC_HUB_ORIGINS.join(', ')}.
      </p>
      <Form>
        <TextArea
          rows={3}
          placeholder={'https://hub.example.org\n*.example.org\nhttp://192.168.1.20:8080'}
          value={text}
          onChange={(e) => { setText((e.target as HTMLTextAreaElement).value); setStatus(null); }}
        />
      </Form>
      <Button size="mini" style={{ marginTop: '0.5em' }} onClick={save} content="Save hubs" />
      {status ? (
        <Message size="tiny" positive={status.kind === 'ok'} warning={status.kind === 'warn'}>{status.text}</Message>
      ) : null}
    </div>
  );
}
