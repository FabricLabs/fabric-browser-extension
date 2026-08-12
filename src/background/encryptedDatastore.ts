/**
 * Background-only encrypted key/value store (AES-GCM).
 * Complements wallet crypto in the popup: use for mesh metadata, counters, non-wallet secrets.
 * Master key lives in extension storage; replace via setMasterKeyFromBytes after user unlock for stronger binding.
 */

import { swallowNonFatal } from '../utils/nonFatal';

const DS_PREFIX = 'fabric_ds_enc:';
const MASTER_KEY_STORAGE = 'fabric_bg_ds_master_key_b64';

function bytesToB64 (buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function b64ToBytes (b64: string): ArrayBuffer {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

async function getOrCreateAesKey (): Promise<CryptoKey> {
  const got = await chrome.storage.local.get(MASTER_KEY_STORAGE);
  let raw: ArrayBuffer;
  if (typeof got[MASTER_KEY_STORAGE] === 'string' && got[MASTER_KEY_STORAGE].length > 0) {
    raw = b64ToBytes(got[MASTER_KEY_STORAGE]);
  } else {
    raw = new ArrayBuffer(32);
    crypto.getRandomValues(new Uint8Array(raw));
    await chrome.storage.local.set({ [MASTER_KEY_STORAGE]: bytesToB64(raw) });
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function setDatastoreMasterKeyFromBytes (raw32: ArrayBuffer): Promise<void> {
  if (raw32.byteLength !== 32) throw new Error('Master key must be 32 bytes');
  await chrome.storage.local.set({ [MASTER_KEY_STORAGE]: bytesToB64(raw32) });
}

export async function fabricDsSet (key: string, value: unknown): Promise<void> {
  const aes = await getOrCreateAesKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, plain);
  const packed = new Uint8Array(iv.length + ct.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ct), iv.length);
  await chrome.storage.local.set({ [`${DS_PREFIX}${key}`]: bytesToB64(packed.buffer) });
}

export async function fabricDsGet<T = unknown> (key: string): Promise<T | null> {
  const got = await chrome.storage.local.get(`${DS_PREFIX}${key}`);
  const b64 = got[`${DS_PREFIX}${key}`];
  if (typeof b64 !== 'string' || !b64) return null;
  const packed = new Uint8Array(b64ToBytes(b64));
  if (packed.length < 13) return null;
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
  const aes = await getOrCreateAesKey();
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aes, ct);
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  } catch (err: unknown) {
    swallowNonFatal('fabric-ds-decrypt', err);
    return null;
  }
}

export async function fabricDsRemove (key: string): Promise<void> {
  await chrome.storage.local.remove(`${DS_PREFIX}${key}`);
}

/**
 * List decrypted values whose logical keys start with `prefix`.
 * @param prefix e.g. `notification:`
 * @param limit Max rows (newest-ish; storage order is not guaranteed — sorted by receivedAt when present)
 */
export async function fabricDsListPrefix<T = unknown> (
  prefix: string,
  limit = 40
): Promise<Array<{ key: string; value: T }>> {
  const all = await chrome.storage.local.get(null);
  const out: Array<{ key: string; value: T }> = [];
  const needle = `${DS_PREFIX}${prefix}`;
  for (const storageKey of Object.keys(all || {})) {
    if (!storageKey.startsWith(needle)) continue;
    const logical = storageKey.slice(DS_PREFIX.length);
    try {
      const value = await fabricDsGet<T>(logical);
      if (value != null) out.push({ key: logical, value });
    } catch (err: unknown) {
      swallowNonFatal('fabric-ds-list-prefix', err);
    }
  }
  out.sort((a, b) => {
    const ta = Number((a.value as { receivedAt?: number })?.receivedAt) || 0;
    const tb = Number((b.value as { receivedAt?: number })?.receivedAt) || 0;
    return tb - ta;
  });
  return out.slice(0, Math.max(1, Math.min(200, limit)));
}
