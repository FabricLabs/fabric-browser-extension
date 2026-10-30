'use strict';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Checkbox, Dropdown, Form, Input, Message, Modal, Radio } from 'semantic-ui-react';
import {
  FABRIC_PENDING_PASSPORT_KEY,
  FABRIC_RUNTIME_DELEGATE_SIGN_IN,
  FABRIC_RUNTIME_PASSPORT_ANSWER,
  FABRIC_RUNTIME_PASSPORT_LIST
} from '../constants/siteLogin';
import {
  consentedDisclosures,
  describeDisclosures,
  sanitizeSitePurpose,
  shortKey,
  signPassportAssertion,
  siteIdentityKey,
  type PassportDisclosure
} from '../utils/fabricSiteMessage';
import {
  DEFAULT_FABRIC_HUB_ORIGINS,
  isAllowedFabricHub,
  loadFabricHubGateOptions,
  type FabricHubGateOptions
} from '../utils/fabricHubAllowlist';
import { describeSite } from '../utils/siteIdentity';
import { readSignedInSites, rememberSignIn, type SignedInSite } from '../utils/signedInSites';
import type { PendingPassportRow } from '../background/fabricSiteLoginRuntime';
import { passportSigners, useDelegationState } from './delegationApi';
import SiteName from './SiteName';
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

/** Which of this Passport's identities a site sees unless the user picks another. */
export function defaultSiteIdentity (origin: string, sites: Record<string, SignedInSite>, gate: FabricHubGateOptions): 'main' | 'pairwise' {
  const seen = sites[origin];
  if (seen && seen.identity === 'main') return 'main';
  if (!seen && isAllowedFabricHub(origin, gate)) return 'main';
  return 'pairwise';
}

/**
 * Approves Passport sign-ins queued by the background, oldest first. Signs
 * with this site's own identity (or the account identity) of the chosen
 * account on the chosen network (fixed when the site names one), or asks a
 * linked signer that lets Passport ask it. Wallet and escrow keys are shared
 * only when the site asked and the user ticks them.
 */
export default function SiteLoginPrompt (props: Props): React.ReactElement | null {
  const { masterXprv, current, accounts, networks, needsUnlock, onUnlock } = props;
  const [queue, setQueue] = useState<PendingPassportRow[]>([]);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [waitingOn, setWaitingOn] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string>('pairwise');
  const [sites, setSites] = useState<Record<string, SignedInSite>>({});
  const [gate, setGate] = useState<FabricHubGateOptions>({});
  const { state: delegation } = useDelegationState();
  const signers = useMemo(() => passportSigners(delegation), [delegation]);
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
    setAccountIndex(current.account);
    setNetwork(pending.network || current.network);
    let cancelled = false;
    void Promise.all([
      masterXprv ? readSignedInSites(masterXprv).catch(() => ({})) : Promise.resolve({}),
      loadFabricHubGateOptions()
    ]).then(([found, g]) => {
      if (cancelled) return;
      setSites(found);
      setGate(g);
      setChoice(defaultSiteIdentity(pending.origin, found, g));
    });
    return () => { cancelled = true; };
  }, [pending?.key, pending?.requestId, masterXprv]); // eslint-disable-line react-hooks/exhaustive-deps

  const identityPubkey = useCallback((pairwise: boolean): string | null => {
    if (!masterXprv || !pending) return null;
    try {
      return siteIdentityKey(masterXprv, { account: accountIndex, network: effectiveNetwork }, pending.origin, pairwise).pubkey;
    } catch {
      return null;
    }
  }, [masterXprv, pending, accountIndex, effectiveNetwork]);

  const site = useMemo(() => {
    if (!pending) return null;
    const known = [...DEFAULT_FABRIC_HUB_ORIGINS, ...(gate.extra || []), ...Object.keys(sites)];
    return describeSite(pending.origin, known, Object.keys(sites));
  }, [pending, gate, sites]);

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
      const signer = signers.find((x) => x.pubkey === choice) || null;
      if (signer) {
        setWaitingOn(signer.name);
        const res = await send<{ ok: boolean; error?: string }>({
          type: FABRIC_RUNTIME_DELEGATE_SIGN_IN,
          key: pending.key,
          requestId: pending.requestId,
          target: signer.pubkey,
          disclose
        });
        setWaitingOn(null);
        if (!res || res.ok !== true) {
          setError((res && typeof res.error === 'string') ? res.error : `${signer.name} did not answer`);
          return;
        }
        await rememberSignIn(masterXprv, pending.origin, 'linked').catch(() => undefined);
      } else {
        const pairwise = choice !== 'main';
        const signed = signPassportAssertion({
          challenge: pending.challenge,
          origin: pending.origin,
          masterXprv,
          account: accountIndex,
          network: effectiveNetwork,
          pairwise,
          disclose
        });
        const failure = await answer(pending, { ok: true, assertion: signed.uri });
        if (failure) {
          setError(failure);
          return;
        }
        await rememberSignIn(masterXprv, pending.origin, pairwise ? 'pairwise' : 'main').catch(() => undefined);
      }
      pull();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWaitingOn(null);
      setBusy(false);
    }
  }, [pending, armed, masterXprv, needsUnlock, ticked, signers, choice, accountIndex, effectiveNetwork, answer, pull]);

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
  const usingSigner = choice !== 'main' && choice !== 'pairwise';
  const ownKey = identityPubkey(true);
  const mainKey = identityPubkey(false);

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Sign in to {site ? site.registrable : pending.origin}</Modal.Header>
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
        {site ? <SiteName site={site} /> : null}
        {pending.tabTitle ? <p style={{ fontSize: '0.85em' }}>Tab: {pending.tabTitle}</p> : null}
        {purpose ? (
          <p>
            <strong>Message from the site (not verified)</strong><br />
            <span style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{purpose}</span>
          </p>
        ) : null}
        <p style={{ fontSize: '0.85em' }}>
          {left != null ? `Expires in ${left}s` : ''}
          {queue.length > 1 ? `${left != null ? ' · ' : ''}${queue.length - 1} more waiting` : ''}
        </p>
        <Form>
          <Form.Field><label>Sign in as</label></Form.Field>
          <Form.Field>
            <Radio
              label={`A separate identity for this site${ownKey ? ` (${shortKey(ownKey)})` : ''}`}
              name="passport-signer"
              value="pairwise"
              checked={choice === 'pairwise'}
              onChange={() => setChoice('pairwise')}
            />
          </Form.Field>
          <Form.Field>
            <Radio
              label={`My main identity${mainKey ? ` (${shortKey(mainKey)})` : ''} — sites that share it can tell it's you`}
              name="passport-signer"
              value="main"
              checked={choice === 'main'}
              onChange={() => setChoice('main')}
            />
          </Form.Field>
          {signers.map((x) => (
            <Form.Field key={x.pubkey}>
              <Radio
                label={`${x.name} (${shortKey(x.pubkey)}) — approve it there`}
                name="passport-signer"
                value={x.pubkey}
                checked={choice === x.pubkey}
                onChange={() => setChoice(x.pubkey)}
              />
            </Form.Field>
          ))}
          {!usingSigner ? (
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
