'use strict';

/**
 * Background side of `fabric:` site login: queue page requests for the popup,
 * and carry a desktop-signed login back to the page (or the Hub session) so the
 * answer survives the popup closing while the user approves on the desktop.
 */

import {
  FABRIC_MESSAGE_PAGE_RESULT,
  FABRIC_PENDING_SITE_LOGIN_KEY,
  FABRIC_SITE_LOGIN_PAGE_RESULT
} from '../constants/siteLogin';
import {
  checkHubLoginChallenge,
  originOfSender,
  readPageSiteLoginRequest,
  verifyDesktopSiteLogin
} from '../utils/fabricSiteMessage';
import { requestDesktopSignature } from '../utils/fabricDesktopSigner';
import { postFabricSiteLogin } from '../utils/fabricSiteLoginSign';
import { swallowNonFatal } from '../utils/nonFatal';

export type PendingSiteLoginRow = {
  /** `hub-login`: legacy `/sessions` challenge; `fabric`: a page `fabric:` `SiteLoginRequest`. */
  kind: 'hub-login' | 'fabric';
  origin: string;
  pageOrigin: string;
  nonce: string;
  createdAt: number;
  tabId?: number;
  frameId?: number;
  sessionId: string;
  hubBase: string;
  message: string;
  requestId?: string;
  requestUri?: string;
  purpose?: string | null;
  expiresAt?: number;
  siteAuthor?: string | null;
};

type Outcome = { ok: true; row: PendingSiteLoginRow } | { ok: false; error: string };

function pendingStore (): chrome.storage.StorageArea {
  return chrome.storage.session || chrome.storage.local;
}

export async function readPendingSiteLogin (): Promise<PendingSiteLoginRow | null> {
  const got = await pendingStore().get(FABRIC_PENDING_SITE_LOGIN_KEY);
  return ((got && got[FABRIC_PENDING_SITE_LOGIN_KEY]) as PendingSiteLoginRow | undefined) || null;
}

export async function writePendingSiteLogin (row: PendingSiteLoginRow): Promise<void> {
  await pendingStore().set({ [FABRIC_PENDING_SITE_LOGIN_KEY]: row });
}

export async function clearPendingSiteLogin (): Promise<void> {
  await pendingStore().remove(FABRIC_PENDING_SITE_LOGIN_KEY);
}

/** Legacy `/sessions` login: the challenge must name this page's session and origin. */
export function queueHubLogin (m: Record<string, unknown>, sender: chrome.runtime.MessageSender): Outcome {
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId.trim() : '';
  const hubBase = typeof m.hubBase === 'string' ? m.hubBase.trim() : '';
  const claimed = typeof m.origin === 'string' ? m.origin.trim() : '';
  const loginMessage = typeof m.message === 'string' ? m.message : '';
  const origin = originOfSender(sender);
  if (!sessionId || !hubBase || !loginMessage || !origin) return { ok: false, error: 'invalid_site_login' };
  if (claimed !== origin) return { ok: false, error: 'origin_mismatch' };
  const challenge = checkHubLoginChallenge(loginMessage, { sessionId, origin });
  if (!challenge.ok) return { ok: false, error: challenge.error };
  return {
    ok: true,
    row: {
      kind: 'hub-login',
      sessionId,
      hubBase,
      origin,
      message: loginMessage,
      nonce: challenge.nonce,
      pageOrigin: origin,
      createdAt: Date.now(),
      tabId: sender.tab?.id,
      frameId: sender.frameId
    }
  };
}

/** Page `fabric:` `SiteLoginRequest`, bound to the frame's real origin. */
export function queueFabricMessage (m: Record<string, unknown>, sender: chrome.runtime.MessageSender): Outcome {
  const origin = originOfSender(sender);
  if (!origin) return { ok: false, error: 'origin_unknown' };
  const read = readPageSiteLoginRequest(m.message, origin);
  if (!read.ok) return { ok: false, error: read.error };
  const r = read.request;
  return {
    ok: true,
    row: {
      kind: 'fabric',
      origin: r.origin,
      pageOrigin: r.origin,
      nonce: r.nonce,
      purpose: r.purpose,
      expiresAt: r.expiresAt,
      siteAuthor: r.siteAuthor,
      requestUri: r.requestUri,
      requestId: typeof m.id === 'string' ? m.id.slice(0, 128) : '',
      sessionId: '',
      hubBase: '',
      message: '',
      createdAt: Date.now(),
      tabId: sender.tab?.id,
      frameId: sender.frameId
    }
  };
}

/** Send a result to the frame that asked (and only if it still has that origin). */
export function notifySiteLoginPage (row: PendingSiteLoginRow, payload: Record<string, unknown>): void {
  if (row.tabId == null) return;
  const message = row.kind === 'fabric'
    ? { type: FABRIC_MESSAGE_PAGE_RESULT, origin: row.origin, id: row.requestId || '', ...payload }
    : { type: FABRIC_SITE_LOGIN_PAGE_RESULT, origin: row.origin, sessionId: row.sessionId, ...payload };
  const sent = typeof row.frameId === 'number'
    ? chrome.tabs.sendMessage(row.tabId, message, { frameId: row.frameId })
    : chrome.tabs.sendMessage(row.tabId, message);
  void Promise.resolve(sent).catch((err: unknown) => swallowNonFatal('site-login-page-result', err));
}

/**
 * Popup asked a linked desktop app to sign the pending login. Runs here so the
 * answer is delivered even after the popup closes.
 */
export async function completeWithDesktop (m: Record<string, unknown>): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = await readPendingSiteLogin();
  if (!row) return { ok: false, error: 'no pending sign-in' };
  const base = typeof m.base === 'string' ? m.base : '';
  const signRequestUri = typeof m.signRequestUri === 'string' ? m.signRequestUri : '';
  const desktopPubkey = typeof m.desktopPubkey === 'string' ? m.desktopPubkey : '';
  const expiresAt = Number(m.expiresAt);
  if (!base || !signRequestUri || !desktopPubkey || !Number.isFinite(expiresAt)) {
    return { ok: false, error: 'invalid desktop sign request' };
  }
  if (typeof m.nonce === 'string' && m.nonce !== row.nonce) return { ok: false, error: 'the pending sign-in changed' };

  const answered = await requestDesktopSignature({ base, signRequestUri, expiresAt });
  if (!answered.ok) return { ok: false, error: answered.error };
  const verified = verifyDesktopSiteLogin(answered.uri, { origin: row.origin, nonce: row.nonce, pubkey: desktopPubkey });
  if (!verified.ok) return { ok: false, error: verified.error };

  if (row.kind === 'hub-login') {
    const posted = await postFabricSiteLogin(row.hubBase, row.sessionId, answered.uri);
    if (!posted.ok) return { ok: false, error: posted.error };
    notifySiteLoginPage(row, { ok: true, identity: { id: verified.identity.id, xpub: verified.identity.xpub } });
  } else {
    notifySiteLoginPage(row, { ok: true, message: answered.uri, signer: verified.signer });
  }
  await clearPendingSiteLogin();
  return { ok: true };
}
