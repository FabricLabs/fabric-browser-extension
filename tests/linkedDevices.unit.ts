'use strict';

import assert from 'assert';
import {
  mergeLinkedDevice,
  removeLinkedDevice,
  readLinkedDevices,
  writeLinkedDevices,
  peerIdOf,
  LINKED_DEVICES_KEY
} from '../src/utils/linkedDevices';

function mockChromeStorage () {
  const mem: Record<string, unknown> = {};
  (globalThis as { chrome?: unknown }).chrome = {
    storage: {
      local: {
        get (key: string, cb: (res: Record<string, unknown>) => void) {
          cb({ [key]: mem[key] });
        },
        set (obj: Record<string, unknown>, cb: () => void) {
          Object.assign(mem, obj);
          cb();
        }
      }
    }
  };
  return mem;
}

describe('linkedDevices roster', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('merges Passport and Android rows then removes by fabric id', async () => {
    await mergeLinkedDevice({
      kind: 'device-link',
      peerFabricId: 'id1desktop',
      peerPubkey: '02' + 'aa'.repeat(32),
      nonce: 'ab'.repeat(32),
      label: 'Desktop'
    });
    await mergeLinkedDevice({
      kind: 'device-link',
      peerFabricId: 'id1phone',
      peerPubkey: '02' + 'bb'.repeat(32),
      nonce: 'cd'.repeat(32),
      label: 'Android'
    });
    const list = await readLinkedDevices();
    assert.strictEqual(list.length, 2);
    assert.strictEqual(peerIdOf(list[0]), 'id1desktop');
    await removeLinkedDevice('id1desktop');
    const left = await readLinkedDevices();
    assert.strictEqual(left.length, 1);
    assert.strictEqual(left[0].label, 'Android');
    await writeLinkedDevices([]);
    assert.strictEqual((await readLinkedDevices()).length, 0);
    assert.strictEqual(LINKED_DEVICES_KEY, 'fabric.linkedDevices');
  });
});
