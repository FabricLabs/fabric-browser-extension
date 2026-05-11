'use strict';

import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';

function extractActiveHubAddress (state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const s = state as Record<string, unknown>;
  const settings = s.settings as Record<string, unknown> | undefined;
  const nodes = settings?.fabricNodes as Array<{ isActive?: boolean; hubAddress?: string }> | undefined;
  if (!Array.isArray(nodes)) return null;
  const a = nodes.find((n) => n && n.isActive && typeof n.hubAddress === 'string');
  const h = a?.hubAddress?.trim();
  return h ? h : null;
}

export type PassportBolt11PayResult = { ok: boolean; message: string };

const PAY_RPC_TIMEOUT_MS = 15_000;

async function fetchJsonWithTimeout (url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PAY_RPC_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Attempt to pay a BOLT11 via the user's active Fabric node JSON-RPC (`PayBolt11Invoice`).
 * Servers may omit this — callers should fall back to copy / Lightning URI.
 */
export async function attemptPayBolt11ViaActiveFabricNode (bolt11: string): Promise<PassportBolt11PayResult> {
  const b = String(bolt11 || '').trim();
  if (!b.startsWith('ln')) return { ok: false, message: 'Not a valid BOLT11 invoice.' };

  const bag = await new Promise<Record<string, unknown>>((resolve) => {
    chrome.storage.local.get(FABRIC_STATE_STORAGE_KEY, resolve);
  });
  const hub = extractActiveHubAddress(bag[FABRIC_STATE_STORAGE_KEY]);
  if (!hub) {
    return {
      ok: false,
      message: 'No active Fabric node in Passport settings. Use Copy invoice or Open in Lightning wallet.'
    };
  }

  const base = hub.replace(/\/+$/, '');
  try {
    const res = await fetchJsonWithTimeout(`${base}/services/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'PayBolt11Invoice',
        params: [{ bolt11: b, origin: '@fabric/passport-extension' }]
      })
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if ((json.error as Record<string, unknown> | undefined)?.message) {
      const msg = String((json.error as Record<string, unknown>).message || 'RPC error');
      return {
        ok: false,
        message: msg.includes('Method not found') || msg.includes('not found')
          ? `${msg} — your node may not expose PayBolt11Invoice yet. Copy the invoice instead.`
          : msg
      };
    }
    if (json.result !== undefined && json.result !== null) {
      return { ok: true, message: 'Payment request sent to your Fabric node.' };
    }
    return {
      ok: false,
      message: 'Unexpected response from Fabric node RPC. Copy the Lightning invoice manually.'
    };
  } catch (e) {
    const aborted =
      (e instanceof Error && e.name === 'AbortError') ||
      (typeof DOMException !== 'undefined' && e instanceof DOMException && e.name === 'AbortError');
    if (aborted) {
      return { ok: false, message: `Fabric node RPC timed out after ${PAY_RPC_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, message: String(e instanceof Error ? e.message : e) };
  }
}
