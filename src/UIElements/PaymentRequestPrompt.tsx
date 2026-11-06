'use strict';

import React, { useCallback, useEffect, useState } from 'react';
import { Button, Form, Message, Modal, TextArea } from 'semantic-ui-react';
import {
  FABRIC_PAYMENT_DISMISS,
  FABRIC_PAYMENT_PAY,
  FABRIC_PAYMENTS_LIST,
  FABRIC_PENDING_PAYMENTS_KEY
} from '../constants/fabric402';
import type { PaymentRequest } from '../background/paymentRequests';
import { describeSite } from '../utils/siteIdentity';
import { delegationCall } from './delegationApi';
import SiteName from './SiteName';
import { useArmDelay } from './useArmDelay';

/**
 * A site answered HTTP 402 with a Lightning invoice. Passport shows it here,
 * in its own popup, never on the page: copy it, open a Lightning wallet, or pay
 * from the active Fabric node.
 */
export default function PaymentRequestPrompt (): React.ReactElement | null {
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const current = requests[0] || null;
  const armed = useArmDelay(current ? current.id : '');

  const pull = useCallback(() => {
    void delegationCall<{ requests?: PaymentRequest[] }>(FABRIC_PAYMENTS_LIST).then((res) => {
      setRequests(res && Array.isArray(res.requests) ? res.requests : []);
    });
  }, []);

  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return undefined;
    pull();
    const onChange = (changes: { [key: string]: chrome.storage.StorageChange }, area: string) => {
      if (area === 'session' && changes[FABRIC_PENDING_PAYMENTS_KEY]) pull();
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => chrome.storage.onChanged.removeListener(onChange);
  }, [pull]);

  useEffect(() => { setResult(null); }, [current ? current.id : null]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!current) return null;

  const dismiss = async () => {
    await delegationCall(FABRIC_PAYMENT_DISMISS, { id: current.id });
    pull();
  };

  const pay = async () => {
    setBusy(true);
    const res = await delegationCall<{ message?: string }>(FABRIC_PAYMENT_PAY, { id: current.id });
    setBusy(false);
    setResult({ ok: !!res.ok, message: String(res.message || res.error || (res.ok ? 'Paid.' : 'The payment did not go through.')) });
    pull();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(current.bolt11);
      setResult({ ok: true, message: 'Invoice copied.' });
    } catch {
      setResult({ ok: false, message: 'Could not copy; select the invoice and copy it by hand.' });
    }
  };

  return (
    <Modal open size="small" closeOnDimmerClick={false}>
      <Modal.Header>Payment requested</Modal.Header>
      <Modal.Content>
        <p>This site asks for a Lightning payment:</p>
        <SiteName site={describeSite(current.origin)} />
        {current.detail ? <p style={{ marginTop: '0.75em' }}>{current.detail}</p> : null}
        {current.amount ? <p>Amount: <strong>{current.amount}</strong></p> : null}
        {current.priceSats != null ? <p>Price: <strong>{current.priceSats.toLocaleString('en-US')} sats</strong></p> : null}
        <p style={{ fontSize: '0.85em', wordBreak: 'break-all', opacity: 0.7 }}>{current.requestUrl}</p>
        <Form>
          <TextArea readOnly rows={3} value={current.bolt11} style={{ fontFamily: 'monospace', fontSize: '0.8em' }} />
        </Form>
        <p style={{ fontSize: '0.85em', marginTop: '0.5em' }}>
          Check the amount in your wallet before you pay: the site wrote this invoice.
          {requests.length > 1 ? ` ${requests.length - 1} more waiting.` : ''}
        </p>
        {result ? <Message size="small" positive={result.ok} negative={!result.ok}>{result.message}</Message> : null}
      </Modal.Content>
      <Modal.Actions>
        <Button disabled={busy} onClick={() => void dismiss()} content="Dismiss" />
        <Button disabled={busy} onClick={() => void copy()} content="Copy invoice" />
        <Button as="a" href={`lightning:${current.bolt11}`} target="_blank" rel="noopener noreferrer" content="Open in Lightning wallet" />
        <Button primary loading={busy} disabled={busy || !armed} onClick={() => void pay()} content="Pay from Fabric node" />
      </Modal.Actions>
    </Modal>
  );
}
