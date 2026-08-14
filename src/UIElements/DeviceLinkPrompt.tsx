'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Message, Modal } from 'semantic-ui-react';
import {
  FABRIC_DEVICE_LINK_RESULT,
  FABRIC_PENDING_DEVICE_LINK_KEY,
  FABRIC_RUNTIME_DEVICE_LINK_CLEAR,
  FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
  FABRIC_RUNTIME_DEVICE_LINK_GET
} from '../constants/deviceLink';
import { completeDeviceLinkAsResponder, type DeviceLinkPending } from '../utils/fabricDeviceLinkSign';
import { publishIdentityCrossSign } from '../utils/identityCrossSignPublish';
import { mergeLinkedDevice } from '../utils/linkedDevices';
import { swallowNonFatal } from '../utils/nonFatal';

export type PendingDeviceLink = DeviceLinkPending & {
  pageOrigin: string;
  createdAt: number;
};

type Props = {
  privateKeyHex?: string | null;
  xpub?: string | null;
  needsUnlock?: boolean;
};

function notifyPage (tabId: number | undefined, payload: Record<string, unknown>): void {
  if (tabId == null) return;
  void chrome.tabs.sendMessage(tabId, {
    type: 'FABRIC_DEVICE_LINK_PAGE_RESULT',
    ...payload
  }).catch((err: unknown) => swallowNonFatal('device-link-page-result', err));
}

/**
 * Approves mutual device-link offers queued by the content script (responder role).
 */
export default function DeviceLinkPrompt (props: Props): React.ReactElement | null {
  const { privateKeyHex, xpub, needsUnlock } = props;
  const [pending, setPending] = useState<PendingDeviceLink | null>(null);
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pull = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_DEVICE_LINK_GET }, (res) => {
      if (chrome.runtime.lastError) return;
      const p = res && res.pending ? (res.pending as PendingDeviceLink) : null;
      setPending(p);
      setTabId(res && typeof res.tabId === 'number' ? res.tabId : undefined);
      setError(null);
    });
  }, []);

  useEffect(() => {
    pull();
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return undefined;
    const onChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if (area === 'session' && changes[FABRIC_PENDING_DEVICE_LINK_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [pull]);

  const clearPending = useCallback(() => {
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_DEVICE_LINK_CLEAR }, () => {
      setPending(null);
    });
  }, []);

  const reject = useCallback(() => {
    notifyPage(tabId, {
      source: 'fabric-passport',
      type: FABRIC_DEVICE_LINK_RESULT,
      ok: false,
      error: 'rejected'
    });
    chrome.runtime.sendMessage({
      type: FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
      ok: false,
      error: 'rejected'
    });
    clearPending();
  }, [clearPending, tabId]);

  const approve = useCallback(async () => {
    if (!pending) return;
    if (!privateKeyHex || !xpub) {
      setError(needsUnlock
        ? 'Unlock your Passport identity (enter password), then approve again.'
        : 'No unlocked signing key — open Passport and unlock your identity.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const posted = await completeDeviceLinkAsResponder(pending, privateKeyHex, xpub);
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      const peerPk = pending.initiator && pending.initiator.pubkeyHex;
      if (peerPk && pending.nonce) {
        void publishIdentityCrossSign({
          hubBase: pending.hubBase,
          privateKeyHex,
          xpub,
          peerPubkey: peerPk,
          nonce: pending.nonce
        }).catch((err: unknown) => swallowNonFatal('identity-cross-sign-publish', err));
      }
      void mergeLinkedDevice({
        kind: 'device-link',
        peerFabricId: posted.peerFabricId,
        peerXpub: pending.initiator && pending.initiator.xpub,
        peerPubkey: peerPk,
        nonce: pending.nonce,
        label: pending.label || posted.label || 'Linked device',
        hubOrigin: pending.origin || pending.hubBase,
        linkedAt: new Date().toISOString(),
        role: 'responder'
      }).catch((err: unknown) => swallowNonFatal('linked-devices-merge', err));
      notifyPage(tabId, {
        source: 'fabric-passport',
        type: FABRIC_DEVICE_LINK_RESULT,
        ok: true,
        sessionId: pending.sessionId,
        peerFabricId: posted.peerFabricId
      });
      chrome.runtime.sendMessage({
        type: FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
        ok: true,
        sessionId: pending.sessionId
      });
      clearPending();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pending, privateKeyHex, xpub, needsUnlock, tabId, clearPending]);

  if (!pending) return null;

  const peerId = pending.initiator && pending.initiator.id;

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Link this device</Modal.Header>
      <Modal.Content>
        <p>
          Any Fabric peer (Passport, Android, or desktop) can create or accept this link.
          Separate seeds, dual BIP340 Schnorr. Approve only if you started this on the other device.
        </p>
        {needsUnlock || !privateKeyHex ? (
          <Message warning>
            Unlock your identity in Passport (password), then click Approve again.
          </Message>
        ) : null}
        <p><strong>Hub</strong><br />{pending.origin || pending.hubBase}</p>
        {pending.label ? <p><strong>Offer label</strong><br />{pending.label}</p> : null}
        {peerId ? (
          <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
            <strong>Peer Fabric id</strong><br />{peerId}
          </p>
        ) : null}
        <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
          <strong>Session</strong><br />{pending.sessionId}
        </p>
        {error ? <Message negative>{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={reject} disabled={busy}>Ignore</Button>
        <Button primary onClick={() => void approve()} disabled={busy || !privateKeyHex}>
          {busy ? 'Linking…' : 'Approve & link'}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
