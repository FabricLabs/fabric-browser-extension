'use strict';

import { Buffer } from 'buffer';

export interface FabricPaymentRequestPayload {
  v?: number;
  headerTransport?: string;
  scheme?: string;
  documentExchange?: {
    offerType?: string;
    responseType?: string;
    inventoryWireOpcodes?: { request?: string; response?: string };
    specification?: string;
  };
  invoice?: {
    id?: string;
    amount?: number | string;
    currency?: string;
    bolt11?: string;
    memo?: string;
  };
  documentOffer?: {
    documentId?: string;
    contentHashHex?: string;
    purchasePriceSats?: number;
    network?: string;
  };
  path?: string;
  detail?: string;
}

export function decodeFabricPaymentRequestHeader (encoded: string | null | undefined): FabricPaymentRequestPayload | null {
  if (!encoded || typeof encoded !== 'string') return null;
  const raw = encoded.trim();
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const o = JSON.parse(json);
    return o && typeof o === 'object' && !Array.isArray(o) ? (o as FabricPaymentRequestPayload) : null;
  } catch {
    return null;
  }
}

/**
 * Parse Lightning L402 `WWW-Authenticate` challenge (RFC 7235-style `key="value"` params).
 */
export function parseL402WWWAuthenticate (value: string | null | undefined): { invoice?: string; macaroon?: string } {
  const v = String(value || '').trim();
  if (!v || !/^L402\b/i.test(v)) return {};
  const out: { invoice?: string; macaroon?: string } = {};
  const re = /([A-Za-z0-9_]+)="((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(v)) !== null) {
    const key = m[1].toLowerCase();
    const val = m[2].replace(/\\(.)/g, '$1');
    if (key === 'invoice') out.invoice = val;
    if (key === 'macaroon') out.macaroon = val;
  }
  return out;
}

export function resolveBolt11From402 (
  fabricHeaderUtf8Json: FabricPaymentRequestPayload | null,
  wwwAuthenticate: string | null | undefined
): string | undefined {
  const lnRaw = fabricHeaderUtf8Json?.invoice?.bolt11;
  if (typeof lnRaw === 'string') {
    const ln = lnRaw.trim();
    if (ln.startsWith('ln')) return ln;
  }
  const l402 = parseL402WWWAuthenticate(wwwAuthenticate);
  if (typeof l402.invoice === 'string') {
    const inv = l402.invoice.trim();
    if (inv.startsWith('ln')) return inv;
  }
  return undefined;
}
