'use strict';

/**
 * Local roster of mutually linked Fabric devices (Passport).
 * The network proof is IdentityCrossSign / IdentityCrossSignRevoke.
 */

export const LINKED_DEVICES_KEY = 'fabric.linkedDevices';

export type LinkedDevice = {
  kind: string;
  peerFabricId?: string;
  peerXpub?: string;
  peerPubkey?: string;
  pubkey?: string;
  sessionId?: string;
  nonce?: string;
  label?: string;
  hubOrigin?: string;
  linkedAt?: string;
  role?: 'initiator' | 'responder' | string;
};

function storage (): typeof chrome.storage.local | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      return chrome.storage.local;
    }
  } catch (_) { /* ignore */ }
  return null;
}

export function peerIdOf (device: LinkedDevice | null | undefined): string {
  if (!device) return '';
  return String(device.peerFabricId || device.peerPubkey || device.pubkey || '');
}

/**
 * Device-link session a revoke must name (`sessionId`, `nonce`, Hub `origin`), or
 * null for a device linked before links were bound to a session — link it again.
 */
export function linkBindingOf (
  device: LinkedDevice | null | undefined
): { sessionId: string; nonce: string; origin: string } | null {
  if (!device) return null;
  const sessionId = String(device.sessionId || '').toLowerCase();
  const nonce = String(device.nonce || '').toLowerCase();
  let origin = '';
  try {
    origin = new URL(String(device.hubOrigin || '')).origin;
  } catch {
    return null;
  }
  if (!/^[a-f0-9]{48}$/.test(sessionId) || !/^[a-f0-9]{64}$/.test(nonce)) return null;
  return { sessionId, nonce, origin };
}

export async function readLinkedDevices (): Promise<LinkedDevice[]> {
  const st = storage();
  if (!st) return [];
  return await new Promise((resolve) => {
    st.get(LINKED_DEVICES_KEY, (res) => {
      const list = res && res[LINKED_DEVICES_KEY];
      resolve(Array.isArray(list) ? list as LinkedDevice[] : []);
    });
  });
}

export async function writeLinkedDevices (list: LinkedDevice[]): Promise<void> {
  const st = storage();
  if (!st) return;
  await new Promise<void>((resolve) => {
    st.set({ [LINKED_DEVICES_KEY]: Array.isArray(list) ? list : [] }, () => resolve());
  });
}

export async function mergeLinkedDevice (entry: LinkedDevice): Promise<LinkedDevice[]> {
  const list = await readLinkedDevices();
  const id = peerIdOf(entry);
  const next = id
    ? list.filter((d) => peerIdOf(d) !== id)
    : list.filter((d) => !(d && d.kind === entry.kind && d.hubOrigin === entry.hubOrigin));
  next.push(entry);
  await writeLinkedDevices(next);
  return next;
}

export async function removeLinkedDevice (peerFabricId: string): Promise<LinkedDevice[]> {
  const id = String(peerFabricId || '');
  const next = (await readLinkedDevices()).filter((d) => peerIdOf(d) !== id);
  await writeLinkedDevices(next);
  return next;
}
