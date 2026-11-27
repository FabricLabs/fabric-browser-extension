'use strict';

/**
 * HTTP 402 payment hints from pages. The content script only reports what the
 * page answered; the request waits here (one per site, in session storage)
 * behind a notification and the badge, and the popup shows and pays it. A
 * page can never ask Passport to pay by itself.
 */

import {
  FABRIC_PENDING_PAYMENTS_KEY,
  PAYMENT_NOTIFICATION_PREFIX
} from '../constants/fabric402';
import { originOfSender, originOfUrl } from '../utils/fabricSiteMessage';
import { frameAncestorsOk } from './fabricSiteLoginRuntime';
import { swallowNonFatal } from '../utils/nonFatal';
import { attemptPayBolt11ViaActiveFabricNode, type PassportBolt11PayResult } from './passportBolt11Pay';

export type PaymentRequest = {
  id: string;
  origin: string;
  requestUrl: string;
  bolt11: string;
  detail: string | null;
  amount: string | null;
  priceSats: number | null;
  l402: boolean;
  receivedAt: number;
  expiresAt: number;
};

const MAX_PENDING = 8;
const TTL_MS = 30 * 60 * 1000;
const BOLT11 = /^ln[a-z0-9]{10,4096}$/i;

function text (value: unknown, max: number): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function randomId (): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * A request from a content script's message, or null when it isn't one Passport
 * shows: not the top frame, not an http(s) page, or no BOLT11 invoice.
 */
export function readPaymentRequest (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  now: number = Date.now()
): PaymentRequest | null {
  if (!sender || !sender.tab || (sender.frameId != null && sender.frameId !== 0)) return null;
  const origin = originOfSender(sender);
  if (!origin || !/^https?:/.test(origin)) return null;
  const bolt11 = String(message.bolt11 || '').trim();
  if (!BOLT11.test(bolt11)) return null;
  const requestUrl = text(message.requestUrl, 2048) || origin;
  const fabric = message.fabric && typeof message.fabric === 'object' ? message.fabric as Record<string, unknown> : {};
  const invoice = fabric.invoice && typeof fabric.invoice === 'object' ? fabric.invoice as Record<string, unknown> : {};
  const offer = fabric.documentOffer && typeof fabric.documentOffer === 'object' ? fabric.documentOffer as Record<string, unknown> : {};
  const amount = invoice.amount != null ? `${text(invoice.amount, 32)} ${text(invoice.currency, 8) || 'BTC'}` : null;
  const price = Number(offer.purchasePriceSats);
  return {
    id: randomId(),
    origin,
    requestUrl: originOfUrl(requestUrl) ? requestUrl : origin,
    bolt11,
    detail: text(fabric.detail, 280),
    amount,
    priceSats: Number.isFinite(price) && price > 0 ? Math.round(price) : null,
    l402: message.l402 === true,
    receivedAt: now,
    expiresAt: now + TTL_MS
  };
}

/** Queue `next`, replacing an earlier request from its site; newest first, at most 8. */
export function queuePayment (list: PaymentRequest[], next: PaymentRequest, now: number = Date.now()): PaymentRequest[] {
  const kept = list.filter((r) => r && r.origin !== next.origin && r.expiresAt > now);
  return [next, ...kept].slice(0, MAX_PENDING);
}

export async function pendingPayments (): Promise<PaymentRequest[]> {
  if (!chrome.storage.session) return [];
  const got = await chrome.storage.session.get(FABRIC_PENDING_PAYMENTS_KEY);
  const list = got && Array.isArray(got[FABRIC_PENDING_PAYMENTS_KEY]) ? got[FABRIC_PENDING_PAYMENTS_KEY] as PaymentRequest[] : [];
  const now = Date.now();
  return list.filter((r) => r && r.expiresAt > now);
}

async function savePayments (list: PaymentRequest[]): Promise<void> {
  if (chrome.storage.session) await chrome.storage.session.set({ [FABRIC_PENDING_PAYMENTS_KEY]: list });
}

const PAYMENT_NOTIFY_GAP_MS = 30_000;
const lastPaymentNotify = new Map<string, number>();

/** Queue a page's payment request and tell the user; `refreshBadge` recounts. */
export async function receivePaymentRequest (
  message: Record<string, unknown>,
  sender: chrome.runtime.MessageSender,
  refreshBadge: () => Promise<void>
): Promise<boolean> {
  const request = readPaymentRequest(message, sender);
  if (!request) return false;
  if (!(await frameAncestorsOk(sender))) return false;
  const before = await pendingPayments();
  for (const old of before.filter((r) => r.origin === request.origin)) {
    try { chrome.notifications.clear(`${PAYMENT_NOTIFICATION_PREFIX}${old.id}`); } catch (err: unknown) { swallowNonFatal('payment-notify-clear', err); }
  }
  await savePayments(queuePayment(before, request));
  const now = Date.now();
  const prev = lastPaymentNotify.get(request.origin) || 0;
  if (now - prev >= PAYMENT_NOTIFY_GAP_MS) {
    lastPaymentNotify.set(request.origin, now);
    try {
      chrome.notifications.create(`${PAYMENT_NOTIFICATION_PREFIX}${request.id}`, {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: 'Payment requested',
        message: `${new URL(request.origin).host} asks for a Lightning payment. Open Passport to review it.`,
        priority: 1
      });
    } catch (err: unknown) {
      swallowNonFatal('payment-notify', err);
    }
  }
  await refreshBadge();
  return true;
}

/** Drop a queued request. */
export async function dismissPayment (id: string, refreshBadge: () => Promise<void>): Promise<void> {
  const list = await pendingPayments();
  await savePayments(list.filter((r) => r.id !== id));
  try { chrome.notifications.clear(`${PAYMENT_NOTIFICATION_PREFIX}${id}`); } catch (err: unknown) { swallowNonFatal('payment-notify-clear', err); }
  await refreshBadge();
}

/** Pay a queued request through the active Fabric node; it leaves the queue once paid. */
export async function payPayment (id: string, refreshBadge: () => Promise<void>): Promise<PassportBolt11PayResult> {
  const request = (await pendingPayments()).find((r) => r.id === id);
  if (!request) return { ok: false, message: 'That payment request is gone or expired.' };
  const result = await attemptPayBolt11ViaActiveFabricNode(request.bolt11);
  if (result.ok) await dismissPayment(id, refreshBadge);
  return result;
}
