import { swallowNonFatal } from './nonFatal';

/**
 * Last user activity for wallet auto-lock (popup + cross-popup idle).
 * Prefer session storage so it clears when the browser profile session ends; fall back to local.
 */

const FABRIC_LAST_ACTIVITY_MS = 'fabric_last_activity_ms';
/** Plain web / tests without chrome.* */
const DEV_LS_KEY = 'fabric_last_activity_ms_dev';

async function writeLocal (t: number): Promise<void> {
  await chrome.storage.local.set({ [FABRIC_LAST_ACTIVITY_MS]: t });
}

function normalizeActivityTs (ts: number): number {
  return Number.isFinite(ts) && ts >= 0 ? ts : Date.now();
}

export async function touchFabricActivity (ts: number = Date.now()): Promise<void> {
  const t = normalizeActivityTs(ts);
  if (typeof chrome === 'undefined' || !chrome.storage) {
    try {
      localStorage.setItem(DEV_LS_KEY, String(t));
    } catch (err: unknown) {
      swallowNonFatal('fabric-activity-dev-ls', err);
    }
    return;
  }
  try {
    if (chrome.storage.session) {
      await chrome.storage.session.set({ [FABRIC_LAST_ACTIVITY_MS]: t });
      return;
    }
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-session', err);
  }
  try {
    await writeLocal(t);
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-local', err);
  }
}

export async function readFabricActivityMs (): Promise<number | null> {
  if (typeof chrome === 'undefined' || !chrome.storage) {
    try {
      const v = localStorage.getItem(DEV_LS_KEY);
      if (v) {
        const n = parseInt(v, 10);
        if (Number.isFinite(n) && n >= 0) return n;
      }
    } catch (err: unknown) {
      swallowNonFatal('fabric-activity-read-dev-ls', err);
    }
    return null;
  }
  try {
    if (chrome.storage.session) {
      const s = await chrome.storage.session.get(FABRIC_LAST_ACTIVITY_MS);
      const v = s[FABRIC_LAST_ACTIVITY_MS];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
    }
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-read-session', err);
  }
  try {
    const l = await chrome.storage.local.get(FABRIC_LAST_ACTIVITY_MS);
    const v = l[FABRIC_LAST_ACTIVITY_MS];
    if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-read-local', err);
  }
  return null;
}
