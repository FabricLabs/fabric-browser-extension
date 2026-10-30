'use strict';

/** Must match `@fabric/http` middlewares (`functions/fabricDocumentPayment402.js`). */
export const FABRIC_PAYMENT_REQUEST_HEADER = 'x-fabric-payment-request';

/** Content script → background: a page got a 402 with a payment hint. */
export const FABRIC_RUNTIME_PAYMENT_REQUIRED = 'FABRIC_PAYMENT_REQUIRED';
/** Extension pages only: list, pay, or dismiss queued payment requests. */
export const FABRIC_PAYMENTS_LIST = 'FABRIC_PAYMENTS_LIST';
export const FABRIC_PAYMENT_PAY = 'FABRIC_PAYMENT_PAY';
export const FABRIC_PAYMENT_DISMISS = 'FABRIC_PAYMENT_DISMISS';
/** chrome.storage.session: queued payment requests (one per site). */
export const FABRIC_PENDING_PAYMENTS_KEY = 'fabric.payments.pending';
/** Notification id prefix for a queued payment request. */
export const PAYMENT_NOTIFICATION_PREFIX = 'passport-payment:';
