/**
 * Passport mirror of `@fabric/core/types/document` — a sealed blob tree with
 * one content key per blob (K_i), payment hash SHA256(K_i), and a Bitcoin-style
 * merkle root over ciphertext blob hashes. WebCrypto AES-256-GCM, bit-compatible
 * with core `functions/documentSealedExchange` (`aes-256-gcm-content-v1`:
 * 12-byte IV, 16-byte tag appended to the ciphertext).
 *
 * Records are hash-only: no names, URLs, or bytes. Human metadata belongs in a
 * separately sealed manifest blob (`encodeManifest`).
 */

import { sha256, merkleRootHexFromBlobHashes, PAGE_BLOB_CHUNK_BYTES } from '../services/pageIndex';

export const SEAL_SCHEME = 'aes-256-gcm-content-v1';
export const GCM_TAG_BYTES = 16;
export const MANIFEST_TYPE = 'DocumentManifest';
export const MANIFEST_VERSION = 1;

export interface SealedBlobLeaf {
  index: number;
  total: number;
  blobHashHex: string;
  /** SHA256(K_i) — the HTLC payment hash for this blob. */
  paymentHashHex: string | null;
  size: number;
  plaintextSize?: number;
  plaintextSha256?: string;
  iv?: string;
  scheme?: string;
}

export interface DocumentRecord {
  documentId: string | null;
  merkleRootHex: string;
  blobTotal: number;
  chunkBytes: number;
  sealed: boolean;
  size: number;
  publisher: string | null;
  blobs: SealedBlobLeaf[];
}

export interface HashOnlyInventoryItem {
  id: string;
  sha256: string;
  size: number;
  rateSats: number;
  sealed: boolean;
  perBlob: boolean;
  blobTotal: number;
  blobs: Array<{ index: number; blobHashHex: string; contentHashHex: string | null; size: number; rateSats: number }>;
}

function toHex (bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

function fromHex (hex: string): Uint8Array {
  const clean = String(hex || '').trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function b64Encode (bytes: Uint8Array): string {
  if (typeof btoa === 'function') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  return Buffer.from(bytes).toString('base64');
}

function b64Decode (text: string): Uint8Array {
  if (typeof atob === 'function') {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}

function cryptoApi (): Crypto {
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c && c.subtle) return c;
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return require('crypto').webcrypto as Crypto;
}

function randomBytes (n: number): Uint8Array {
  const out = new Uint8Array(n);
  cryptoApi().getRandomValues(out);
  return out;
}

function canonicalJson (value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

/** Fresh `Uint8Array<ArrayBuffer>` copy — WebCrypto `BufferSource` typing. */
function own (bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(bytes);
}

async function sealPlaintext (plain: Uint8Array): Promise<{ key: Uint8Array; iv: Uint8Array; ciphertext: Uint8Array }> {
  const key = own(randomBytes(32));
  const iv = own(randomBytes(12));
  const subtle = cryptoApi().subtle;
  const k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_BYTES * 8 }, k, own(plain)));
  return { key, iv, ciphertext: ct };
}

async function openCiphertext (ciphertext: Uint8Array, keyHex: string, ivBase64: string): Promise<Uint8Array> {
  const key = own(fromHex(keyHex));
  if (key.length !== 32) throw new Error('content key must be 32 bytes');
  const iv = own(b64Decode(ivBase64));
  if (iv.length !== 12) throw new Error('IV must be 12 bytes');
  const subtle = cryptoApi().subtle;
  const k = await subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['decrypt']);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: GCM_TAG_BYTES * 8 }, k, own(ciphertext)));
}

export class FabricDocument {
  record: DocumentRecord;
  private keys = new Map<number, string>();
  private ciphertexts = new Map<number, Uint8Array>();
  private plaintexts = new Map<number, Uint8Array>();

  private constructor (record: DocumentRecord) {
    this.record = record;
  }

  /** Seal `plaintext` into per-blob AES-GCM ciphertexts with one key per blob. */
  static async seal (plaintext: Uint8Array | string, opts: { chunkBytes?: number; documentId?: string; publisher?: string } = {}): Promise<FabricDocument> {
    const plain = typeof plaintext === 'string' ? new TextEncoder().encode(plaintext) : plaintext;
    const chunkBytes = Math.max(GCM_TAG_BYTES + 1, Math.floor(opts.chunkBytes || PAGE_BLOB_CHUNK_BYTES));
    const plainChunk = chunkBytes - GCM_TAG_BYTES;
    const total = Math.max(1, Math.ceil(plain.length / plainChunk));
    const blobs: SealedBlobLeaf[] = [];
    const doc = new FabricDocument({
      documentId: opts.documentId || null,
      merkleRootHex: '',
      blobTotal: total,
      chunkBytes,
      sealed: true,
      size: plain.length,
      publisher: opts.publisher || null,
      blobs
    });
    for (let i = 0; i < total; i++) {
      const slice = plain.subarray(i * plainChunk, Math.min(plain.length, (i + 1) * plainChunk));
      const sealed = await sealPlaintext(slice);
      blobs.push({
        index: i,
        total,
        blobHashHex: toHex(await sha256(sealed.ciphertext)),
        paymentHashHex: toHex(await sha256(sealed.key)),
        size: sealed.ciphertext.length,
        plaintextSize: slice.length,
        plaintextSha256: toHex(await sha256(slice)),
        iv: b64Encode(sealed.iv),
        scheme: SEAL_SCHEME
      });
      doc.keys.set(i, toHex(sealed.key));
      doc.ciphertexts.set(i, sealed.ciphertext);
      doc.plaintexts.set(i, new Uint8Array(slice));
    }
    doc.record.merkleRootHex = await merkleRootHexFromBlobHashes(blobs.map((b) => b.blobHashHex));
    return doc;
  }

  /** Rehydrate from a hash-only record (buyer side). */
  static fromRecord (record: DocumentRecord): FabricDocument {
    const blobs = (record.blobs || []).map((b, i) => ({
      index: b.index != null ? Number(b.index) : i,
      total: b.total != null ? Number(b.total) : (record.blobs || []).length,
      blobHashHex: String(b.blobHashHex || '').toLowerCase(),
      paymentHashHex: b.paymentHashHex ? String(b.paymentHashHex).toLowerCase() : null,
      size: Number(b.size) || 0,
      plaintextSize: b.plaintextSize,
      plaintextSha256: b.plaintextSha256,
      iv: b.iv,
      scheme: b.scheme
    }));
    return new FabricDocument({
      documentId: record.documentId || null,
      merkleRootHex: String(record.merkleRootHex || '').toLowerCase(),
      blobTotal: Number(record.blobTotal) || blobs.length,
      chunkBytes: Number(record.chunkBytes) || PAGE_BLOB_CHUNK_BYTES,
      sealed: record.sealed === true,
      size: Number(record.size) || 0,
      publisher: record.publisher || null,
      blobs
    });
  }

  /** Canonical sealed-manifest blob bytes (human metadata lives here, never on the wire index). */
  static encodeManifest (meta: Record<string, unknown>): Uint8Array {
    return new TextEncoder().encode(canonicalJson(Object.assign({}, meta, { type: MANIFEST_TYPE, version: MANIFEST_VERSION })));
  }

  static decodeManifest (bytes: Uint8Array): Record<string, unknown> | null {
    try {
      const obj = JSON.parse(new TextDecoder().decode(bytes));
      return obj && obj.type === MANIFEST_TYPE ? obj : null;
    } catch (_) {
      return null;
    }
  }

  get hash (): string { return this.record.merkleRootHex; }
  get merkleRootHex (): string { return this.record.merkleRootHex; }
  get blobTotal (): number { return this.record.blobTotal; }
  get sealed (): boolean { return this.record.sealed; }
  get complete (): boolean {
    for (const b of this.record.blobs) if (!this.plaintexts.has(b.index)) return false;
    return this.record.blobs.length > 0;
  }

  blob (index: number): SealedBlobLeaf | null {
    return this.record.blobs.find((b) => b.index === index) || null;
  }

  paymentHashFor (index: number): string | null {
    const leaf = this.blob(index);
    if (!leaf) return null;
    return this.record.sealed ? leaf.paymentHashHex : leaf.blobHashHex;
  }

  keyFor (index: number): string | null { return this.keys.get(index) || null; }
  bytesFor (index: number): Uint8Array | null { return this.ciphertexts.get(index) || null; }

  /** True when `bytes` hash to this blob's leaf. */
  async verify (index: number, bytes: Uint8Array): Promise<boolean> {
    const leaf = this.blob(index);
    if (!leaf) return false;
    return toHex(await sha256(bytes)) === leaf.blobHashHex;
  }

  async acceptBytes (index: number, bytes: Uint8Array): Promise<boolean> {
    if (!(await this.verify(index, bytes))) return false;
    this.ciphertexts.set(index, bytes);
    if (!this.record.sealed) this.plaintexts.set(index, bytes);
    return true;
  }

  /** Open one blob with K_i (hex); checks SHA256(K_i) against the leaf payment hash. */
  async openBlob (index: number, keyHex: string, ciphertext?: Uint8Array): Promise<Uint8Array> {
    const leaf = this.blob(index);
    if (!leaf) throw new Error('unknown blob index');
    const ct = ciphertext || this.ciphertexts.get(index);
    if (!ct) throw new Error('ciphertext not held');
    if (leaf.paymentHashHex && toHex(await sha256(fromHex(keyHex))) !== leaf.paymentHashHex) {
      throw new Error('key does not match payment hash');
    }
    if (!(await this.verify(index, ct))) throw new Error('ciphertext does not match leaf');
    const plain = await openCiphertext(ct, keyHex, String(leaf.iv || ''));
    if (leaf.plaintextSha256 && toHex(await sha256(plain)) !== leaf.plaintextSha256) {
      throw new Error('plaintext does not match leaf');
    }
    this.keys.set(index, keyHex);
    this.ciphertexts.set(index, ct);
    this.plaintexts.set(index, plain);
    return plain;
  }

  content (): Uint8Array | null {
    if (!this.complete) return null;
    const parts = this.record.blobs.slice().sort((a, b) => a.index - b.index).map((b) => this.plaintexts.get(b.index) as Uint8Array);
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) { out.set(p, at); at += p.length; }
    return out;
  }

  /** Hash-only inventory item (same shape as core `Document#inventoryItem`). */
  inventoryItem (opts: { rateSats?: number; documentId?: string } = {}): HashOnlyInventoryItem {
    const rate = Math.max(0, Math.floor(Number(opts.rateSats) || 0));
    const id = opts.documentId || this.record.documentId || this.record.merkleRootHex;
    return {
      id,
      sha256: this.record.merkleRootHex,
      size: this.record.blobs.reduce((n, b) => n + (b.size || 0), 0),
      rateSats: rate * this.record.blobs.length,
      sealed: this.record.sealed,
      perBlob: this.record.sealed,
      blobTotal: this.record.blobTotal,
      blobs: this.record.blobs.map((b) => ({
        index: b.index,
        blobHashHex: b.blobHashHex,
        contentHashHex: this.record.sealed ? b.paymentHashHex : b.blobHashHex,
        size: b.size,
        rateSats: rate
      }))
    };
  }
}

export default FabricDocument;
