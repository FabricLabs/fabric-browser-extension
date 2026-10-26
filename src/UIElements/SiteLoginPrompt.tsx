'use strict';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Form, Input, Message, Modal, Radio } from 'semantic-ui-react';
import {
  FABRIC_MESSAGE_PAGE_RESULT,
  FABRIC_PENDING_SITE_LOGIN_KEY,
  FABRIC_RUNTIME_DESKTOP_SIGN,
  FABRIC_RUNTIME_SITE_LOGIN_CLEAR,
  FABRIC_RUNTIME_SITE_LOGIN_COMPLETE,
  FABRIC_RUNTIME_SITE_LOGIN_GET,
  FABRIC_SITE_LOGIN_PAGE_RESULT
} from '../constants/siteLogin';
import { parseHubLoginChallenge, postFabricSiteLogin } from '../utils/fabricSiteLoginSign';
import {
  buildDesktopSignRequest,
  passportSigningKey,
  sanitizeSitePurpose,
  shortKey,
  signPassportSiteLogin
} from '../utils/fabricSiteMessage';
import { discoverDesktopSigners, type DesktopSigner } from '../utils/fabricDesktopSigner';
import { swallowNonFatal } from '../utils/nonFatal';
import { useArmDelay } from './useArmDelay';

export type PendingSiteLogin = {
  kind?: 'hub-login' | 'fabric';
  sessionId: string;
  hubBase: string;
  origin: string;
  message: string;
  pageOrigin: string;
  nonce?: string;
  createdAt: number;
  tabId?: number;
  frameId?: number;
  requestId?: string;
  requestUri?: string;
  purpose?: string | null;
  expiresAt?: number;
  siteAuthor?: string | null;
};

type Props = {
  /** Session-only private key hex for the current identity (required to approve). */
  privateKeyHex?: string | null;
  /** Account xpub for the identity payload. */
  xpub?: string | null;
  /** True when a signing identity is selected but locked. */
  needsUnlock?: boolean;
  /** Decrypts the selected identity's key; returns an error message or null on success. */
  onUnlock?: (password: string) => string | null;
};

/** Legacy `/sessions` challenges carry no expiry; desktop sign requests for them last two minutes. */
const HUB_LOGIN_DESKTOP_TTL_MS = 2 * 60 * 1000;

function notifyPage (pending: PendingSiteLogin, payload: Record<string, unknown>): void {
  if (pending.tabId == null) return;
  const message = pending.kind === 'fabric'
    ? { type: FABRIC_MESSAGE_PAGE_RESULT, origin: pending.origin, id: pending.requestId || '', ...payload }
    : { type: FABRIC_SITE_LOGIN_PAGE_RESULT, origin: pending.origin, sessionId: pending.sessionId, ...payload };
  const sent = typeof pending.frameId === 'number'
    ? chrome.tabs.sendMessage(pending.tabId, message, { frameId: pending.frameId })
    : chrome.tabs.sendMessage(pending.tabId, message);
  void Promise.resolve(sent).catch((err: unknown) => swallowNonFatal('site-login-page-result', err));
}

function secondsLeft (expiresAt: number | undefined): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

/**
 * Approves site logins queued by the content script: legacy `/sessions`
 * challenges and page `fabric:` `SiteLoginRequest`s. Signs with this Passport
 * identity or asks a linked desktop app (Hub, GoonCitizen) to sign.
 */
export default function SiteLoginPrompt (props: Props): React.ReactElement | null {
  const { privateKeyHex, xpub, needsUnlock, onUnlock } = props;
  const [pending, setPending] = useState<PendingSiteLogin | null>(null);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [desktops, setDesktops] = useState<DesktopSigner[]>([]);
  const [choice, setChoice] = useState<string>('passport');
  const armed = useArmDelay(pending ? `${pending.origin}|${pending.nonce || ''}|${pending.sessionId}|${pending.createdAt}` : '');

  const passport = useMemo(() => {
    if (!privateKeyHex) return null;
    try {
      return passportSigningKey(privateKeyHex, xpub).key;
    } catch {
      return null;
    }
  }, [privateKeyHex, xpub]);
  const passportPubkey = passport ? String(passport.pubkey) : null;

  const pull = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_GET }, (res) => {
      if (chrome.runtime.lastError) return;
      const p = res && res.pending ? (res.pending as PendingSiteLogin) : null;
      setPending(p);
      setError(null);
      if (!p) {
        setWaitingOn(null);
        setBusy(false);
      }
    });
  }, []);

  useEffect(() => {
    pull();
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return undefined;
    const onChange = (
      changes: { [key: string]: chrome.storage.StorageChange },
      area: string
    ) => {
      if ((area === 'session' || area === 'local') && changes[FABRIC_PENDING_SITE_LOGIN_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [pull]);

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    void discoverDesktopSigners({ pubkey: passportPubkey }).then((found) => {
      if (!cancelled) setDesktops(found);
    });
    return () => { cancelled = true; };
  }, [pending, passportPubkey]);

  const clearPending = useCallback(() => {
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_CLEAR }, () => {
      setPending(null);
    });
  }, []);

  const reject = useCallback(() => {
    if (!pending) return;
    notifyPage(pending, { ok: false, error: 'rejected' });
    chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_COMPLETE, ok: false, error: 'rejected' });
    clearPending();
  }, [clearPending, pending]);

  const approveWithPassport = useCallback(async (p: PendingSiteLogin, keyHex: string) => {
    if (p.kind === 'fabric') {
      const signed = signPassportSiteLogin({ origin: p.origin, nonce: String(p.nonce), privateKeyHex: keyHex, xpub });
      notifyPage(p, { ok: true, message: signed.uri, signer: 'passport' });
      return null;
    }
    const challenge = parseHubLoginChallenge(p.message, p.sessionId);
    if (!challenge) return 'This sign-in challenge does not match its session — reload the site and try again.';
    const signed = signPassportSiteLogin({ origin: challenge.origin, nonce: challenge.nonce, privateKeyHex: keyHex, xpub, includeXpub: true });
    const posted = await postFabricSiteLogin(p.hubBase, p.sessionId, signed.uri);
    if (!posted.ok) return posted.error;
    notifyPage(p, { ok: true, identity: signed.identity });
    return null;
  }, [xpub]);

  const approveWithDesktop = useCallback(async (p: PendingSiteLogin, keyHex: string, desktop: DesktopSigner) => {
    const expiresAt = p.kind === 'fabric' && p.expiresAt ? p.expiresAt : Date.now() + HUB_LOGIN_DESKTOP_TTL_MS;
    const wrapped = buildDesktopSignRequest({
      origin: p.origin,
      nonce: String(p.nonce),
      purpose: p.purpose || null,
      expiresAt,
      requestUri: p.kind === 'fabric' ? p.requestUri : null,
      privateKeyHex: keyHex
    });
    setWaitingOn(desktop.name || desktop.base);
    const res = await chrome.runtime.sendMessage({
      type: FABRIC_RUNTIME_DESKTOP_SIGN,
      base: desktop.base,
      signRequestUri: wrapped.uri,
      expiresAt: wrapped.expiresAt,
      desktopPubkey: desktop.pubkey,
      nonce: p.nonce
    });
    setWaitingOn(null);
    if (!res || res.ok !== true) return (res && typeof res.error === 'string') ? res.error : 'desktop did not sign';
    return null;
  }, []);

  const approve = useCallback(async () => {
    if (!pending || !armed) return;
    if (!privateKeyHex) {
      setError(needsUnlock
        ? 'Unlock your Passport identity (enter password), then approve again.'
        : 'No unlocked signing key — open Passport and unlock your identity.');
      return;
    }
    if (!pending.nonce) {
      setError('This sign-in request is incomplete — reload the site and try again.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const desktop = desktops.find((d) => d.base === choice) || null;
      const failure = desktop
        ? await approveWithDesktop(pending, privateKeyHex, desktop)
        : await approveWithPassport(pending, privateKeyHex);
      if (failure) {
        setError(failure);
        return;
      }
      if (!desktop) {
        chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_SITE_LOGIN_COMPLETE, ok: true, sessionId: pending.sessionId });
        clearPending();
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pending, armed, privateKeyHex, needsUnlock, desktops, choice, approveWithDesktop, approveWithPassport, clearPending]);

  const unlock = useCallback(() => {
    if (!onUnlock) return;
    const unlockError = onUnlock(password);
    setError(unlockError);
    if (!unlockError) setPassword('');
  }, [onUnlock, password]);

  if (!pending) return null;

  const canUnlockHere = !!onUnlock && (needsUnlock || !privateKeyHex);
  const left = secondsLeft(pending.expiresAt);
  const purpose = sanitizeSitePurpose(pending.purpose);
  const linked = desktops.filter((d) => d.linked);
  const unlinked = desktops.filter((d) => !d.linked);

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Sign in to website</Modal.Header>
      <Modal.Content>
        <p>
          A website is asking you to prove a Fabric identity. The answer works
          only for this site and expires in minutes. Approve only if you started
          this sign-in.
        </p>
        {canUnlockHere ? (
          <Form onSubmit={unlock}>
            <Form.Field>
              <label>Password (unlock your identity to sign)</label>
              <Input
                type="password"
                placeholder="Password from wallet creation or seed login"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                autoComplete="off"
                action={{ type: 'submit', content: 'Unlock', color: 'blue' }}
              />
            </Form.Field>
          </Form>
        ) : (needsUnlock || !privateKeyHex) ? (
          <Message warning>
            Unlock your identity in Passport (password), then click Approve again.
          </Message>
        ) : null}
        <p><strong>Site</strong><br />{pending.origin}</p>
        {purpose ? (
          <p>
            <strong>Message from the site (not verified)</strong><br />
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{purpose}</span>
          </p>
        ) : null}
        {pending.kind === 'fabric' ? (
          <p style={{ fontSize: '0.85em' }}>
            {pending.siteAuthor
              ? <>Request signed with key <code>{shortKey(pending.siteAuthor)}</code></>
              : 'Request not signed'}
            {left != null ? ` · expires in ${left}s` : ''}
          </p>
        ) : (
          <p style={{ wordBreak: 'break-all', fontSize: '0.85em' }}>
            <strong>Session</strong><br />{pending.sessionId}
          </p>
        )}
        <Form>
          <Form.Field><label>Sign in as</label></Form.Field>
          <Form.Field>
            <Radio
              label={`This Passport${passportPubkey ? ` (${shortKey(passportPubkey)})` : ''}`}
              name="site-login-identity"
              value="passport"
              checked={choice === 'passport'}
              onChange={() => setChoice('passport')}
            />
          </Form.Field>
          {linked.map((d) => (
            <Form.Field key={d.base}>
              <Radio
                label={`${d.name || d.signer} on ${d.base.replace(/^https?:\/\//, '')} (${shortKey(d.pubkey)}) — approve on the desktop`}
                name="site-login-identity"
                value={d.base}
                checked={choice === d.base}
                onChange={() => setChoice(d.base)}
              />
            </Form.Field>
          ))}
          {unlinked.length ? (
            <p style={{ fontSize: '0.85em' }}>
              Also running here, not linked to this Passport: {unlinked.map((d) => d.name || d.base).join(', ')}.
              Link it under Settings → Devices to sign in with its identity.
            </p>
          ) : null}
        </Form>
        {waitingOn ? <Message info>Waiting for you to approve on {waitingOn}…</Message> : null}
        {error ? <Message negative>{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={reject} disabled={busy}>Ignore</Button>
        <Button primary onClick={() => void approve()} disabled={busy || !privateKeyHex || !armed}>
          {busy ? 'Signing…' : 'Approve & sign'}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
