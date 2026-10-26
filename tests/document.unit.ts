import assert from 'assert';
import { createHash } from 'crypto';
import { FabricDocument, SEAL_SCHEME, MANIFEST_TYPE } from '../src/types/document';

// Core reference (sibling checkout or installed @fabric/core).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sealedExchange = require('@fabric/core/functions/documentSealedExchange');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CoreDocument = require('@fabric/core/types/document');

describe('Passport FabricDocument (core mirror)', function () {
  this.timeout(10000);

  it('seals with one key per blob and a core-identical merkle root', async () => {
    const plain = new Uint8Array(5000).fill(7);
    const doc = await FabricDocument.seal(plain, { chunkBytes: 2048, documentId: 'demo' });
    assert.strictEqual(doc.blobTotal, 3); // 2032-byte plaintext slices (2048 - 16 tag)
    assert.ok(doc.sealed);
    const keys = new Set<string>();
    for (const leaf of doc.record.blobs) {
      assert.strictEqual(leaf.scheme, SEAL_SCHEME);
      const key = doc.keyFor(leaf.index) as string;
      keys.add(key);
      assert.strictEqual(createHash('sha256').update(Buffer.from(key, 'hex')).digest('hex'), leaf.paymentHashHex);
      assert.strictEqual(createHash('sha256').update(Buffer.from(doc.bytesFor(leaf.index) as Uint8Array)).digest('hex'), leaf.blobHashHex);
    }
    assert.strictEqual(keys.size, 3);
    assert.strictEqual(doc.merkleRootHex, CoreDocument.rootHex(doc.record.blobs));
  });

  it('core opens Passport-sealed blobs and Passport opens core-sealed blobs', async () => {
    const text = 'legacy web page body '.repeat(40);
    const doc = await FabricDocument.seal(text, { chunkBytes: 256 });
    for (const leaf of doc.record.blobs) {
      const opened = sealedExchange.openCiphertext(
        Buffer.from(doc.bytesFor(leaf.index) as Uint8Array),
        doc.keyFor(leaf.index),
        leaf.iv
      );
      assert.strictEqual(createHash('sha256').update(opened).digest('hex'), leaf.plaintextSha256);
    }

    const coreSealed = sealedExchange.sealPlaintext(Buffer.from('from core'));
    const record = {
      documentId: null,
      merkleRootHex: CoreDocument.rootHex([{ blobHashHex: coreSealed.contentSha256, paymentHashHex: sealedExchange.paymentHashHexFromKey(coreSealed.key), iv: coreSealed.encryption.iv }]),
      blobTotal: 1,
      chunkBytes: 1024,
      sealed: true,
      size: 9,
      publisher: null,
      blobs: [{
        index: 0,
        total: 1,
        blobHashHex: coreSealed.contentSha256,
        paymentHashHex: sealedExchange.paymentHashHexFromKey(coreSealed.key),
        size: coreSealed.ciphertext.length,
        iv: coreSealed.encryption.iv,
        scheme: SEAL_SCHEME
      }]
    };
    const buyer = FabricDocument.fromRecord(record);
    assert.ok(await buyer.acceptBytes(0, new Uint8Array(coreSealed.ciphertext)));
    await assert.rejects(buyer.openBlob(0, '00'.repeat(32)), /payment hash/);
    const plain = await buyer.openBlob(0, coreSealed.key.toString('hex'));
    assert.strictEqual(new TextDecoder().decode(plain), 'from core');
    assert.ok(buyer.complete);
  });

  it('refuses blobs from a record whose blob list the root does not commit to', async () => {
    const seller = await FabricDocument.seal('page body '.repeat(60), { chunkBytes: 256 });
    assert.ok(seller.blobTotal >= 2);
    const record = JSON.parse(JSON.stringify(seller.record));
    const bytes = seller.bytesFor(0) as Uint8Array;
    const key = seller.keyFor(0) as string;

    const honest = FabricDocument.fromRecord(record);
    assert.ok(await honest.verifyRoot());
    assert.ok(await honest.acceptBytes(0, bytes));

    const truncated = FabricDocument.fromRecord({ ...record, blobs: record.blobs.slice(0, 1) });
    assert.strictEqual(await truncated.verifyRoot(), false);
    assert.strictEqual(await truncated.acceptBytes(0, bytes), false);
    await assert.rejects(truncated.openBlob(0, key, bytes), /document root/);

    const forged = FabricDocument.fromRecord({ ...record, merkleRootHex: 'ab'.repeat(32) });
    assert.strictEqual(await forged.acceptBytes(0, bytes), false);
  });

  it('inventory items and manifests are hash-only / canonical', async () => {
    const doc = await FabricDocument.seal('x', { chunkBytes: 64 });
    const item = doc.inventoryItem({ rateSats: 2 });
    assert.ok(!('name' in item) && !('url' in item));
    assert.strictEqual(item.perBlob, true);
    assert.strictEqual(item.blobs[0].contentHashHex, doc.record.blobs[0].paymentHashHex);
    const manifest = FabricDocument.decodeManifest(FabricDocument.encodeManifest({ title: 'T', url: 'https://x' }));
    assert.ok(manifest && manifest.type === MANIFEST_TYPE && manifest.title === 'T');
  });
});
