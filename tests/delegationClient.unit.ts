'use strict';

import assert from 'assert';
import { normalizeDelegateBase, parseDelegateBases } from '../src/utils/delegationClient';

describe('delegation client bases', function () {
  it('keeps loopback http(s) and drops everything else', function () {
    assert.strictEqual(normalizeDelegateBase('8080'), 'http://127.0.0.1:8080');
    assert.strictEqual(normalizeDelegateBase('http://localhost:3041/'), 'http://localhost:3041');
    assert.strictEqual(normalizeDelegateBase('https://hub.fabric.pub'), null);
    assert.strictEqual(normalizeDelegateBase('http://user:pw@127.0.0.1:8080'), null);
  });

  it('parses a list and drops duplicates', function () {
    assert.deepStrictEqual(
      parseDelegateBases('8080, http://127.0.0.1:8080 https://evil.example'),
      ['http://127.0.0.1:8080']
    );
  });
});
