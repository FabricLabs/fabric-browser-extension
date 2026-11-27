/**
 * Background-only encrypted key/value store (AES-GCM).
 * Complements wallet crypto in the popup: use for mesh metadata, counters, non-wallet secrets.
 * The AES key is derived from the unlocked master and kept in `chrome.storage.session`.
 * While Passport is locked the store does not open.
 */

import { swallowNonFatal } from '../utils/nonFatal';

const DS_PREFIX = 'fabric_ds_enc:';
/** Legacy plaintext key. Removed after the first unlock rewraps the rows. */
const LEGACY_KEY_STORAGE = 'fabric_bg_ds_master_key_b64';
/** Session-only derived key. Content scripts cannot read `chrome.storage.session`. */
const SESSION_KEY_STORAGE = 'fabric.passport.datastoreKey';
const DATASTORE_KEY_LABEL = 'fabric-bg-datastore:v1\n';

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

async function deriveKeyBytes (master: string): Promise<ArrayBuffer> {
  const bytes = new TextEncoder().encode(DATASTORE_KEY_LABEL + master);
  return crypto.subtle.digest('SHA-256', bytes);
}

async function importAes (raw: ArrayBuffer, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, usages);
}

async function sessionKeyBytes (): Promise<ArrayBuffer | null> {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return null;
  const got = await chrome.storage.session.get(SESSION_KEY_STORAGE);
  const b64 = got && got[SESSION_KEY_STORAGE];
  if (typeof b64 !== 'string' || !b64) return null;
  const raw = b64ToBytes(b64);
  return raw.byteLength === 32 ? raw : null;
}

async function aesKey (): Promise<CryptoKey | null> {
  const raw = await sessionKeyBytes();
  if (!raw) return null;
  return importAes(raw, ['encrypt', 'decrypt']);
}

async function rewrapAll (oldRaw: ArrayBuffer, newRaw: ArrayBuffer): Promise<void> {
  const oldKey = await importAes(oldRaw, ['decrypt']);
  const newKey = await importAes(newRaw, ['encrypt']);
  const all = await chrome.storage.local.get(null);
  for (const storageKey of Object.keys(all || {})) {
    if (!storageKey.startsWith(DS_PREFIX)) continue;
    const b64 = all[storageKey];
    if (typeof b64 !== 'string' || !b64) continue;
    const packed = new Uint8Array(b64ToBytes(b64));
    if (packed.length < 13) continue;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: packed.subarray(0, 12) }, oldKey, packed.subarray(12));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, newKey, plain);
    const next = new Uint8Array(iv.length + ct.byteLength);
    next.set(iv, 0);
    next.set(new Uint8Array(ct), iv.length);
    await chrome.storage.local.set({ [storageKey]: bytesToB64(next.buffer) });
  }
}

/**
 * Open the store for this unlock. An older plaintext key is used once to
 * re-encrypt every row, then deleted.
 */
export async function bindDatastoreToMaster (master: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
  const raw = await deriveKeyBytes(String(master || ''));
  if (chrome.storage.local) {
    const got = await chrome.storage.local.get(LEGACY_KEY_STORAGE);
    const oldB64 = got && got[LEGACY_KEY_STORAGE];
    if (typeof oldB64 === 'string' && oldB64) {
      const oldRaw = b64ToBytes(oldB64);
      if (oldRaw.byteLength === 32) await rewrapAll(oldRaw, raw);
      await chrome.storage.local.remove(LEGACY_KEY_STORAGE);
    }
  }
  await chrome.storage.session.set({ [SESSION_KEY_STORAGE]: bytesToB64(raw) });
}

/** Drop the session key. Stored rows stay, unreadable until the next unlock. */
export async function unbindDatastore (): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
  await chrome.storage.session.remove(SESSION_KEY_STORAGE);
}

export async function setDatastoreMasterKeyFromBytes (raw32: ArrayBuffer): Promise<void> {
  if (raw32.byteLength !== 32) throw new Error('Master key must be 32 bytes');
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) {
    throw new Error('session storage unavailable');
  }
  await chrome.storage.session.set({ [SESSION_KEY_STORAGE]: bytesToB64(raw32) });
}

export async function fabricDsSet (key: string, value: unknown): Promise<void> {
  const aes = await aesKey();
  if (!aes) throw new Error('Passport is locked');
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
  const aes = await aesKey();
  if (!aes) return null;
  const packed = new Uint8Array(b64ToBytes(b64));
  if (packed.length < 13) return null;
  const iv = packed.subarray(0, 12);
  const ct = packed.subarray(12);
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
