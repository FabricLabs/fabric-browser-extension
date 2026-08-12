'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Message, Modal } from 'semantic-ui-react';
import {
  FABRIC_PENDING_SITE_LOGIN_KEY,
  FABRIC_RUNTIME_SITE_LOGIN_CLEAR,
  FABRIC_RUNTIME_SITE_LOGIN_COMPLETE,
  FABRIC_RUNTIME_SITE_LOGIN_GET,
  FABRIC_SITE_LOGIN_RESULT
} from '../constants/siteLogin';
import { buildClientSignedLoginBody, postClientSignedLogin } from '../utils/fabricSiteLoginSign';
import { swallowNonFatal } from '../utils/nonFatal';

export type PendingSiteLogin = {
  sessionId: string;
  hubBase: string;
  origin: string;
  message: string;
  pageOrigin: string;
  createdAt: number;
};

type Props = {
  /** Session-only private key hex for the current identity (required to approve). */
  privateKeyHex?: string | null;
  /** Account xpub for the identity payload. */
  xpub?: string | null;
  /** True when a signing identity is selected but locked. */
  needsUnlock?: boolean;
};

function notifyPage (tabId: number | undefined, payload: Record<string, unknown>): void {
  if (tabId == null) return;
  void chrome.tabs.sendMessage(tabId, {
    type: 'FABRIC_SITE_LOGIN_PAGE_RESULT',
    ...payload
  }).catch((err: unknown) => swallowNonFatal('site-login-page-result', err));
}

/**
 * Approves client-signed Fabric site login challenges queued by the content script.
 */
export default function SiteLoginPrompt (props: Props): React.ReactElement | null {
  const { privateKeyHex, xpub, needsUnlock } = props;
  const [pending, setPending] = useState<PendingSiteLogin | null>(null);
  const [tabId, setTabId] = useState<number | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pull = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_GET }, (res) => {
      if (chrome.runtime.lastError) return;
      const p = res && res.pending ? (res.pending as PendingSiteLogin) : null;
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
      if (area === 'session' && changes[FABRIC_PENDING_SITE_LOGIN_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [pull]);

  const clearPending = useCallback(() => {
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_CLEAR }, () => {
      setPending(null);
    });
  }, []);

  const reject = useCallback(() => {
    notifyPage(tabId, {
      source: 'fabric-passport',
      type: FABRIC_SITE_LOGIN_RESULT,
      ok: false,
      error: 'rejected'
    });
    chrome.runtime.sendMessage({
      type: FABRIC_RUNTIME_SITE_LOGIN_COMPLETE,
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
      const body = buildClientSignedLoginBody(pending.message, privateKeyHex, xpub);
      const posted = await postClientSignedLogin(pending.hubBase, pending.sessionId, body);
      if (!posted.ok) {
        setError(posted.error);
        setBusy(false);
        return;
      }
      notifyPage(tabId, {
        source: 'fabric-passport',
        type: FABRIC_SITE_LOGIN_RESULT,
        ok: true,
        sessionId: pending.sessionId,
        identity: body.identity
      });
      chrome.runtime.sendMessage({
        type: FABRIC_RUNTIME_SITE_LOGIN_COMPLETE,
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

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Sign in to website</Modal.Header>
      <Modal.Content>
        <p>
          A site is asking Fabric Passport to prove your identity. Approve only if you
          started this login.
        </p>
        {needsUnlock || !privateKeyHex ? (
          <Message warning>
            Unlock your identity in Passport (password), then click Approve again.
          </Message>
        ) : null}
        <p><strong>Site</strong><br />{pending.origin || pending.hubBase}</p>
        <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
          <strong>Session</strong><br />{pending.sessionId}
        </p>
        {error ? <Message negative>{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={reject} disabled={busy}>Ignore</Button>
        <Button primary onClick={() => void approve()} disabled={busy || !privateKeyHex}>
          {busy ? 'Signing…' : 'Approve & sign'}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
