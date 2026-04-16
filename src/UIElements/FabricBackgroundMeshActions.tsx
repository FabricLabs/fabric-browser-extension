'use strict';

import React, { useCallback, useState } from 'react';
import { Button, Message } from 'semantic-ui-react';

export interface FabricNodeRow {
  id: string;
  hubAddress: string;
  isActive?: boolean;
}

/**
 * Popup actions to persist WebRTC signaling via service worker + offscreen document.
 */
export function FabricBackgroundMeshActions (props: { fabricNodes: FabricNodeRow[] }): React.ReactElement {
  const [msg, setMsg] = useState<string | null>(null);

  const register = useCallback(() => {
    const active = props.fabricNodes.find(n => n.isActive);
    if (!active) {
      setMsg('Set a Fabric node active first (toggle a node row above).');
      return;
    }
    setMsg(null);
    chrome.runtime.sendMessage(
      { type: 'FABRIC_MESH_REGISTER_FROM_POPUP', hubAddress: active.hubAddress },
      (r: { ok?: boolean; error?: string } | undefined) => {
        if (chrome.runtime.lastError) {
          setMsg(chrome.runtime.lastError.message ?? 'Extension messaging error');
          return;
        }
        if (r?.ok) setMsg('Background mesh registered for the active Fabric node (keeps signaling after tabs close).');
        else setMsg(r?.error || 'Registration failed.');
      }
    );
  }, [props.fabricNodes]);

  const unregister = useCallback(() => {
    setMsg(null);
    chrome.runtime.sendMessage({ type: 'FABRIC_MESH_UNREGISTER_FROM_POPUP' }, (r: { ok?: boolean; error?: string } | undefined) => {
      if (chrome.runtime.lastError) {
        setMsg(chrome.runtime.lastError.message ?? 'Extension messaging error');
        return;
      }
      if (r?.ok) setMsg('Registration cleared; mesh follows the active Fabric node only.');
      else setMsg(r?.error || 'Clear failed.');
    });
  }, []);

  return (
    <div style={{ marginBottom: '1em' }}>
      <Button.Group size='small'>
        <Button
          type='button'
          color='teal'
          title='Uses the Fabric node you marked active in the list above.'
          content='Register background mesh'
          onClick={register}
        />
        <Button type='button' basic inverted content='Clear registration' onClick={unregister} />
      </Button.Group>
      {msg != null && msg !== '' && (
        <Message info size='small' style={{ marginTop: '0.75em' }}>
          {msg}
        </Message>
      )}
      <p style={{ marginTop: '0.5em', fontSize: '0.82em', color: 'rgba(255,255,255,0.65)' }}>
        Any Fabric application can also call <code style={{ fontSize: '0.9em' }}>postMessage</code> to register its node for background mesh. See <code style={{ fontSize: '0.9em' }}>hub-mesh-bridge.html</code> in extension assets.
      </p>
    </div>
  );
}
