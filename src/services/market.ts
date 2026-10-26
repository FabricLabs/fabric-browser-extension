/**
 * Passport consumer budget agent — mirror of `@fabric/core/services/market`.
 *
 * Holds a sats budget and a set of wanted blob trees (by Tree root). On each
 * `tick()` it refreshes peer inventories through the injected
 * `publishInventoryRequest` (a `P2P_INVENTORY_REQUEST` body selecting on
 * `merkleRootHex` / `maxSats` — an existing wire type), plans the
 * cheapest / nearest / most reliable provider per blob from the page index's
 * `DocumentOfferBook`, and opens one purchase session per blob when the plan
 * fits `perPlanMaxSats` and the remaining budget.
 *
 * Passport has no L1 HTLC funding path of its own: paid sessions stop at
 * `awaiting_funding` and are surfaced to the UI / a paired desktop node;
 * free blobs (rate 0) are requested immediately through `requestBlob`.
 */

import { DocumentOfferBook, MAX_DOCUMENT_BLOBS, type OfferRow, effectiveLatencyMs } from '../types/offerBook';

export interface MarketAgentSettings {
  budgetSats?: number;
  perPlanMaxSats?: number;
  /** 0 = cheapest wins, 1 = nearest / fastest wins. */
  proximityWeight?: number;
  inventoryEveryMs?: number;
}

export interface MarketWant {
  merkleRootHex: string;
  documentId: string;
  blobTotal: number | null;
  maxSats: number | null;
  status: 'wanted' | 'buying' | 'complete';
  created: number;
  lastInventoryAt: number;
  lastError: string | null;
  sessions: string[];
}

export interface MarketSession {
  settlementId: string;
  documentId: string;
  merkleRootHex: string;
  blobIndex: number;
  blobHashHex: string | null;
  paymentHashHex: string | null;
  sellerId: string;
  amountSats: number;
  status: 'open' | 'awaiting_funding' | 'delivery_pending' | 'complete' | 'failed';
  openedAt: number;
  completedAt?: number;
  error?: string;
}

export interface MarketAgentDeps {
  book: DocumentOfferBook;
  /** Broadcast an inventory request body to connected peers. */
  publishInventoryRequest?: (body: { offerBtc: true; merkleRootHex: string; maxSats?: number }) => void;
  /** Ask a seller for one blob (free or already-funded). */
  requestBlob?: (session: MarketSession) => void;
  now?: () => number;
}

export interface MarketAgentStatus {
  type: 'MarketAgentStatus';
  budgetSats: number;
  spentSats: number;
  reservedSats: number;
  remainingSats: number;
  perPlanMaxSats: number;
  proximityWeight: number;
  wants: MarketWant[];
  sessions: MarketSession[];
}

export interface MarketAgentState {
  type: 'MarketAgentState';
  version: 1;
  budgetSats: number;
  spentSats: number;
  wants: Record<string, MarketWant>;
  sessions: Record<string, MarketSession>;
}

/**
 * Core `HTLC_MINIMUM_SATS`: the smallest HTLC that settles on Bitcoin mainnet
 * (546 dust + a 170 vB claim at 1 sat/vB). Paid offers below it are never planned.
 */
export const HTLC_MINIMUM_SATS = 716;

function settleable (offer: OfferRow): boolean {
  const rate = Number(offer.rateSats) || 0;
  return rate <= 0 || rate >= HTLC_MINIMUM_SATS;
}

function randomId (): string {
  const bytes = new Uint8Array(8);
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c && c.getRandomValues) c.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s;
}

/** Same weight map as core `Market.weightsForProximity`. */
export function weightsForProximity (proximityWeight: number): { price: number; latency: number; peerScore: number; completeness: number } {
  const p = Math.min(1, Math.max(0, Number(proximityWeight) || 0));
  const latency = 0.1 + (0.5 * p);
  return { price: 0.7 - latency, latency, peerScore: 0.2, completeness: 0.1 };
}

/** Core `DocumentOfferBook#rankOffers` normalisation, best first. */
export function rankOffers (offers: OfferRow[], weights: ReturnType<typeof weightsForProximity>, hopPenaltyMs?: number): Array<OfferRow & { rankScore: number }> {
  if (!offers.length) return [];
  const prices = offers.map((o) => Number(o.rateSats) || 0);
  const lats = offers.map((o) => effectiveLatencyMs(o, hopPenaltyMs));
  const scores = offers.map((o) => Number(o.peerScore) || 0);
  const [minP, maxP] = [Math.min(...prices), Math.max(...prices)];
  const [minL, maxL] = [Math.min(...lats), Math.max(...lats)];
  const [minS, maxS] = [Math.min(...scores), Math.max(...scores)];
  const low = (v: number, min: number, max: number) => (max <= min ? 1 : 1 - ((v - min) / (max - min)));
  const high = (v: number, min: number, max: number) => (max <= min ? 1 : (v - min) / (max - min));
  return offers.map((o, i) => ({
    ...o,
    rankScore: (weights.price * low(prices[i], minP, maxP)) +
      (weights.latency * low(lats[i], minL, maxL)) +
      (weights.peerScore * high(scores[i], minS, maxS)) +
      (weights.completeness * 1)
  })).sort((a, b) => b.rankScore - a.rankScore);
}

export class MarketAgent {
  readonly settings: Required<MarketAgentSettings>;
  private readonly deps: MarketAgentDeps;
  private budget: number;
  private spent = 0;
  private reserved = 0;
  private readonly wants = new Map<string, MarketWant>();
  private readonly sessions = new Map<string, MarketSession>();
  private readonly listeners = new Map<string, Array<(payload: unknown) => void>>();

  constructor (settings: MarketAgentSettings = {}, deps: MarketAgentDeps) {
    this.settings = {
      budgetSats: Math.max(0, Math.floor(Number(settings.budgetSats) || 0)),
      perPlanMaxSats: Math.max(0, Math.floor(Number(settings.perPlanMaxSats) || 0)),
      proximityWeight: Math.min(1, Math.max(0, Number(settings.proximityWeight ?? 0.5))),
      inventoryEveryMs: Math.max(0, Number(settings.inventoryEveryMs ?? 30000))
    };
    this.deps = deps;
    this.budget = this.settings.budgetSats;
  }

  on (event: string, fn: (payload: unknown) => void): this {
    const list = this.listeners.get(event) || [];
    list.push(fn);
    this.listeners.set(event, list);
    return this;
  }

  private emit (event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) || []) {
      try { fn(payload); } catch (_) { /* listener errors never break the agent */ }
    }
  }

  private now (): number { return this.deps.now ? this.deps.now() : Date.now(); }

  get budgetSats (): number { return this.budget; }
  get spentSats (): number { return this.spent; }
  get reservedSats (): number { return this.reserved; }
  get remainingSats (): number { return Math.max(0, this.budget - this.spent - this.reserved); }

  setBudget (sats: number): void { this.budget = Math.max(0, Math.floor(Number(sats) || 0)); }

  weights (): ReturnType<typeof weightsForProximity> { return weightsForProximity(this.settings.proximityWeight); }

  want (merkleRootHex: string, opts: { documentId?: string; blobTotal?: number; maxSats?: number } = {}): MarketWant {
    const root = String(merkleRootHex || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(root)) throw new Error('merkleRootHex must be 64 hex chars');
    const record: MarketWant = {
      merkleRootHex: root,
      documentId: opts.documentId || root,
      blobTotal: opts.blobTotal != null ? Math.max(1, Math.round(Number(opts.blobTotal))) : null,
      maxSats: opts.maxSats != null ? Math.max(0, Math.floor(Number(opts.maxSats))) : null,
      status: 'wanted',
      created: this.now(),
      lastInventoryAt: 0,
      lastError: null,
      sessions: []
    };
    this.wants.set(root, record);
    return record;
  }

  forget (merkleRootHex: string): boolean {
    const root = String(merkleRootHex || '').toLowerCase();
    const w = this.wants.get(root);
    if (!w) return false;
    for (const sid of w.sessions) {
      const s = this.sessions.get(sid);
      if (s && (s.status === 'open' || s.status === 'awaiting_funding')) this.release(s);
    }
    this.wants.delete(root);
    return true;
  }

  planCap (want: MarketWant): number {
    const caps = [this.remainingSats];
    if (this.settings.perPlanMaxSats > 0) caps.push(this.settings.perPlanMaxSats);
    if (want.maxSats != null && want.maxSats > 0) caps.push(want.maxSats);
    return Math.max(0, Math.min(...caps));
  }

  /** Per-blob plan (seller-diverse when scores tie within 10%, like core). */
  planFor (want: MarketWant): { ok: boolean; plan: Map<number, OfferRow>; costSats: number; blobTotal: number; error?: string } {
    const listed = this.deps.book.listOffers({ merkleRootHex: want.merkleRootHex });
    const offers = listed.filter(settleable);
    const plan = new Map<number, OfferRow>();
    if (!offers.length) {
      const error = listed.length ? `offers below the ${HTLC_MINIMUM_SATS}-sat HTLC minimum` : 'no offers';
      return { ok: false, plan, costSats: 0, blobTotal: want.blobTotal || 0, error };
    }
    const blobTotal = want.blobTotal || Number(offers.find((o) => o.blobTotal && o.blobTotal > 0)?.blobTotal) || 1;
    if (!Number.isInteger(blobTotal) || blobTotal > MAX_DOCUMENT_BLOBS) {
      return { ok: false, plan, costSats: 0, blobTotal: 0, error: `unsupported blob count ${blobTotal}` };
    }
    const weights = this.weights();
    const used: string[] = [];
    for (let i = 0; i < blobTotal; i++) {
      let rows = offers.filter((o) => o.blobIndex === i);
      if (!rows.length) rows = offers.filter((o) => o.blobIndex == null);
      const ranked = rankOffers(rows, weights, this.deps.book.hopPenaltyMs);
      if (!ranked.length) continue;
      let pick: OfferRow = ranked[0];
      if (used.length && ranked.length > 1) {
        const band = ranked[0].rankScore * 0.9;
        const diverse = ranked.find((o) => o.rankScore >= band && !used.includes(o.sellerId));
        if (diverse) pick = diverse;
      }
      plan.set(i, pick);
      used.push(pick.sellerId);
    }
    if (plan.size < blobTotal) return { ok: false, plan, costSats: 0, blobTotal, error: `plan incomplete (${plan.size}/${blobTotal})` };
    let costSats = 0;
    for (const o of plan.values()) costSats += Math.max(0, Math.floor(Number(o.rateSats) || 0));
    return { ok: true, plan, costSats, blobTotal };
  }

  tick (): { planned: number; opened: number; skipped: number } {
    const summary = { planned: 0, opened: 0, skipped: 0 };
    for (const want of this.wants.values()) {
      if (want.status !== 'wanted') continue;
      this.refreshInventory(want);
      const planned = this.planFor(want);
      if (!planned.ok) { want.lastError = planned.error || 'no plan'; summary.skipped++; continue; }
      summary.planned++;
      const cap = this.planCap(want);
      const live = new Set(Array.from(this.sessions.values())
        .filter((s) => s.merkleRootHex === want.merkleRootHex && s.status !== 'failed')
        .map((s) => s.blobIndex));
      let pendingCost = 0;
      for (const [index, offer] of planned.plan) {
        if (!live.has(index)) pendingCost += Math.max(0, Math.floor(Number(offer.rateSats) || 0));
      }
      if (pendingCost > cap) {
        want.lastError = `plan costs ${pendingCost} sats > cap ${cap}`;
        summary.skipped++;
        continue;
      }
      want.lastError = null;
      let openedHere = 0;
      for (const [index, offer] of planned.plan.entries()) {
        if (this.openSession(want, offer, index)) openedHere++;
      }
      summary.opened += openedHere;
      if (openedHere) want.status = 'buying';
    }
    return summary;
  }

  private refreshInventory (want: MarketWant): void {
    if (!this.deps.publishInventoryRequest) return;
    const now = this.now();
    if (now - want.lastInventoryAt < this.settings.inventoryEveryMs) return;
    want.lastInventoryAt = now;
    const cap = this.planCap(want);
    this.deps.publishInventoryRequest({ offerBtc: true, merkleRootHex: want.merkleRootHex, maxSats: cap > 0 ? cap : undefined });
  }

  private openSession (want: MarketWant, offer: OfferRow, blobIndex: number): MarketSession | null {
    const amountSats = Math.max(0, Math.floor(Number(offer.rateSats) || 0));
    const dupe = Array.from(this.sessions.values()).find((s) =>
      s.merkleRootHex === want.merkleRootHex && s.blobIndex === blobIndex && s.status !== 'failed');
    if (dupe) return null;
    const session: MarketSession = {
      settlementId: randomId(),
      documentId: want.documentId,
      merkleRootHex: want.merkleRootHex,
      blobIndex,
      blobHashHex: offer.blobHashHex,
      paymentHashHex: offer.contentHashHex,
      sellerId: offer.sellerId,
      amountSats,
      status: 'open',
      openedAt: this.now()
    };
    this.sessions.set(session.settlementId, session);
    want.sessions.push(session.settlementId);
    this.reserved += amountSats;
    if (amountSats > 0) {
      // Passport cannot fund a buyer-bound L1 HTLC itself; hand off.
      session.status = 'awaiting_funding';
      this.emit('fundingRequired', session);
      return session;
    }
    session.status = 'delivery_pending';
    if (this.deps.requestBlob) this.deps.requestBlob(session);
    this.emit('sessionConfirmed', session);
    return session;
  }

  /** A paired node funded + confirmed this session; request delivery. */
  confirm (settlementId: string): MarketSession | null {
    const s = this.sessions.get(settlementId);
    if (!s || s.status !== 'awaiting_funding') return s || null;
    s.status = 'delivery_pending';
    if (this.deps.requestBlob) this.deps.requestBlob(s);
    this.emit('sessionConfirmed', s);
    return s;
  }

  /** Verified bytes (and key, when sealed) arrived for a blob. */
  blobReceived (merkleRootHex: string, blobIndex: number, info: { bytes?: number } = {}): void {
    const root = String(merkleRootHex || '').toLowerCase();
    for (const s of this.sessions.values()) {
      if (s.merkleRootHex !== root || s.blobIndex !== blobIndex || s.status !== 'delivery_pending') continue;
      s.status = 'complete';
      s.completedAt = this.now();
      this.release(s);
      this.spent += s.amountSats;
      this.deps.book.recordDelivery(s.sellerId, { ok: true, latencyMs: s.completedAt - s.openedAt, bytes: info.bytes });
      this.emit('sessionComplete', s);
    }
    const want = this.wants.get(root);
    if (want) {
      const live = want.sessions.map((id) => this.sessions.get(id)).filter((s): s is MarketSession => !!s && s.status !== 'failed');
      const done = new Set(live.filter((s) => s.status === 'complete').map((s) => s.blobIndex));
      if (live.length && live.every((s) => s.status === 'complete') && (want.blobTotal == null || done.size >= want.blobTotal)) {
        want.status = 'complete';
      }
    }
  }

  /** Delivery failed for a blob: penalise the provider locally and re-plan later. */
  blobFailed (merkleRootHex: string, blobIndex: number, reason = 'delivery failed'): void {
    const root = String(merkleRootHex || '').toLowerCase();
    for (const s of this.sessions.values()) {
      if (s.merkleRootHex !== root || s.blobIndex !== blobIndex || s.status === 'complete' || s.status === 'failed') continue;
      s.status = 'failed';
      s.error = reason;
      this.release(s);
      this.deps.book.recordDelivery(s.sellerId, { ok: false });
      this.emit('sessionFailed', s);
    }
    const want = this.wants.get(root);
    if (want && want.status === 'buying') want.status = 'wanted';
  }

  private release (s: MarketSession & { _released?: boolean }): void {
    if (s._released) return;
    s._released = true;
    this.reserved = Math.max(0, this.reserved - s.amountSats);
  }

  status (): MarketAgentStatus {
    return {
      type: 'MarketAgentStatus',
      budgetSats: this.budget,
      spentSats: this.spent,
      reservedSats: this.reserved,
      remainingSats: this.remainingSats,
      perPlanMaxSats: this.settings.perPlanMaxSats,
      proximityWeight: this.settings.proximityWeight,
      wants: Array.from(this.wants.values()),
      sessions: Array.from(this.sessions.values())
    };
  }

  export (): MarketAgentState {
    const wants: Record<string, MarketWant> = {};
    for (const [k, v] of this.wants) wants[k] = v;
    const sessions: Record<string, MarketSession> = {};
    for (const [k, v] of this.sessions) sessions[k] = v;
    return { type: 'MarketAgentState', version: 1, budgetSats: this.budget, spentSats: this.spent, wants, sessions };
  }

  import (state: Partial<MarketAgentState> | null | undefined): this {
    if (!state || state.type !== 'MarketAgentState') return this;
    this.budget = Math.max(0, Math.floor(Number(state.budgetSats) || 0));
    this.spent = Math.max(0, Math.floor(Number(state.spentSats) || 0));
    this.wants.clear();
    this.sessions.clear();
    for (const [k, v] of Object.entries(state.wants || {})) this.wants.set(k, v);
    for (const [k, v] of Object.entries(state.sessions || {})) this.sessions.set(k, v);
    this.reserved = Array.from(this.sessions.values())
      .filter((s) => s.status === 'open' || s.status === 'awaiting_funding' || s.status === 'delivery_pending')
      .reduce((n, s) => n + s.amountSats, 0);
    return this;
  }
}

export default MarketAgent;
