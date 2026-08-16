'use strict';

/**
 * CodeRabbit / PR #3: master key must be exactly 32 bytes (not 32+).
 */

import * as assert from 'assert';
import { setDatastoreMasterKeyFromBytes } from '../src/background/encryptedDatastore';

describe('encryptedDatastore master key (PR #3)', function () {
  const store: Record<string, string> = {};

  before(function () {
    (global as any).chrome = {
      storage: {
        local: {
          set (obj: Record<string, string>) {
            Object.assign(store, obj);
            return Promise.resolve();
          },
          get (key: string) {
            return Promise.resolve({ [key]: store[key] });
          }
        }
      }
    };
  });

  it('rejects keys that are not exactly 32 bytes', async function () {
    await assert.rejects(
      () => setDatastoreMasterKeyFromBytes(new ArrayBuffer(16)),
      /32 bytes/
    );
    await assert.rejects(
      () => setDatastoreMasterKeyFromBytes(new ArrayBuffer(64)),
      /32 bytes/
    );
  });

  it('accepts an exact 32-byte key', async function () {
    await setDatastoreMasterKeyFromBytes(new ArrayBuffer(32));
  });
});
