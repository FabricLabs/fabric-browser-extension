'use strict';

/**
 * CodeRabbit / PR #3: master key must be exactly 32 bytes (not 32+).
 */

import * as assert from 'assert';
import {
  bindDatastoreToMaster,
  fabricDsGet,
  fabricDsSet,
  setDatastoreMasterKeyFromBytes,
  unbindDatastore
} from '../src/background/encryptedDatastore';

describe('encryptedDatastore master key (PR #3)', function () {
  const local: Record<string, string> = {};
  const session: Record<string, string> = {};

  before(function () {
    (global as any).chrome = {
      storage: {
        local: {
          set (obj: Record<string, string>) {
            Object.assign(local, obj);
            return Promise.resolve();
          },
          get (key: string | null) {
            if (key == null) return Promise.resolve({ ...local });
            return Promise.resolve({ [key]: local[key] });
          },
          remove (key: string) {
            delete local[key];
            return Promise.resolve();
          }
        },
        session: {
          set (obj: Record<string, string>) {
            Object.assign(session, obj);
            return Promise.resolve();
          },
          get (key: string) {
            return Promise.resolve({ [key]: session[key] });
          },
          remove (key: string) {
            delete session[key];
            return Promise.resolve();
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

  it('accepts an exact 32-byte key into session storage', async function () {
    await setDatastoreMasterKeyFromBytes(new ArrayBuffer(32));
    assert.strictEqual(local.fabric_bg_ds_master_key_b64, undefined);
    assert.ok(session['fabric.passport.datastoreKey']);
  });

  it('rewraps rows sealed by the old local key, then fails closed while locked', async function () {
    const old = new Uint8Array(32);
    old[0] = 7;
    const aes = await crypto.subtle.importKey('raw', old.buffer, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(JSON.stringify({ note: 'kept' })));
    const packed = new Uint8Array(iv.length + ct.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(ct), iv.length);
    let binary = '';
    for (let i = 0; i < packed.length; i++) binary += String.fromCharCode(packed[i]);
    local['fabric_ds_enc:note'] = btoa(binary);
    let keyBinary = '';
    for (let i = 0; i < old.length; i++) keyBinary += String.fromCharCode(old[i]);
    local.fabric_bg_ds_master_key_b64 = btoa(keyBinary);

    await bindDatastoreToMaster('xprv-test');
    assert.strictEqual(local.fabric_bg_ds_master_key_b64, undefined);
    assert.deepStrictEqual(await fabricDsGet('note'), { note: 'kept' });

    await unbindDatastore();
    assert.strictEqual(await fabricDsGet('note'), null);
    await assert.rejects(() => fabricDsSet('note', { note: 'no' }), /locked/);
  });
});
