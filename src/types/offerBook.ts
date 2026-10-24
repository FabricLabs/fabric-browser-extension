/**
 * Passport port of `@fabric/core/types/offerBook` (`DocumentOfferBook`).
 *
 * Ranked chunk index (blob hash / merkle root → providers) plus **local**
 * provider telemetry. Record shapes and formulas match core so a
 * `ProviderTelemetry` export from this book imports into a Hub or GoonCitizen
 * node and vice versa. Reputation never leaves this device (plan decision 4).
 *
 * Only hashes, public keys, and signatures identify offers (decision 3): no
 * names or MIME types are indexed here.
 */

export const TELEMETRY_TYPE = 'ProviderTelemetry' as const;
export const TELEMETRY_VERSION = 1 as const;
export const HOP_PENALTY_MS = 50;
export const SCORE_MAX = 1000;
export const SCORE_UNKNOWN = 0;

export interface OfferRow {
  documentId: string;
  sellerId: string;
  sellerAddress: string;
  sellerPubkey: string | null;
  ampSignerPubkey: string | null;
  merkleRootHex: string | null;
  blobIndex: number | null;
  blobTotal: number | null;
  blobHashHex: string | null;
  contentHashHex: string | null;
  rateSats: number;
  sealed: boolean;
  size: number | null;
  peerScore: number;
  latencyMs: number;
  hops: number;
  observedAt: number;
}

export interface ProviderStats {
  sellerId: string;
  inventoryLatencyMs: number;
  deliveryLatencyMs: number;
  inventories: number;
  deliveries: number;
  failures: number;
  refunds: number;
  penalties: number;
  bytesDelivered: number;
  hops: number;
  updatedAt: number;
  lastPenaltyKind?: string;
}

export interface ProviderTelemetryRecord {
  type: typeof TELEMETRY_TYPE;
  version: typeof TELEMETRY_VERSION;
  providers: ProviderStats[];
  hash?: string;
}

export interface OfferBookSettings {
  alpha?: number;
  hopPenaltyMs?: number;
}

export interface IngestOptions {
  origin?: string;
  items: unknown[];
  sellerId?: string | null;
  sellerPubkey?: string | null;
  signerPubkeyHex?: string | null;
  latencyMs?: number;
  hops?: number;
}

const HEX64 = /^[0-9a-f]{64}$/;

function hex64 (value: unknown): string | null {
  const s = String(value == null ? '' : value).trim().toLowerCase();
  return HEX64.test(s) ? s : null;
}

function asRecord (value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
}

function ewma (prev: number, sample: number, alpha: number): number {
  if (!prev) return sample;
  return alpha * sample + (1 - alpha) * prev;
}

/** Mirror of core `contentHashHexFromObject`: payment-hash fields, never `blobHashHex`. */
export function contentHashHexFromObject (obj: Record<string, unknown> | null): string | null {
  if (!obj) return null;
  return hex64(obj.contentHashHex || obj.contentHash || obj.paymentHashHex || obj.purchaseContentHashHex);
}

/** Same key format as core `offerKey`. */
export function offerKey (row: { documentId: string; blobIndex: number | null; sellerId?: string; sellerAddress?: string }): string {
  const blob = row.blobIndex != null ? String(row.blobIndex) : 'all';
  return `${row.documentId}|${blob}|${row.sellerId || row.sellerAddress || ''}`;
}

/** Effective latency: measured RTT plus a per-hop relay penalty. */
export function effectiveLatencyMs (row: { latencyMs: number; hops: number }, hopPenaltyMs: number = HOP_PENALTY_MS): number {
  return (Number(row.latencyMs) || 0) + (Number(row.hops) || 0) * hopPenaltyMs;
}

function rankProviders (a: OfferRow, b: OfferRow): number {
  return (b.peerScore - a.peerScore)
    || (effectiveLatencyMs(a) - effectiveLatencyMs(b))
    || (a.rateSats - b.rateSats);
}

export class DocumentOfferBook {
  readonly alpha: number;
  readonly hopPenaltyMs: number;
  private readonly offers = new Map<string, OfferRow>();
  private readonly providers = new Map<string, ProviderStats>();

  constructor (settings: OfferBookSettings = {}) {
    this.alpha = Number.isFinite(Number(settings.alpha)) ? Number(settings.alpha) : 0.3;
    this.hopPenaltyMs = Number.isFinite(Number(settings.hopPenaltyMs)) ? Number(settings.hopPenaltyMs) : HOP_PENALTY_MS;
  }

  private stats (sellerId: string): ProviderStats | null {
    const id = String(sellerId || '').trim();
    if (!id) return null;
    let s = this.providers.get(id);
    if (!s) {
      s = {
        sellerId: id,
        inventoryLatencyMs: 0,
        deliveryLatencyMs: 0,
        inventories: 0,
        deliveries: 0,
        failures: 0,
        refunds: 0,
        penalties: 0,
        bytesDelivered: 0,
        hops: 0,
        updatedAt: 0
      };
      this.providers.set(id, s);
    }
    return s;
  }

  recordInventoryLatency (sellerId: string, latencyMs: number, opts: { hops?: number } = {}): ProviderStats | null {
    const s = this.stats(sellerId);
    if (!s) return null;
    const ms = Number(latencyMs);
    if (Number.isFinite(ms) && ms >= 0) {
      s.inventoryLatencyMs = ewma(s.inventoryLatencyMs, ms, this.alpha);
      s.inventories++;
    }
    if (opts.hops != null && Number.isFinite(Number(opts.hops))) {
      s.hops = Math.max(0, Math.round(Number(opts.hops)));
    }
    s.updatedAt = Date.now();
    return s;
  }

  recordDelivery (sellerId: string, outcome: { ok?: boolean; latencyMs?: number; bytes?: number } = {}): ProviderStats | null {
    const s = this.stats(sellerId);
    if (!s) return null;
    if (outcome.ok === true) {
      s.deliveries++;
      const b = Number(outcome.bytes);
      if (Number.isFinite(b) && b > 0) s.bytesDelivered += b;
      const ms = Number(outcome.latencyMs);
      if (Number.isFinite(ms) && ms >= 0) s.deliveryLatencyMs = ewma(s.deliveryLatencyMs, ms, this.alpha);
    } else {
      s.failures++;
    }
    s.updatedAt = Date.now();
    return s;
  }

  recordRefund (sellerId: string): ProviderStats | null {
    const s = this.stats(sellerId);
    if (!s) return null;
    s.refunds++;
    s.updatedAt = Date.now();
    return s;
  }

  recordPenalty (sellerId: string, info: { kind?: string } = {}): ProviderStats | null {
    const s = this.stats(sellerId);
    if (!s) return null;
    s.penalties++;
    if (info.kind) s.lastPenaltyKind = String(info.kind);
    s.updatedAt = Date.now();
    return s;
  }

  /** 0..1000; 500 for inventory-only peers; 0 unknown (same formula as core). */
  scoreFor (sellerId: string): number {
    const s = this.providers.get(String(sellerId || '').trim());
    if (!s) return SCORE_UNKNOWN;
    const attempts = s.deliveries + s.failures + s.refunds + (s.penalties * 10);
    if (attempts <= 0) return s.inventories > 0 ? Math.round(SCORE_MAX / 2) : SCORE_UNKNOWN;
    const ratio = s.deliveries / attempts;
    return Math.max(0, Math.min(SCORE_MAX, Math.round(ratio * SCORE_MAX)));
  }

  latencyFor (sellerId: string): number {
    const s = this.providers.get(String(sellerId || '').trim());
    if (!s) return 0;
    const base = s.inventoryLatencyMs || s.deliveryLatencyMs || 0;
    return base + (s.hops * this.hopPenaltyMs);
  }

  providerStats (sellerId: string): ProviderStats | null {
    const s = this.providers.get(String(sellerId || '').trim());
    return s ? { ...s } : null;
  }

  listProviders (): Array<ProviderStats & { score: number; latencyMs: number }> {
    return Array.from(this.providers.values())
      .map((s) => ({ ...s, score: this.scoreFor(s.sellerId), latencyMs: this.latencyFor(s.sellerId) }))
      .sort((a, b) => (b.score - a.score) || (a.latencyMs - b.latencyMs));
  }

  /** Signable local record; `hash` is SHA-256 of the canonical body (filled by the caller when subtle crypto is async). */
  exportTelemetry (): ProviderTelemetryRecord {
    const providers = Array.from(this.providers.values())
      .map((s) => ({ ...s }))
      .sort((a, b) => a.sellerId.localeCompare(b.sellerId));
    return { type: TELEMETRY_TYPE, version: TELEMETRY_VERSION, providers };
  }

  /** Merge an earlier export (same node): counters add; latencies take the newer sample. */
  importTelemetry (record: unknown): number {
    const rec = asRecord(record);
    if (!rec || rec.type !== TELEMETRY_TYPE || !Array.isArray(rec.providers)) return 0;
    let n = 0;
    for (const p0 of rec.providers) {
      const p = asRecord(p0);
      if (!p || !p.sellerId) continue;
      const s = this.stats(String(p.sellerId));
      if (!s) continue;
      for (const k of ['inventories', 'deliveries', 'failures', 'refunds', 'penalties', 'bytesDelivered'] as const) {
        s[k] = (Number(s[k]) || 0) + (Number(p[k]) || 0);
      }
      if ((Number(p.updatedAt) || 0) >= (Number(s.updatedAt) || 0)) {
        if (Number.isFinite(Number(p.inventoryLatencyMs))) s.inventoryLatencyMs = Number(p.inventoryLatencyMs);
        if (Number.isFinite(Number(p.deliveryLatencyMs))) s.deliveryLatencyMs = Number(p.deliveryLatencyMs);
        if (Number.isFinite(Number(p.hops))) s.hops = Number(p.hops);
        s.updatedAt = Number(p.updatedAt) || s.updatedAt;
        if (p.lastPenaltyKind) s.lastPenaltyKind = String(p.lastPenaltyKind);
      }
      n++;
    }
    return n;
  }

  /** Fold one `P2P_INVENTORY_RESPONSE` body (`{ kind, items }`) into the index. */
  ingestInventoryResponse (opts: IngestOptions): OfferRow[] {
    const origin = String(opts.origin || '').trim();
    const items = Array.isArray(opts.items) ? opts.items : [];
    const sellerId = opts.sellerId != null && opts.sellerId !== '' ? String(opts.sellerId) : origin;
    if (!sellerId) return [];
    const signer = opts.signerPubkeyHex ? String(opts.signerPubkeyHex).trim().toLowerCase() : null;

    if (opts.latencyMs != null && Number.isFinite(Number(opts.latencyMs))) {
      this.recordInventoryLatency(sellerId, Number(opts.latencyMs), { hops: opts.hops });
    } else if (opts.hops != null) {
      const s = this.stats(sellerId);
      if (s) s.hops = Math.max(0, Math.round(Number(opts.hops) || 0));
    }

    const peerScore = this.scoreFor(sellerId);
    const latencyMs = Number.isFinite(Number(opts.latencyMs)) ? Number(opts.latencyMs) : this.latencyFor(sellerId);
    const hops = Number.isFinite(Number(opts.hops)) ? Math.max(0, Math.round(Number(opts.hops))) : 0;
    const now = Date.now();
    const out: OfferRow[] = [];

    for (const raw of items) {
      const it = asRecord(raw);
      if (!it) continue;
      const documentId = String(it.id || it.documentId || '').trim();
      if (!documentId) continue;
      const rateSats = Number(it.rateSats != null ? it.rateSats : it.purchasePriceSats) || 0;
      const contentHashHex = contentHashHexFromObject(it);
      const indexObj = asRecord(it.documentBlobIndex);
      const merkleRootHex = hex64(it.merkleRootHex || (indexObj && indexObj.merkleRootHex));
      const base = {
        documentId,
        sellerId,
        sellerAddress: origin,
        sellerPubkey: opts.sellerPubkey
          ? String(opts.sellerPubkey).trim().toLowerCase()
          : (it.sellerPubkey ? String(it.sellerPubkey).toLowerCase() : null),
        ampSignerPubkey: signer,
        merkleRootHex,
        sealed: it.sealed === true,
        peerScore,
        latencyMs,
        hops,
        observedAt: now
      };
      const blobs = Array.isArray(it.blobs) ? it.blobs : null;
      if (blobs && blobs.length) {
        for (const b0 of blobs) {
          const b = asRecord(b0);
          if (!b) continue;
          const row: OfferRow = {
            ...base,
            blobIndex: Number(b.index),
            blobTotal: Number(b.total != null ? b.total : blobs.length),
            rateSats: Number(b.rateSats != null ? b.rateSats : rateSats) || 0,
            contentHashHex: contentHashHexFromObject(b) || contentHashHex,
            blobHashHex: hex64(b.blobHashHex),
            size: b.size != null ? Number(b.size) : (it.size != null ? Number(it.size) : null)
          };
          this.offers.set(offerKey(row), row);
          out.push(row);
        }
      } else {
        const row: OfferRow = {
          ...base,
          blobIndex: it.blobIndex != null ? Number(it.blobIndex) : null,
          blobTotal: it.blobTotal != null ? Number(it.blobTotal) : null,
          rateSats,
          contentHashHex,
          blobHashHex: hex64(it.blobHashHex),
          size: it.size != null ? Number(it.size) : null
        };
        this.offers.set(offerKey(row), row);
        out.push(row);
      }
    }
    return out;
  }

  forgetSeller (sellerId: string): number {
    const id = String(sellerId || '');
    let n = 0;
    for (const [k, row] of this.offers) {
      if (row.sellerId === id) { this.offers.delete(k); n++; }
    }
    return n;
  }

  listOffers (filter: { documentId?: string; blobHashHex?: string; merkleRootHex?: string; sellerId?: string } = {}): OfferRow[] {
    const blob = filter.blobHashHex ? hex64(filter.blobHashHex) : null;
    const root = filter.merkleRootHex ? hex64(filter.merkleRootHex) : null;
    const rows: OfferRow[] = [];
    for (const row of this.offers.values()) {
      if (filter.documentId && row.documentId !== filter.documentId) continue;
      if (filter.sellerId && row.sellerId !== filter.sellerId) continue;
      if (blob && row.blobHashHex !== blob) continue;
      if (root && row.merkleRootHex !== root) continue;
      rows.push(row);
    }
    return rows;
  }

  /** Providers of one chunk, best first (score desc, latency asc, price asc). */
  providersForBlob (blobHashHex: string): OfferRow[] {
    return this.listOffers({ blobHashHex }).sort(rankProviders);
  }

  /** Chunk locator: blob hash → ranked providers. */
  indexByBlobHash (filter: { documentId?: string; merkleRootHex?: string } = {}): Map<string, OfferRow[]> {
    const out = new Map<string, OfferRow[]>();
    for (const row of this.listOffers(filter)) {
      if (!row.blobHashHex) continue;
      const list = out.get(row.blobHashHex) || [];
      list.push(row);
      out.set(row.blobHashHex, list);
    }
    for (const [hash, list] of out) out.set(hash, list.sort(rankProviders));
    return out;
  }
}

export default DocumentOfferBook;
