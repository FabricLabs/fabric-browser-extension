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
import {
  completeDeviceLinkAsResponder,
  verifyPendingDeviceLink,
  type DeviceLinkPending,
  type VerifiedDeviceLinkOffer
} from '../utils/fabricDeviceLinkSign';
import { publishIdentityCrossSign } from '../utils/identityCrossSignPublish';
import { mergeLinkedDevice } from '../utils/linkedDevices';
import { swallowNonFatal } from '../utils/nonFatal';
import { useArmDelay } from './useArmDelay';

export type PendingDeviceLink = DeviceLinkPending & {
  pageOrigin: string;
  createdAt: number;
};

type Props = {
  privateKeyHex?: string | null;
  xpub?: string | null;
  needsUnlock?: boolean;
};

/** The content script posts it only in frames of `origin` (the page that asked). */
function notifyPage (tabId: number | undefined, origin: string | undefined, payload: Record<string, unknown>): void {
  if (tabId == null || !origin) return;
  void chrome.tabs.sendMessage(tabId, {
    ...payload,
    type: 'FABRIC_DEVICE_LINK_PAGE_RESULT',
    origin
  }).catch((err: unknown) => swallowNonFatal('device-link-page-result', err));
}

/**
 * Approves mutual device-link offers queued by the content script (responder role).
 * Shows only what the Hub session's signed offer proves: the initiator key's
 * fingerprint and the Hub it was offered on.
 */
export default function DeviceLinkPrompt (props: Props): React.ReactElement | null {
  const { privateKeyHex, xpub, needsUnlock } = props;
  const [pending, setPending] = useState<PendingDeviceLink | null>(null);
  const [offer, setOffer] = useState<VerifiedDeviceLinkOffer | null>(null);
  const [checking, setChecking] = useState(false);
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const armed = useArmDelay(offer ? `${offer.sessionId}:${offer.initiator.pubkeyHex}` : '');

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

  useEffect(() => {
    setOffer(null);
    if (!pending) return undefined;
    let live = true;
    setChecking(true);
    void verifyPendingDeviceLink(pending).then((checked) => {
      if (!live) return;
      setChecking(false);
      if (checked.ok) setOffer(checked.offer);
      else setError(`This link can't be verified: ${checked.error}`);
    });
    return () => { live = false; };
  }, [pending]);

  const clearPending = useCallback(() => {
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_DEVICE_LINK_CLEAR }, () => {
      setPending(null);
    });
  }, []);

  const reject = useCallback(() => {
    notifyPage(tabId, pending?.pageOrigin, {
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
  }, [clearPending, tabId, pending]);

  const approve = useCallback(async () => {
    if (!pending || !offer || !armed) return;
    if (!privateKeyHex || !xpub) {
      setError(needsUnlock
        ? 'Unlock your Passport identity (enter password), then approve again.'
        : 'No unlocked signing key — open Passport and unlock your identity.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const posted = await completeDeviceLinkAsResponder(offer, privateKeyHex, xpub);
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      const binding = { sessionId: posted.sessionId, nonce: posted.nonce, origin: posted.origin };
      void publishIdentityCrossSign({
        hubBase: offer.hubBase,
        privateKeyHex,
        xpub,
        peerPubkey: posted.peerPubkey,
        binding
      }).catch((err: unknown) => swallowNonFatal('identity-cross-sign-publish', err));
      void mergeLinkedDevice({
        kind: 'device-link',
        peerFabricId: posted.peerFabricId,
        peerXpub: posted.peerXpub,
        peerPubkey: posted.peerPubkey,
        sessionId: posted.sessionId,
        nonce: posted.nonce,
        label: posted.label,
        hubOrigin: posted.origin,
        linkedAt: new Date().toISOString(),
        role: 'responder'
      }).catch((err: unknown) => swallowNonFatal('linked-devices-merge', err));
      notifyPage(tabId, pending.pageOrigin, {
        source: 'fabric-passport',
        type: FABRIC_DEVICE_LINK_RESULT,
        ok: true,
        sessionId: posted.sessionId,
        peerFabricId: posted.peerFabricId
      });
      chrome.runtime.sendMessage({
        type: FABRIC_RUNTIME_DEVICE_LINK_COMPLETE,
        ok: true,
        sessionId: posted.sessionId
      });
      clearPending();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pending, offer, armed, privateKeyHex, xpub, needsUnlock, tabId, clearPending]);

  if (!pending) return null;

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Link this device</Modal.Header>
      <Modal.Content>
        <p>
          Link this Passport identity to another device of yours (separate seeds).
          After both approve, the two keys act as one identity. This is not website
          login. Approve only if you started this on the other device and its key
          fingerprint below matches the one it shows.
        </p>
        {needsUnlock || !privateKeyHex ? (
          <Message warning>
            Unlock your identity in Passport (password), then click Approve again.
          </Message>
        ) : null}
        {checking ? <Message info>Checking the link…</Message> : null}
        {offer ? (
          <>
            <p><strong>Key fingerprint</strong><br /><code>{offer.fingerprint}</code></p>
            <p><strong>Hub</strong><br />{offer.origin}</p>
            {offer.label ? <p><strong>Offer label</strong><br />{offer.label}</p> : null}
            <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
              <strong>Fabric id</strong><br />{offer.initiator.id}
            </p>
            <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
              <strong>Session</strong><br />{offer.sessionId}
            </p>
          </>
        ) : null}
        {error ? <Message negative>{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={reject} disabled={busy}>Ignore</Button>
        <Button primary onClick={() => void approve()} disabled={busy || !privateKeyHex || !offer || !armed}>
          {busy ? 'Linking…' : 'Approve & link'}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
