import assert from 'assert';
import { DocumentOfferBook } from '../src/types/offerBook';
import { MarketAgent, weightsForProximity, HTLC_MINIMUM_SATS } from '../src/services/market';

const ROOT = 'ab'.repeat(32);
const P = HTLC_MINIMUM_SATS;
const h = (n: number) => n.toString(16).padStart(2, '0').repeat(32);

function items (rate: number) {
  return [0, 1].map((i) => ({
    documentId: 'doc', merkleRootHex: ROOT, blobIndex: i, blobTotal: 2, blobHashHex: h(i + 1),
    contentHashHex: h(i + 10), rateSats: rate, size: 2048, sealed: true
  }));
}

function bookWithTwoSellers (): DocumentOfferBook {
  const book = new DocumentOfferBook();
  book.ingestInventoryResponse({ origin: 'near', items: items(P + 400), latencyMs: 20, hops: 0 });
  book.ingestInventoryResponse({ origin: 'far', items: items(P), latencyMs: 400, hops: 2 });
  return book;
}

describe('Passport MarketAgent (budget agent mirror)', () => {
  it('maps proximity weight like core', () => {
    assert.deepStrictEqual(weightsForProximity(0), { price: 0.6, latency: 0.1, peerScore: 0.2, completeness: 0.1 });
    assert.deepStrictEqual(weightsForProximity(1), { price: 0.09999999999999998, latency: 0.6, peerScore: 0.2, completeness: 0.1 });
  });

  it('plans per blob, respects caps, and hands paid sessions to a funder', () => {
    const book = bookWithTwoSellers();
    const inv: unknown[] = [];
    const agent = new MarketAgent({ budgetSats: 100 * P, perPlanMaxSats: 2 * P + 100, proximityWeight: 0 }, {
      book, publishInventoryRequest: (b) => inv.push(b)
    });
    agent.want(ROOT, { blobTotal: 2 });
    let out = agent.tick();
    assert.strictEqual(inv.length, 1, 'inventory refreshed once');
    assert.strictEqual(out.opened, 2, 'cheapest plan (P+P sats) fits the cap');
    const funding = agent.status().sessions;
    assert.ok(funding.every((s) => s.status === 'awaiting_funding' && s.sellerId === 'far'));
    assert.strictEqual(agent.reservedSats, 2 * P);

    // A paired node funds one; delivery completes and spends.
    agent.confirm(funding[0].settlementId);
    agent.blobReceived(ROOT, 0, { bytes: 2048 });
    assert.strictEqual(agent.spentSats, P);
    assert.strictEqual(agent.reservedSats, P);

    // The other fails: provider is penalised locally and the want re-opens.
    agent.blobFailed(ROOT, 1);
    assert.strictEqual(agent.status().wants[0].status, 'wanted');
    assert.strictEqual(book.exportTelemetry().providers.find((p) => p.sellerId === 'far')!.failures, 1);
  });

  it('never plans a paid offer below the mainnet HTLC minimum', () => {
    const book = new DocumentOfferBook();
    book.ingestInventoryResponse({ origin: 'cheap', items: items(P - 1), latencyMs: 20, hops: 0 });
    const agent = new MarketAgent({ budgetSats: 100 * P }, { book });
    const want = agent.want(ROOT, { blobTotal: 2 });
    assert.strictEqual(agent.tick().opened, 0);
    assert.match(String(want.lastError), /HTLC minimum/);
    book.ingestInventoryResponse({ origin: 'fair', items: items(P), latencyMs: 400, hops: 2 });
    assert.strictEqual(agent.tick().opened, 2);
    assert.ok(agent.status().sessions.every((s) => s.sellerId === 'fair'));
  });

  it('prefers the near seller when proximity dominates and free blobs skip funding', () => {
    const book = bookWithTwoSellers();
    book.ingestInventoryResponse({ origin: 'near', items: [0, 1].map((i) => ({
      documentId: 'doc', merkleRootHex: ROOT, blobIndex: i, blobTotal: 2, blobHashHex: h(i + 1), rateSats: 0
    })), latencyMs: 20, hops: 0 });
    const requested: number[] = [];
    const agent = new MarketAgent({ budgetSats: 0, proximityWeight: 1 }, { book, requestBlob: (s) => requested.push(s.blobIndex) });
    agent.want(ROOT);
    agent.tick();
    assert.deepStrictEqual(requested.sort(), [0, 1]);
    assert.ok(agent.status().sessions.every((s) => s.sellerId === 'near' && s.status === 'delivery_pending'));
  });

  it('retries only the failed blob within budget and then completes', () => {
    const book = new DocumentOfferBook();
    book.ingestInventoryResponse({ origin: 'far', items: items(P), latencyMs: 400, hops: 2 });
    const agent = new MarketAgent({ budgetSats: 2 * P }, { book });
    const want = agent.want(ROOT, { blobTotal: 2 });
    assert.strictEqual(agent.tick().opened, 2);
    for (const s of agent.status().sessions) agent.confirm(s.settlementId);
    agent.blobReceived(ROOT, 0);
    agent.blobFailed(ROOT, 1);
    assert.strictEqual(want.status, 'wanted');

    // Cap is now P (blob 0 spent); only blob 1 still needs buying.
    assert.strictEqual(agent.tick().opened, 1);
    assert.strictEqual(want.lastError, null);
    assert.strictEqual(want.status, 'buying');
    const retry = agent.status().sessions.find((s) => s.blobIndex === 1 && s.status === 'awaiting_funding')!;
    agent.confirm(retry.settlementId);
    agent.blobReceived(ROOT, 1);
    assert.strictEqual(want.status, 'complete');
  });

  it('marks a want buying only when it opened sessions itself', () => {
    const OTHER = 'cd'.repeat(32);
    const book = new DocumentOfferBook();
    const agent = new MarketAgent({ budgetSats: 100 * P }, { book });
    const first = agent.want(OTHER, { blobTotal: 2 });
    const second = agent.want(ROOT, { blobTotal: 2 });
    book.ingestInventoryResponse({ origin: 'far', items: items(P), latencyMs: 400, hops: 2 });
    assert.strictEqual(agent.tick().opened, 2);
    assert.strictEqual(second.status, 'buying');
    // Every blob of `second` already has a live session; nothing new opens for it.
    second.status = 'wanted';
    book.ingestInventoryResponse({
      origin: 'far',
      items: items(P).map((it) => ({ ...it, documentId: 'other', merkleRootHex: OTHER })),
      latencyMs: 400,
      hops: 2
    });
    assert.strictEqual(agent.tick().opened, 2);
    assert.strictEqual(first.status, 'buying');
    assert.strictEqual(second.status, 'wanted');
  });

  it('refuses peer-advertised blob counts it cannot plan', () => {
    const book = new DocumentOfferBook();
    const rows = book.ingestInventoryResponse({
      origin: 'liar',
      items: [
        { documentId: 'doc', merkleRootHex: ROOT, blobTotal: 1e308, rateSats: P },
        { documentId: 'doc', merkleRootHex: ROOT, blobIndex: 'Infinity', blobTotal: 2, rateSats: P },
        { documentId: 'doc', merkleRootHex: ROOT, blobs: [{ index: 1e9, total: 'Infinity' }, { index: 0, total: 1e308 }] }
      ]
    });
    assert.strictEqual(rows.length, 2);
    assert.ok(rows.every((r) => r.blobTotal === null));
    assert.deepStrictEqual(rows.map((r) => r.blobIndex), [null, 0]);

    const stub = { listOffers: () => [{ ...rows[0], blobTotal: 1e9 }], hopPenaltyMs: 50 } as unknown as DocumentOfferBook;
    const agent = new MarketAgent({ budgetSats: 100 * P }, { book: stub });
    const want = agent.want(ROOT);
    assert.strictEqual(agent.tick().opened, 0);
    assert.match(String(want.lastError), /unsupported blob count/);
  });

  it('round-trips export/import', () => {
    const book = bookWithTwoSellers();
    const a = new MarketAgent({ budgetSats: 9 * P }, { book });
    a.want(ROOT, { blobTotal: 2, maxSats: 4 * P });
    a.tick();
    const b = new MarketAgent({}, { book }).import(a.export());
    assert.strictEqual(b.budgetSats, 9 * P);
    assert.strictEqual(b.reservedSats, a.reservedSats);
    assert.strictEqual(b.status().wants[0].merkleRootHex, ROOT);
  });
});
