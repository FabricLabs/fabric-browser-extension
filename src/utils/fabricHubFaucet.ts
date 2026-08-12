'use strict';

/**
 * Regtest faucet via Fabric Hub's Bitcoin HTTP surface.
 * Mirrors `hub.fabric.pub` / `functions/bitcoinClient.js` `requestFaucet`:
 * `POST {hubBase}/services/bitcoin/faucet` with `{ address, amountSats? }`.
 *
 * @see https://github.com/FabricLabs/hub.fabric.pub — `services/hub.js` `_handleBitcoinFaucetRequest`
 */

const DEFAULT_TIMEOUT_MS = 20_000;
const FAUCET_MAX_SATS = 1_000_000;

export interface HubFaucetSuccess {
  ok: true;
  status?: string;
  network?: string;
  faucet: {
    txid?: string;
    destination: string;
    amountSats: number;
  };
}

export interface HubFaucetFailure {
  ok: false;
  error: string;
}

export type HubFaucetResult = HubFaucetSuccess | HubFaucetFailure;

function normalizeHubBase (hubBaseUrl: string): string {
  return String(hubBaseUrl || '').trim().replace(/\/+$/, '');
}

async function fetchJsonPost (url: string, body: Record<string, unknown>): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    let data: unknown = {};
    try {
      data = await res.json();
    } catch (_e) {
      data = {};
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

/**
 * Request regtest coins from the Hub wallet backing the given Fabric HTTP origin.
 * Uses the same authority as Passport "Fabric nodes" (`hubAddress`).
 */
export async function requestHubRegtestFaucet (
  hubBaseUrl: string,
  options: { address: string; amountSats?: number }
): Promise<HubFaucetResult> {
  const base = normalizeHubBase(hubBaseUrl);
  if (!base) {
    return { ok: false, error: 'Fabric hub base URL is empty.' };
  }
  const address = String(options.address || '').trim();
  if (!address) {
    return { ok: false, error: 'Destination address is required.' };
  }
  let amountSats = Math.round(Number(options.amountSats ?? 10_000));
  if (!Number.isFinite(amountSats) || amountSats <= 0) amountSats = 10_000;
  amountSats = Math.min(amountSats, FAUCET_MAX_SATS);

  const url = `${base}/services/bitcoin/faucet`;
  const { ok, status, data } = await fetchJsonPost(url, { address, amountSats });

  const d = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  if (!ok) {
    const msg =
      typeof d.message === 'string'
        ? d.message
        : typeof d.error === 'string'
          ? d.error
          : `HTTP ${status}`;
    return { ok: false, error: msg };
  }
  if (d.status === 'error') {
    const msg = typeof d.message === 'string' ? d.message : typeof d.error === 'string' ? d.error : 'Faucet error';
    return { ok: false, error: msg };
  }
  const faucetRaw = d.faucet;
  if (!faucetRaw || typeof faucetRaw !== 'object') {
    return { ok: false, error: 'Unexpected faucet response (missing faucet object).' };
  }
  const f = faucetRaw as Record<string, unknown>;
  const dest = typeof f.destination === 'string' ? f.destination : address;
  const amt = typeof f.amountSats === 'number' && Number.isFinite(f.amountSats) ? f.amountSats : amountSats;
  const txid = typeof f.txid === 'string' ? f.txid : undefined;
  return {
    ok: true,
    status: typeof d.status === 'string' ? d.status : undefined,
    network: typeof d.network === 'string' ? d.network : undefined,
    faucet: { txid, destination: dest, amountSats: amt }
  };
}
