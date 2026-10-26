'use strict';

import assert from 'assert';
import {
  readFabricActivityMs,
  touchFabricActivity
} from '../src/utils/fabricActivityStorage';

describe('fabricActivityStorage (auto-lock timestamps)', function () {
  const DEV_LS_KEY = 'fabric_last_activity_ms_dev';
  const mem: Record<string, string> = {};

  beforeEach(function () {
    delete (globalThis as { chrome?: unknown }).chrome;
    Object.keys(mem).forEach((k) => delete mem[k]);
    (globalThis as { localStorage?: Storage }).localStorage = {
      getItem (key: string) {
        return Object.prototype.hasOwnProperty.call(mem, key) ? mem[key] : null;
      },
      setItem (key: string, value: string) {
        mem[key] = String(value);
      },
      removeItem (key: string) {
        delete mem[key];
      },
      clear () {
        Object.keys(mem).forEach((k) => delete mem[k]);
      },
      key () {
        return null;
      },
      length: 0
    } as Storage;
  });

  afterEach(function () {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it('rejects epoch 0 on write and falls back to Date.now()', async function () {
    const before = Date.now();
    await touchFabricActivity(0);
    const stored = await readFabricActivityMs();
    assert.ok(stored != null && stored >= before);
  });

  it('reads an invalid stored value as expired (0), not as missing', async function () {
    mem[DEV_LS_KEY] = '0';
    assert.strictEqual(await readFabricActivityMs(), 0);
    mem[DEV_LS_KEY] = '-1';
    assert.strictEqual(await readFabricActivityMs(), 0);
    mem[DEV_LS_KEY] = 'junk';
    assert.strictEqual(await readFabricActivityMs(), 0);
  });

  it('returns null when no timestamp is stored', async function () {
    assert.strictEqual(await readFabricActivityMs(), null);
  });

  it('falls back from an invalid session stamp to a valid local one', async function () {
    const t = Date.now() - 1000;
    const area = (data: Record<string, unknown>) => ({
      get: async (key: string) => (key in data ? { [key]: data[key] } : {}),
      set: async () => {}
    });
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: area({ fabric_last_activity_ms: 0 }),
        local: area({ fabric_last_activity_ms: t })
      }
    };
    assert.strictEqual(await readFabricActivityMs(), t);
    (globalThis as { chrome?: unknown }).chrome = {
      storage: {
        session: area({ fabric_last_activity_ms: 0 }),
        local: area({})
      }
    };
    assert.strictEqual(await readFabricActivityMs(), 0);
  });

  it('round-trips a positive timestamp', async function () {
    const t = Date.now() - 60_000;
    await touchFabricActivity(t);
    assert.strictEqual(await readFabricActivityMs(), t);
  });
});
