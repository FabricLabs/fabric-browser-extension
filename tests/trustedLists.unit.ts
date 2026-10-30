'use strict';

import assert from 'assert';
import { readTrustedList, writeTrustedList } from '../src/utils/trustedLists';
import { recordMacKey } from '../src/utils/recordSeal';

const KEY = 'fabric.hub.allowlist';

describe('trusted lists', function () {
  let local: Record<string, unknown>;

  beforeEach(function () {
    local = {};
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        local: {
          get: async (k: string) => (k in local ? { [k]: local[k] } : {}),
          set: async (v: Record<string, unknown>) => { Object.assign(local, v); }
        }
      }
    };
  });

  afterEach(function () {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('reads back only what was sealed with this master', async function () {
    const mine = await recordMacKey('xprv-mine');
    const theirs = await recordMacKey('xprv-theirs');
    await writeTrustedList(KEY, ['https://hub.example.org', '*.example.org'], mine);
    assert.deepStrictEqual(await readTrustedList(KEY, mine), ['https://hub.example.org', '*.example.org']);
    assert.deepStrictEqual(await readTrustedList(KEY, theirs), []);
  });

  it('treats a plain or edited list as empty, and a locked Passport as no list', async function () {
    const mine = await recordMacKey('xprv-mine');
    local[KEY] = ['https://evil.example'];
    assert.deepStrictEqual(await readTrustedList(KEY, mine), []);
    await writeTrustedList(KEY, ['https://hub.example.org'], mine);
    (local[KEY] as { data: string[] }).data.push('https://evil.example');
    assert.deepStrictEqual(await readTrustedList(KEY, mine), []);
    assert.deepStrictEqual(await readTrustedList(KEY, null), []);
    await assert.rejects(() => writeTrustedList(KEY, ['https://x.example'], null), /Unlock Passport/);
  });
});
