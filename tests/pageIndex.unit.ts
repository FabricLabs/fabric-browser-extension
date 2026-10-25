import assert from 'assert';
import { createHash } from 'crypto';
import {
  PageIndex,
  MemoryPageIndexStore,
  buildPageBlobTree,
  merkleRootHexFromBlobHashes,
  PAGE_BLOB_CHUNK_BYTES
} from '../src/services/pageIndex';
import { DocumentOfferBook, TELEMETRY_TYPE } from '../src/types/offerBook';
import { tryParseNotifiableWireMessage } from '../src/fabric/fabricWireNotify';
import { INVENTORY_RESPONSE } from '../src/fabric/messageTypes';

// Core reference (sibling checkout or installed @fabric/core).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CoreDocument = require('@fabric/core/types/document');

describe('pageIndex (legacy web page chunk index)', () => {
  it('merkle root matches the core document tree for 1..5 leaves', async () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const leaves: string[] = [];
      for (let i = 0; i < n; i++) leaves.push(createHash('sha256').update('leaf' + i).digest('hex'));
      assert.strictEqual(await merkleRootHexFromBlobHashes(leaves), CoreDocument.rootHexFromBlobHashes(leaves));
    }
  });

  it('splits content into 24 KiB blobs with sha256 leaves', async () => {
    const content = new Uint8Array(PAGE_BLOB_CHUNK_BYTES * 2 + 17).fill(7);
    const { tree, chunks } = await buildPageBlobTree(content);
    assert.strictEqual(tree.blobTotal, 3);
    assert.strictEqual(chunks.length, 3);
    assert.strictEqual(tree.blobs[2].size, 17);
    assert.strictEqual(tree.blobs[0].blobHashHex, createHash('sha256').update(chunks[0]).digest('hex'));
    assert.strictEqual(tree.contentSha256, createHash('sha256').update(content).digest('hex'));
    assert.strictEqual(tree.merkleRootHex, CoreDocument.rootHexFromBlobHashes(tree.blobs.map((b) => b.blobHashHex)));
  });

  it('captures a page, reads it back, and lists hash-only inventory items', async () => {
    const index = new PageIndex(new MemoryPageIndexStore());
    const html = '<html><body>' + 'x'.repeat(30000) + '</body></html>';
    const page = await index.capture({ url: 'https://example.com/a', title: 'A', content: html });
    assert.strictEqual(page.blobTotal, 2);
    const back = await index.readPage('https://example.com/a');
    assert.ok(back);
    assert.strictEqual(new TextDecoder().decode(back!), html);
    const items = await index.inventoryItems({ rateSats: 2 });
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].id, page.contentSha256);
    assert.ok(!('name' in items[0]) && !('url' in items[0]) && !('mime' in items[0]));
    const loc = await index.locate(page.blobs[0].blobHashHex);
    assert.strictEqual(loc.local, true);
    assert.deepStrictEqual(loc.providers, []);
  });

  it('indexes peer inventory responses by blob hash and persists telemetry', async () => {
    const store = new MemoryPageIndexStore();
    const index = new PageIndex(store);
    const blob = 'dd'.repeat(32);
    const root = 'cc'.repeat(32);
    const payload = {
      kind: 'documents',
      items: [{ id: 'ab'.repeat(32), rateSats: 3, merkleRootHex: root, blobs: [{ index: 0, total: 1, blobHashHex: blob, rateSats: 3 }] }]
    };
    await index.ingestInventoryResponse({ origin: 'peerA', payload, signerPubkeyHex: '02' + 'aa'.repeat(32), latencyMs: 40 });
    await index.ingestInventoryResponse({ origin: 'peerB', payload, latencyMs: 10, hops: 2 });
    const loc = await index.locate(blob);
    assert.strictEqual(loc.local, false);
    assert.strictEqual(loc.providers.length, 2);
    // Same score (inventory-only = 500); lower effective latency wins (40 vs 10 + 2*50).
    assert.strictEqual(loc.providers[0].sellerId, '02' + 'aa'.repeat(32));
    const byRoot = await index.locatePage({ merkleRootHex: root });
    assert.strictEqual(byRoot.length, 1);
    const rec = await store.getMeta<{ type: string; providers: unknown[] }>('provider-telemetry');
    assert.strictEqual(rec && rec.type, TELEMETRY_TYPE);
    assert.strictEqual(rec && rec.providers.length, 2);
  });

  it('telemetry export round-trips through a fresh book (core-compatible shape)', () => {
    const a = new DocumentOfferBook();
    a.recordInventoryLatency('s1', 100, { hops: 1 });
    a.recordDelivery('s1', { ok: true, bytes: 10, latencyMs: 50 });
    a.recordDelivery('s1', { ok: false });
    const rec = a.exportTelemetry();
    assert.strictEqual(rec.type, 'ProviderTelemetry');
    assert.strictEqual(rec.version, 1);
    assert.deepStrictEqual(Object.keys(rec.providers[0]).sort(), [
      'bytesDelivered', 'deliveries', 'deliveryLatencyMs', 'failures', 'hops', 'inventories',
      'inventoryLatencyMs', 'penalties', 'refunds', 'sellerId', 'updatedAt'
    ]);
    const b = new DocumentOfferBook();
    assert.strictEqual(b.importTelemetry(rec), 1);
    assert.strictEqual(b.scoreFor('s1'), 500);
    assert.strictEqual(b.latencyFor('s1'), 150);
  });

  it('wire parser surfaces P2P_INVENTORY_RESPONSE bodies for the index', () => {
    const body = JSON.stringify({ kind: 'documents', items: [{ id: 'x' }], created: 1 });
    const got = tryParseNotifiableWireMessage({ type: 'P2P_INVENTORY_RESPONSE', body });
    assert.ok(got);
    assert.strictEqual(got!.messageType, INVENTORY_RESPONSE);
    assert.strictEqual((got!.payload.items as unknown[]).length, 1);
  });
});
