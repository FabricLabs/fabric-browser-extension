/**
 * Legacy web page index — Passport keeps an on-demand local archive of pages
 * the user chooses to capture, split into AMP-sized blobs (same 24 KiB chunking
 * and Tree merkle root as core `Document`), plus a
 * chunk index of which peers advertise those blobs.
 *
 * - Blob bytes + page rows live in IndexedDB (`unlimitedStorage`).
 * - Peer rows come from `P2P_INVENTORY_RESPONSE` frames seen on the Hub WebRTC
 *   mesh (`ingestInventoryResponse`) and from HTTP 402 replies.
 * - Wire identity is hashes only: blob SHA-256 leaves and the Tree root. The
 *   URL / title stay in the local `pages` store (decision 3).
 *
 * No Fabric opcode or header changes: this is a consumer of existing
 * inventory bodies.
 */

import { DocumentOfferBook, type OfferRow, type ProviderTelemetryRecord } from '../types/offerBook';

/** Same raw size core uses under `MAX_MESSAGE_SIZE` (24 KiB). */
export const PAGE_BLOB_CHUNK_BYTES = 24 * 1024;
export const PAGE_INDEX_DB = 'fabric-page-index';
export const PAGE_INDEX_DB_VERSION = 1;
export const TELEMETRY_KEY = 'provider-telemetry';

export interface PageBlobLeaf {
  index: number;
  total: number;
  blobHashHex: string;
  size: number;
}

export interface PageBlobTree {
  /** Tree root over blob leaves (hex). */
  merkleRootHex: string;
  /** SHA-256 of the full content (document id on the wire). */
  contentSha256: string;
  size: number;
  chunkBytes: number;
  blobTotal: number;
  blobs: PageBlobLeaf[];
}

export interface PageRecord extends PageBlobTree {
  url: string;
  title: string | null;
  capturedAt: number;
}

export interface BlobLocation {
  blobHashHex: string;
  local: boolean;
  providers: OfferRow[];
}

function bytesToHex (bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

function hexToBytes (hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function base64ToBytes (s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch (_) {
    return null;
  }
}

function subtle (): SubtleCrypto {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto unavailable');
  return c.subtle;
}

export async function sha256 (bytes: Uint8Array): Promise<Uint8Array> {
  const copy = Uint8Array.from(bytes);
  return new Uint8Array(await subtle().digest('SHA-256', copy));
}

const DOCUMENT_TREE_LEAF = 0x00;
const DOCUMENT_TREE_NODE = 0x01;
const DOCUMENT_TREE_ROOT = 0x02;
const DOCUMENT_TREE_IV_BYTES = 12;

export interface DocumentLeafInput {
  blobHashHex: string;
  paymentHashHex?: string | null;
  iv?: string | null;
}

function hex32 (value: unknown, name: string): Uint8Array {
  const s = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) throw new Error(`${name} must be 64 hex chars`);
  return hexToBytes(s);
}

function concat (parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Leaf for one blob: `H(0x00 || blobHash || paymentHash || iv)`, as core
 * `Document.leafHex`. Unsealed blobs use 32 / 12 zero bytes for the payment
 * hash / IV.
 */
export async function documentLeafHex (blob: DocumentLeafInput): Promise<string> {
  const blobHash = hex32(blob.blobHashHex, 'blobHashHex');
  const pay = blob.paymentHashHex ? hex32(blob.paymentHashHex, 'paymentHashHex') : new Uint8Array(32);
  let iv: Uint8Array = new Uint8Array(DOCUMENT_TREE_IV_BYTES);
  if (blob.iv != null && blob.iv !== '') {
    const bytes = base64ToBytes(String(blob.iv).trim());
    if (!bytes || bytes.length !== DOCUMENT_TREE_IV_BYTES) throw new Error('iv must be 12 bytes');
    iv = bytes;
  }
  return bytesToHex(await sha256(concat([Uint8Array.of(DOCUMENT_TREE_LEAF), blobHash, pay, iv])));
}

/**
 * Document root for blob leaves in index order — identical to core
 * `Document.rootHex`: odd last nodes are promoted, and the root commits
 * the blob count.
 */
export async function documentMerkleRootHex (blobs: DocumentLeafInput[]): Promise<string> {
  if (!blobs.length) throw new Error('document must have at least one blob');
  let nodes: Uint8Array[] = await Promise.all(blobs.map(async (b) => hexToBytes(await documentLeafHex(b))));
  while (nodes.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < nodes.length; i += 2) {
      next.push(i + 1 < nodes.length
        ? await sha256(concat([Uint8Array.of(DOCUMENT_TREE_NODE), nodes[i], nodes[i + 1]]))
        : nodes[i]);
    }
    nodes = next;
  }
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, blobs.length >>> 0, false);
  return bytesToHex(await sha256(concat([Uint8Array.of(DOCUMENT_TREE_ROOT), count, nodes[0]])));
}

/** Unsealed document root over blob hashes (core `Document.rootHexFromBlobHashes`). */
export async function merkleRootHexFromBlobHashes (blobHashHexes: string[]): Promise<string> {
  return documentMerkleRootHex(blobHashHexes.map((blobHashHex) => ({ blobHashHex })));
}

/** Split bytes into AMP-sized blobs and commit them (core `Document.split` shape). */
export async function buildPageBlobTree (
  content: Uint8Array,
  chunkBytes: number = PAGE_BLOB_CHUNK_BYTES
): Promise<{ tree: PageBlobTree; chunks: Uint8Array[] }> {
  const size = content.byteLength;
  const chunks: Uint8Array[] = [];
  const total = Math.max(1, Math.ceil(size / chunkBytes));
  for (let i = 0; i < total; i++) {
    chunks.push(content.subarray(i * chunkBytes, Math.min(size, (i + 1) * chunkBytes)));
  }
  const blobs: PageBlobLeaf[] = [];
  for (let i = 0; i < chunks.length; i++) {
    blobs.push({ index: i, total, blobHashHex: bytesToHex(await sha256(chunks[i])), size: chunks[i].byteLength });
  }
  const tree: PageBlobTree = {
    merkleRootHex: await merkleRootHexFromBlobHashes(blobs.map((b) => b.blobHashHex)),
    contentSha256: bytesToHex(await sha256(content)),
    size,
    chunkBytes,
    blobTotal: total,
    blobs
  };
  return { tree, chunks };
}

/** Minimal async store so the index runs in the service worker, offscreen page, or tests. */
export interface PageIndexStore {
  getPage (url: string): Promise<PageRecord | null>;
  putPage (page: PageRecord): Promise<void>;
  listPages (): Promise<PageRecord[]>;
  getBlob (blobHashHex: string): Promise<Uint8Array | null>;
  putBlob (blobHashHex: string, bytes: Uint8Array): Promise<void>;
  hasBlob (blobHashHex: string): Promise<boolean>;
  getMeta<T> (key: string): Promise<T | null>;
  putMeta (key: string, value: unknown): Promise<void>;
}

export class MemoryPageIndexStore implements PageIndexStore {
  private pages = new Map<string, PageRecord>();
  private blobs = new Map<string, Uint8Array>();
  private meta = new Map<string, unknown>();
  async getPage (url: string): Promise<PageRecord | null> { return this.pages.get(url) || null; }
  async putPage (page: PageRecord): Promise<void> { this.pages.set(page.url, page); }
  async listPages (): Promise<PageRecord[]> { return Array.from(this.pages.values()); }
  async getBlob (h: string): Promise<Uint8Array | null> { return this.blobs.get(h) || null; }
  async putBlob (h: string, b: Uint8Array): Promise<void> { this.blobs.set(h, Uint8Array.from(b)); }
  async hasBlob (h: string): Promise<boolean> { return this.blobs.has(h); }
  async getMeta<T> (k: string): Promise<T | null> { return (this.meta.has(k) ? this.meta.get(k) as T : null); }
  async putMeta (k: string, v: unknown): Promise<void> { this.meta.set(k, v); }
}

function idbRequest<T> (req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
  });
}

/** IndexedDB-backed store (`pages`, `blobs`, `meta`). */
export class IndexedDBPageIndexStore implements PageIndexStore {
  private dbPromise: Promise<IDBDatabase> | null = null;

  constructor (private readonly name: string = PAGE_INDEX_DB) {}

  private db (): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
      if (!idb) { reject(new Error('IndexedDB unavailable')); return; }
      const req = idb.open(this.name, PAGE_INDEX_DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('pages')) db.createObjectStore('pages', { keyPath: 'url' });
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
    });
    return this.dbPromise;
  }

  private async tx (store: string, mode: IDBTransactionMode): Promise<IDBObjectStore> {
    const db = await this.db();
    return db.transaction(store, mode).objectStore(store);
  }

  async getPage (url: string): Promise<PageRecord | null> {
    return (await idbRequest((await this.tx('pages', 'readonly')).get(url))) as PageRecord || null;
  }

  async putPage (page: PageRecord): Promise<void> {
    await idbRequest((await this.tx('pages', 'readwrite')).put(page));
  }

  async listPages (): Promise<PageRecord[]> {
    return (await idbRequest((await this.tx('pages', 'readonly')).getAll())) as PageRecord[];
  }

  async getBlob (h: string): Promise<Uint8Array | null> {
    const got = await idbRequest((await this.tx('blobs', 'readonly')).get(h));
    if (!got) return null;
    return got instanceof Uint8Array ? got : new Uint8Array(got as ArrayBuffer);
  }

  async putBlob (h: string, b: Uint8Array): Promise<void> {
    await idbRequest((await this.tx('blobs', 'readwrite')).put(Uint8Array.from(b), h));
  }

  async hasBlob (h: string): Promise<boolean> {
    return (await idbRequest((await this.tx('blobs', 'readonly')).count(h))) > 0;
  }

  async getMeta<T> (k: string): Promise<T | null> {
    const got = await idbRequest((await this.tx('meta', 'readonly')).get(k));
    return got == null ? null : got as T;
  }

  async putMeta (k: string, v: unknown): Promise<void> {
    await idbRequest((await this.tx('meta', 'readwrite')).put(v, k));
  }
}

export interface PageIndexInventoryEvent {
  origin?: string;
  payload: Record<string, unknown>;
  signerPubkeyHex?: string | null;
  latencyMs?: number;
  hops?: number;
}

/**
 * Local page archive + chunk locator.
 */
export class PageIndex {
  readonly book: DocumentOfferBook;
  private restored = false;

  constructor (private readonly store: PageIndexStore = new MemoryPageIndexStore(), book?: DocumentOfferBook) {
    this.book = book || new DocumentOfferBook();
  }

  private async restore (): Promise<void> {
    if (this.restored) return;
    this.restored = true;
    const rec = await this.store.getMeta<ProviderTelemetryRecord>(TELEMETRY_KEY);
    if (rec) this.book.importTelemetry(rec);
  }

  async persistTelemetry (): Promise<ProviderTelemetryRecord> {
    const rec = this.book.exportTelemetry();
    await this.store.putMeta(TELEMETRY_KEY, rec);
    return rec;
  }

  /**
   * Capture a page the user asked to keep: split, hash, store blobs locally.
   * Nothing is sent to peers here; advertising is a later, explicit step.
   */
  async capture (page: { url: string; title?: string | null; content: Uint8Array | string }): Promise<PageRecord> {
    await this.restore();
    const bytes = typeof page.content === 'string' ? new TextEncoder().encode(page.content) : page.content;
    const { tree, chunks } = await buildPageBlobTree(bytes);
    for (let i = 0; i < chunks.length; i++) {
      await this.store.putBlob(tree.blobs[i].blobHashHex, chunks[i]);
    }
    const record: PageRecord = { ...tree, url: page.url, title: page.title || null, capturedAt: Date.now() };
    await this.store.putPage(record);
    return record;
  }

  async getPage (url: string): Promise<PageRecord | null> {
    return this.store.getPage(url);
  }

  async listPages (): Promise<PageRecord[]> {
    return this.store.listPages();
  }

  /** Reassemble a captured page from local blobs (null when any blob is missing). */
  async readPage (url: string): Promise<Uint8Array | null> {
    const page = await this.store.getPage(url);
    if (!page) return null;
    const out = new Uint8Array(page.size);
    let offset = 0;
    for (const leaf of page.blobs) {
      const bytes = await this.store.getBlob(leaf.blobHashHex);
      if (!bytes) return null;
      out.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return out;
  }

  /**
   * Inventory items for locally held pages — the `blobs` leaves a peer needs to
   * dial us for chunks. Hashes only; no URL or title.
   */
  async inventoryItems (opts: { rateSats?: number } = {}): Promise<Array<Record<string, unknown>>> {
    const rate = Math.max(0, Math.floor(Number(opts.rateSats) || 0));
    return (await this.store.listPages()).map((p) => ({
      id: p.contentSha256,
      sha256: p.contentSha256,
      size: p.size,
      rateSats: rate,
      merkleRootHex: p.merkleRootHex,
      blobTotal: p.blobTotal,
      chunkBytes: p.chunkBytes,
      blobs: p.blobs.map((b) => ({ index: b.index, total: b.total, blobHashHex: b.blobHashHex, size: b.size, rateSats: rate }))
    }));
  }

  /** Fold a peer `P2P_INVENTORY_RESPONSE` body into the chunk locator. */
  async ingestInventoryResponse (ev: PageIndexInventoryEvent): Promise<OfferRow[]> {
    await this.restore();
    const payload = ev.payload || {};
    const items = (payload.items || payload.documents || payload.inventory) as unknown[];
    if (!Array.isArray(items) || !items.length) return [];
    const rows = this.book.ingestInventoryResponse({
      origin: ev.origin,
      items,
      sellerId: ev.signerPubkeyHex || ev.origin || null,
      signerPubkeyHex: ev.signerPubkeyHex || null,
      latencyMs: ev.latencyMs,
      hops: ev.hops
    });
    if (rows.length) await this.persistTelemetry();
    return rows;
  }

  /** Where can a chunk be found: here, and/or which ranked peers advertise it. */
  async locate (blobHashHex: string): Promise<BlobLocation> {
    await this.restore();
    const h = String(blobHashHex || '').toLowerCase();
    return {
      blobHashHex: h,
      local: await this.store.hasBlob(h),
      providers: this.book.providersForBlob(h)
    };
  }

  /** Per-blob locations for a whole page (by URL or Tree root). */
  async locatePage (ref: { url?: string; merkleRootHex?: string }): Promise<BlobLocation[]> {
    await this.restore();
    let leaves: string[] = [];
    if (ref.url) {
      const page = await this.store.getPage(ref.url);
      if (page) leaves = page.blobs.map((b) => b.blobHashHex);
    }
    if (!leaves.length && ref.merkleRootHex) {
      leaves = Array.from(this.book.indexByBlobHash({ merkleRootHex: ref.merkleRootHex }).keys());
    }
    const out: BlobLocation[] = [];
    for (const h of leaves) out.push(await this.locate(h));
    return out;
  }
}

let shared: PageIndex | null = null;

/** Process-wide index backed by IndexedDB (service worker / offscreen). */
export function getPageIndex (): PageIndex {
  if (!shared) shared = new PageIndex(new IndexedDBPageIndexStore());
  return shared;
}
