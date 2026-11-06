'use strict';

/**
 * Extension-origin IndexedDB for the vault and trust lists. Content scripts
 * run as the page, so they cannot open this database. A copy left in
 * `chrome.storage.local` is moved here on the first read and then removed.
 */

const DB_NAME = 'fabric-passport-private';
const STORE = 'kv';

function hasIdb (): boolean {
  return typeof indexedDB !== 'undefined';
}

function openDb (): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet (db: IDBDatabase, key: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbSet (db: IDBDatabase, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(value, key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function idbDelete (db: IDBDatabase, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

async function legacyGet (key: string): Promise<unknown> {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    const bag = await chrome.storage.local.get(key);
    return bag ? bag[key] : undefined;
  }
  if (typeof localStorage === 'undefined') return undefined;
  const raw = localStorage.getItem(key);
  if (raw == null) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function legacyRemove (key: string): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    await chrome.storage.local.remove(key);
  }
  if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
}

async function noteChange (key: string): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.session) return;
  try {
    await chrome.storage.session.set({ 'fabric.private.changed': `${key}:${Date.now()}` });
  } catch {
    /* session storage is absent in some unit tests */
  }
}

/** The value stored under `key`, migrating it out of `chrome.storage.local`. */
export async function privateGet (key: string): Promise<unknown> {
  if (!hasIdb()) return legacyGet(key);
  const db = await openDb();
  const found = await idbGet(db, key);
  if (found !== undefined) return found;
  const legacy = await legacyGet(key);
  if (legacy === undefined) return undefined;
  await idbSet(db, key, legacy);
  await legacyRemove(key);
  return legacy;
}

/** Store `value` where content scripts cannot read it. */
export async function privateSet (key: string, value: unknown): Promise<void> {
  if (!hasIdb()) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ [key]: value });
      return;
    }
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value));
    return;
  }
  const db = await openDb();
  await idbSet(db, key, value);
  await legacyRemove(key);
  await noteChange(key);
}

/** Drop `key` from the private store and from `chrome.storage.local`. */
export async function privateRemove (key: string): Promise<void> {
  if (hasIdb()) {
    const db = await openDb();
    await idbDelete(db, key);
  }
  await legacyRemove(key);
  await noteChange(key);
}
