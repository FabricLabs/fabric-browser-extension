'use strict';

const assert = require('assert');
const { Buffer: Polyfill } = require('../shims/buffer.browser.js');

describe('shims/buffer.browser (base64url)', () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from([0xfb, 0xff, 0xfe]),
    Buffer.from('fabric frame bytes ?>~', 'utf8'),
    Buffer.from(Array.from({ length: 257 }, (_, i) => i & 0xff))
  ];

  it('encodes like Node', () => {
    for (const sample of samples) {
      assert.strictEqual(Polyfill.from(sample).toString('base64url'), sample.toString('base64url'));
    }
  });

  it('decodes like Node, with or without padding', () => {
    for (const sample of samples) {
      const text = sample.toString('base64url');
      assert.ok(Buffer.from(Polyfill.from(text, 'base64url')).equals(sample));
      assert.ok(Buffer.from(Polyfill.from(sample.toString('base64'), 'base64url')).equals(sample));
      assert.strictEqual(Polyfill.byteLength(text, 'base64url'), sample.length);
    }
  });

  it('reports the encoding and leaves the others alone', () => {
    assert.strictEqual(Polyfill.isEncoding('base64url'), true);
    assert.strictEqual(Polyfill.isEncoding('nope'), false);
    assert.strictEqual(Polyfill.from('hi').toString('hex'), '6869');
    assert.strictEqual(Polyfill.from('aGk=', 'base64').toString(), 'hi');
  });
});
