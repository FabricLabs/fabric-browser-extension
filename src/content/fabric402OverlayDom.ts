'use strict';

import type { FabricPaymentRequestPayload } from '../utils/fabricHttp402';

const OVERLAY_ID = 'fabric-passport-http402-overlay';

function removeExisting (): void {
  document.getElementById(OVERLAY_ID)?.remove();
}

export function showFabric402Overlay (opts: {
  requestUrl: string;
  fabric: FabricPaymentRequestPayload | null;
  bolt11?: string;
  wwwAuthenticate?: string | null;
}): void {
  removeExisting();

  const root = document.createElement('div');
  root.id = OVERLAY_ID;
  root.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2147483646',
    'background:rgba(15,23,42,0.55)',
    'backdrop-filter:blur(4px)',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'font-size:14px',
    'line-height:1.45',
    'color:#e2e8f0'
  ].join(';');

  const panel = document.createElement('div');
  panel.style.cssText = [
    'max-width:460px',
    'width:calc(100% - 32px)',
    'max-height:86vh',
    'overflow:auto',
    'padding:22px',
    'border-radius:12px',
    'background:#0f172a',
    'border:1px solid #334155',
    'box-shadow:0 20px 50px rgba(0,0,0,0.45)'
  ].join(';');

  const title = document.createElement('h2');
  title.style.cssText = 'margin:0 0 8px;font-size:18px;font-weight:600;color:#f8fafc';
  title.textContent = 'Payment required';

  const sub = document.createElement('p');
  sub.style.cssText = 'margin:0 0 14px;color:#94a3b8;font-size:13px';
  sub.textContent =
    'This response is HTTP 402 (Payment Required). Fabric Passport decoded the Fabric / Lightning payment hints.';

  panel.appendChild(title);
  panel.appendChild(sub);

  try {
    const u = new URL(opts.requestUrl);
    const line = document.createElement('p');
    line.style.cssText = 'margin:0 0 12px;font-size:12px;word-break:break-all;color:#64748b';
    line.textContent = u.origin + u.pathname + u.search;
    panel.appendChild(line);
  } catch {
    const line = document.createElement('p');
    line.style.cssText = 'margin:0 0 12px;font-size:12px;color:#64748b';
    const s = opts.requestUrl;
    line.textContent = s.slice(0, 200) + (s.length > 200 ? '…' : '');
    panel.appendChild(line);
  }

  const inv = opts.fabric?.invoice;
  const docOffer = opts.fabric?.documentOffer;
  if (opts.fabric?.detail) {
    const d = document.createElement('p');
    d.style.cssText = 'margin:0 0 12px;color:#cbd5e1';
    d.textContent = String(opts.fabric.detail).slice(0, 280);
    panel.appendChild(d);
  }

  const meta = document.createElement('div');
  meta.style.cssText = 'margin-bottom:14px;display:flex;flex-direction:column;gap:6px';
  if (inv?.amount != null || inv?.currency) {
    const cur = typeof inv.currency === 'string' ? inv.currency : 'BTC';
    const row = document.createElement('div');
    row.style.color = '#38bdf8';
    row.textContent = `Amount (invoice): ${String(inv.amount)} ${cur}`;
    meta.appendChild(row);
  }
  if (docOffer?.purchasePriceSats != null) {
    const row = document.createElement('div');
    row.style.color = '#a78bfa';
    row.textContent = `Document price: ${Math.round(Number(docOffer.purchasePriceSats)).toLocaleString('en-US')} sats${
      docOffer.documentId ? ` · doc ${docOffer.documentId}` : ''
    }`;
    meta.appendChild(row);
  }
  if (docOffer?.contentHashHex) {
    const row = document.createElement('div');
    row.style.cssText = 'font-size:11px;color:#64748b;word-break:break-all';
    row.textContent = `contentHash: ${docOffer.contentHashHex}`;
    meta.appendChild(row);
  }
  if (meta.childNodes.length) panel.appendChild(meta);

  if (opts.wwwAuthenticate) {
    const w = document.createElement('p');
    w.style.cssText = 'margin:0 0 8px;font-size:11px;color:#64748b';
    w.textContent = 'An L402 Lightning challenge header was present.';
    panel.appendChild(w);
  }

  let boltTa: HTMLTextAreaElement | null = null;
  const b11 = opts.bolt11;
  if (b11 && b11.startsWith('ln')) {
    const lab = document.createElement('label');
    lab.style.cssText = 'display:block;margin:10px 0 6px;color:#cbd5e1;font-size:12px;font-weight:500';
    lab.textContent = 'Lightning invoice (BOLT11)';
    boltTa = document.createElement('textarea');
    boltTa.readOnly = true;
    boltTa.rows = 4;
    boltTa.value = b11;
    boltTa.style.cssText = [
      'width:100%',
      'box-sizing:border-box',
      'padding:10px',
      'border-radius:8px',
      'border:1px solid #334155',
      'background:#020617',
      'color:#e2e8f0',
      'font-family:ui-monospace,Menlo,monospace',
      'font-size:11px',
      'resize:vertical'
    ].join(';');
    panel.appendChild(lab);
    panel.appendChild(boltTa);
  } else if (opts.fabric) {
    const err = document.createElement('p');
    err.style.cssText = 'margin:12px 0;color:#fca5a5;font-size:13px';
    err.textContent =
      'No BOLT11 invoice was found in the Fabric headers. Settle using your app or wallet outside the browser flow.';
    panel.appendChild(err);
  }

  const row = document.createElement('div');
  row.style.cssText = 'display:flex;flex-wrap:wrap;gap:10px;margin-top:18px;align-items:center';

  const btn = (label: string, primary: boolean, secondaryBlue: boolean, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    const bg = primary ? (secondaryBlue ? '#0369a1' : '#0284c7') : '#334155';
    b.style.cssText = [
      'cursor:pointer',
      'padding:10px 16px',
      'border:none',
      'border-radius:8px',
      'font-weight:600',
      'font-size:13px',
      `background:${bg}`,
      'color:#f8fafc'
    ].join(';');
    b.addEventListener('click', () => {
      try {
        onClick();
      } catch (_) {}
    });
    return b;
  };

  if (b11 && b11.startsWith('ln')) {
    row.appendChild(
      btn('Copy invoice', false, false, async () => {
        try {
          await navigator.clipboard.writeText(b11);
        } catch (_) {
          if (boltTa) {
            boltTa.select();
            document.execCommand('copy');
          }
        }
      })
    );

    row.appendChild(
      btn('Open in Lightning wallet', true, false, () => {
        const uri = `lightning:${b11}`;
        try {
          window.open(uri, '_blank', 'noopener,noreferrer');
        } catch (_) {
          window.location.href = uri;
        }
      })
    );

    row.appendChild(
      btn('Pay from Passport wallet', true, true, () => {
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          void chrome.runtime.sendMessage({ type: 'FABRIC_PAY_BOLT11_FROM_PASSPORT', bolt11: b11 });
        }
      })
    );
  }

  row.appendChild(
    btn('Dismiss', false, false, () => {
      removeExisting();
    })
  );

  panel.appendChild(row);
  root.appendChild(panel);

  root.addEventListener('click', (ev) => {
    if (ev.target === root) removeExisting();
  });

  document.documentElement.appendChild(root);
}
