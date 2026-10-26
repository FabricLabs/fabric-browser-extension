'use strict';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, Form, Input, Message, Modal, Radio } from 'semantic-ui-react';
import {
  FABRIC_PENDING_PASSPORT_KEY,
  FABRIC_RUNTIME_DESKTOP_SIGN,
  FABRIC_RUNTIME_PASSPORT_ANSWER,
  FABRIC_RUNTIME_PASSPORT_LIST
} from '../constants/siteLogin';
import {
  buildDesktopSignRequest,
  consentedDisclosures,
  deriveAccountKeys,
  describeDisclosures,
  sanitizeSitePurpose,
  shortKey,
  signPassportAssertion,
  type PassportDisclosure
} from '../utils/fabricSiteMessage';
import { pinsForChallenge, readDesktopPins, type DesktopPin } from '../utils/fabricDesktopSigner';
import type { PendingPassportRow } from '../background/fabricSiteLoginRuntime';
import { useArmDelay } from './useArmDelay';

export type AccountChoice = {
  account: number;
  network: string;
  label?: string | null;
};

type Props = {
  /** Unlocked master xprv (session only), or null while locked. */
  masterXprv?: string | null;
  /** Account and network Passport is on now; the prompt starts there. */
  current: AccountChoice;
  /** Accounts the user has opened, for the picker. */
  accounts?: AccountChoice[];
  /** Networks an account may be used on. */
  networks?: readonly string[];
  needsUnlock?: boolean;
  /** Unlocks with the lock password; returns an error message or null on success. */
  onUnlock?: (password: string) => Promise<string | null> | string | null;
};

function secondsLeft (expiresAt: number | undefined): number | null {
  if (!expiresAt) return null;
  return Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
}

function accountKey (a: AccountChoice): string {
  return `${a.network}:${a.account}`;
}

/** Choices for the picker: the current account first, no duplicates. */
export function accountOptions (current: AccountChoice, accounts: AccountChoice[] = []): AccountChoice[] {
  const out: AccountChoice[] = [];
  const seen = new Set<string>();
  for (const a of [current, ...accounts]) {
    if (!a || !Number.isInteger(a.account)) continue;
    const k = `${a.account}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a);
  }
  return out;
}

async function send<T> (message: Record<string, unknown>): Promise<T | null> {
  try {
    return await chrome.runtime.sendMessage(message) as T;
  } catch {
    return null;
  }
}

/**
 * Approves Passport sign-ins queued by the background, oldest first. Signs
 * with the identity of the chosen account on the chosen network (fixed when
 * the site names one), or asks a pinned desktop app to. Wallet and escrow keys
 * are shared only when the site asked and the user ticks them.
 */
export default function SiteLoginPrompt (props: Props): React.ReactElement | null {
  const { masterXprv, current, accounts, networks, needsUnlock, onUnlock } = props;
  const [queue, setQueue] = useState<PendingPassportRow[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pins, setPins] = useState<DesktopPin[]>([]);
  const [choice, setChoice] = useState<string>('passport');
  const [accountIndex, setAccountIndex] = useState<number>(current.account);
  const [network, setNetwork] = useState<string>(current.network);
  const [ticked, setTicked] = useState<PassportDisclosure[]>([]);

  const pending = queue[0] || null;
  const armed = useArmDelay(pending ? `${pending.key}|${pending.requestId}|${pending.nonce}` : '');
  const effectiveNetwork = pending && pending.network ? pending.network : network;

  const pull = useCallback(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
    void send<{ ok: boolean; pending: PendingPassportRow[] }>({ type: FABRIC_RUNTIME_PASSPORT_LIST }).then((res) => {
      const rows = res && Array.isArray(res.pending) ? [...res.pending].sort((a, b) => a.createdAt - b.createdAt) : [];
      setQueue(rows);
      if (!rows.length) {
        setWaitingOn(null);
        setBusy(false);
      }
    });
  }, []);

  useEffect(() => {
    pull();
    if (typeof chrome === 'undefined' || !chrome.storage?.onChanged) return undefined;
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && changes[FABRIC_PENDING_PASSPORT_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [pull]);

  useEffect(() => {
    if (!pending) return;
    setError(null);
    setTicked([]);
    setChoice('passport');
    setAccountIndex(current.account);
    setNetwork(pending.network || current.network);
    let cancelled = false;
    void readDesktopPins().then((found) => {
      if (!cancelled) setPins(pinsForChallenge(found, pending.network));
    });
    return () => { cancelled = true; };
  }, [pending?.key, pending?.requestId]); // eslint-disable-line react-hooks/exhaustive-deps

  const passportPubkey = useMemo(() => {
    if (!masterXprv) return null;
    try {
      return String(deriveAccountKeys(masterXprv, { account: accountIndex, network: effectiveNetwork }).identity.pubkey);
    } catch {
      return null;
    }
  }, [masterXprv, accountIndex, effectiveNetwork]);

  const answer = useCallback(async (row: PendingPassportRow, payload: Record<string, unknown>) => {
    const res = await send<{ ok: boolean; error?: string }>({
      type: FABRIC_RUNTIME_PASSPORT_ANSWER,
      key: row.key,
      requestId: row.requestId,
      ...payload
    });
    if (!res || res.ok !== true) return (res && typeof res.error === 'string') ? res.error : 'Passport could not answer';
    return null;
  }, []);

  const reject = useCallback(async () => {
    if (!pending) return;
    await answer(pending, { ok: false, error: 'rejected' });
    pull();
  }, [answer, pending, pull]);

  const approve = useCallback(async () => {
    if (!pending || !armed) return;
    if (!masterXprv) {
      setError(needsUnlock ? 'Unlock Passport (lock password), then approve again.' : 'Passport is locked.');
      return;
    }
    setBusy(true);
    setError(null);
    const disclose = consentedDisclosures(pending.request, ticked);
    try {
      const pin = pins.find((p) => p.base === choice) || null;
      if (pin) {
        const wrapped = buildDesktopSignRequest({
          challenge: pending.challenge,
          origin: pending.origin,
          masterXprv,
          device: { account: pin.device.account, network: pin.device.network },
          disclose
        });
        if (wrapped.device !== pin.device.pubkey) {
          setError('This Passport account is not the one linked to that desktop app. Link it again under Devices.');
          return;
        }
        setWaitingOn(pin.name || pin.base);
        const res = await send<{ ok: boolean; error?: string }>({
          type: FABRIC_RUNTIME_DESKTOP_SIGN,
          key: pending.key,
          requestId: pending.requestId,
          base: pin.base,
          signRequestUri: wrapped.uri,
          expiresAt: wrapped.expiresAt
        });
        setWaitingOn(null);
        if (!res || res.ok !== true) {
          setError((res && typeof res.error === 'string') ? res.error : 'the desktop app did not answer');
          return;
        }
      } else {
        const signed = signPassportAssertion({
          challenge: pending.challenge,
          origin: pending.origin,
          masterXprv,
          account: accountIndex,
          network: effectiveNetwork,
          disclose
        });
        const failure = await answer(pending, { ok: true, assertion: signed.uri });
        if (failure) {
          setError(failure);
          return;
        }
      }
      pull();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [pending, armed, masterXprv, needsUnlock, ticked, pins, choice, accountIndex, effectiveNetwork, answer, pull]);

  const unlock = useCallback(async () => {
    if (!onUnlock) return;
    const unlockError = await onUnlock(password);
    setError(unlockError);
    if (!unlockError) setPassword('');
  }, [onUnlock, password]);

  if (!pending) return null;

  const left = secondsLeft(pending.expiresAt);
  const purpose = sanitizeSitePurpose(pending.purpose);
  const options = accountOptions(current, accounts);
  const networkChoices = (networks && networks.length ? networks : [current.network]);
  const disclose = consentedDisclosures(pending.request, ticked);
  const usingDesktop = choice !== 'passport';

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Sign in to {pending.origin.replace(/^https:\/\//, '')}</Modal.Header>
      <Modal.Content>
        <p>
          This site is asking you to sign in with Fabric. The answer works only
          for this site and expires in minutes. Approve only if you started this
          sign-in.
        </p>
        {!masterXprv && onUnlock ? (
          <Form onSubmit={() => void unlock()}>
            <Form.Field>
              <label>Lock password</label>
              <Input
                type="password"
                value={password}
                onChange={(e) => { setPassword(e.target.value); setError(null); }}
                autoComplete="current-password"
                action={{ type: 'submit', content: 'Unlock', color: 'blue' }}
              />
            </Form.Field>
          </Form>
        ) : null}
        <p>
          <strong>Site</strong><br />{pending.origin}
          {pending.tabTitle ? <><br /><span style={{ fontSize: '0.85em' }}>Tab: {pending.tabTitle}</span></> : null}
        </p>
        {purpose ? (
          <p>
            <strong>Message from the site (not verified)</strong><br />
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{purpose}</span>
          </p>
        ) : null}
        <p style={{ fontSize: '0.85em' }}>
          {pending.siteAuthor
            ? <>Challenge signed with site key <code>{shortKey(pending.siteAuthor)}</code></>
            : 'Challenge not signed by the site'}
          {left != null ? ` · expires in ${left}s` : ''}
          {queue.length > 1 ? ` · ${queue.length - 1} more waiting` : ''}
        </p>
        <Form>
          <Form.Field><label>Sign in as</label></Form.Field>
          <Form.Field>
            <Radio
              label={`This Passport${passportPubkey ? ` (${shortKey(passportPubkey)})` : ''}`}
              name="passport-signer"
              value="passport"
              checked={!usingDesktop}
              onChange={() => setChoice('passport')}
            />
          </Form.Field>
          {pins.map((p) => (
            <Form.Field key={p.base}>
              <Radio
                label={`${p.name || p.signer} on ${p.base.replace(/^https?:\/\//, '')} (${shortKey(p.pubkey)}) — approve on the desktop`}
                name="passport-signer"
                value={p.base}
                checked={choice === p.base}
                onChange={() => setChoice(p.base)}
              />
            </Form.Field>
          ))}
          {!usingDesktop ? (
            <Form.Group widths="equal">
              <Form.Field>
                <label>Account</label>
                <Dropdown
                  selection
                  options={options.map((a) => ({
                    key: accountKey(a),
                    value: a.account,
                    text: a.label ? `${a.label} (#${a.account})` : `Account #${a.account}`
                  }))}
                  value={accountIndex}
                  onChange={(_e, d) => setAccountIndex(Number(d.value))}
                />
              </Form.Field>
              <Form.Field>
                <label>Network{pending.network ? ' (set by the site)' : ''}</label>
                <Dropdown
                  selection
                  disabled={!!pending.network}
                  options={(pending.network ? [pending.network] : networkChoices).map((n) => ({ key: n, value: n, text: n }))}
                  value={effectiveNetwork}
                  onChange={(_e, d) => setNetwork(String(d.value))}
                />
              </Form.Field>
            </Form.Group>
          ) : null}
          {pending.request.includes('wallet') ? (
            <Form.Field>
              <Checkbox
                label="Also share my wallet (balance, history, and addresses)"
                checked={ticked.includes('wallet')}
                onChange={(_e, d) => setTicked((t) => d.checked ? [...t, 'wallet'] : t.filter((x) => x !== 'wallet'))}
              />
            </Form.Field>
          ) : null}
          {pending.request.includes('cosigner') ? (
            <Form.Field>
              <Checkbox
                label="Also share my escrow key (for multisig with this site)"
                checked={ticked.includes('cosigner')}
                onChange={(_e, d) => setTicked((t) => d.checked ? [...t, 'cosigner'] : t.filter((x) => x !== 'cosigner'))}
              />
            </Form.Field>
          ) : null}
        </Form>
        <Message size="small">
          <strong>This site will see</strong>
          <ul style={{ margin: '0.5em 0 0' }}>
            {describeDisclosures(disclose).map((line) => <li key={line}>{line}</li>)}
          </ul>
        </Message>
        {waitingOn ? <Message info>Waiting for you to approve on {waitingOn}…</Message> : null}
        {error ? <Message negative>{error}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => void reject()} disabled={busy}>Decline</Button>
        <Button primary onClick={() => void approve()} disabled={busy || !masterXprv || !armed}>
          {busy ? 'Signing…' : 'Sign in'}
        </Button>
      </Modal.Actions>
    </Modal>
  );
}
