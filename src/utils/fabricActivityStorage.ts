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

/** Reject epoch 0 / negative values — same guard as suite chat `created` stamps. */
function positiveEpochMs (value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}

function normalizeActivityTs (ts: number): number {
  return positiveEpochMs(ts) ?? Date.now();
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

/**
 * Last activity in epoch ms; `null` when nothing is stored, `0` when only an invalid
 * stamp is stored (callers must treat it as expired, i.e. lock).
 */
export async function readFabricActivityMs (): Promise<number | null> {
  let invalid = false;
  if (typeof chrome === 'undefined' || !chrome.storage) {
    try {
      const v = localStorage.getItem(DEV_LS_KEY);
      if (v != null) {
        const n = parseInt(v, 10);
        const ts = positiveEpochMs(n);
        if (ts != null) return ts;
        invalid = true;
      }
    } catch (err: unknown) {
      swallowNonFatal('fabric-activity-read-dev-ls', err);
    }
    return invalid ? 0 : null;
  }
  try {
    if (chrome.storage.session) {
      const s = await chrome.storage.session.get(FABRIC_LAST_ACTIVITY_MS);
      const v = s[FABRIC_LAST_ACTIVITY_MS];
      if (v != null) {
        const ts = typeof v === 'number' ? positiveEpochMs(v) : null;
        if (ts != null) return ts;
        invalid = true;
      }
    }
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-read-session', err);
  }
  try {
    const l = await chrome.storage.local.get(FABRIC_LAST_ACTIVITY_MS);
    const v = l[FABRIC_LAST_ACTIVITY_MS];
    if (v != null) {
      const ts = typeof v === 'number' ? positiveEpochMs(v) : null;
      if (ts != null) return ts;
      invalid = true;
    }
  } catch (err: unknown) {
    swallowNonFatal('fabric-activity-read-local', err);
  }
  return invalid ? 0 : null;
}
