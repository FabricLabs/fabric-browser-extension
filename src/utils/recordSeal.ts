'use strict';

/**
 * Records Passport trusts (linked signers, trusted Hubs and origins) carry an
 * HMAC keyed from the unlocked master, so anything else that can write
 * extension storage cannot add or change one. Records are written only while
 * the vault is unlocked; a record whose MAC does not check is dropped.
 */

const MAC_KEY_LABEL = 'fabric-passport:record-mac:1';

export type SealedRecord<T> = { v: 1; name: string; data: T; mac: string };

function subtle (): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
}

function hex (buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** HMAC-SHA256 key for record MACs, derived from the master xprv (never stored). */
export async function recordMacKey (master: string): Promise<CryptoKey> {
  if (!master) throw new Error('unlock Passport first');
  const raw = await subtle().digest('SHA-256', new TextEncoder().encode(`${MAC_KEY_LABEL}\n${master}`));
  return subtle().importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function macInput (name: string, data: unknown): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${name}\n${JSON.stringify(data)}`);
}

/** Wrap `data` with a MAC over its name and JSON. */
export async function sealRecord<T> (key: CryptoKey, name: string, data: T): Promise<SealedRecord<T>> {
  const mac = await subtle().sign('HMAC', key, macInput(name, data));
  return { v: 1, name, data, mac: hex(mac) };
}

/** The record's data when its MAC checks under `key` for `name`; null otherwise. */
export async function openRecord<T> (key: CryptoKey, name: string, record: unknown): Promise<T | null> {
  const r = record as SealedRecord<T> | null;
  if (!r || typeof r !== 'object' || r.v !== 1 || r.name !== name || typeof r.mac !== 'string' || !/^[0-9a-f]{64}$/.test(r.mac)) return null;
  const mac = new Uint8Array(new ArrayBuffer(32));
  for (let i = 0; i < 32; i++) mac[i] = parseInt(r.mac.slice(i * 2, i * 2 + 2), 16);
  const ok = await subtle().verify('HMAC', key, mac, macInput(name, r.data));
  return ok ? r.data : null;
}
