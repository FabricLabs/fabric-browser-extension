'use strict';

import {
  decodeFabricPaymentRequestHeader,
  parseL402WWWAuthenticate,
  resolveBolt11From402
} from '../utils/fabricHttp402';
import { FABRIC_PAYMENT_REQUEST_HEADER, FABRIC_RUNTIME_PAYMENT_REQUIRED } from '../constants/fabric402';
import { swallowNonFatal } from '../utils/nonFatal';

declare global {
  interface Window {
    __fabric402FetchInstalled?: boolean;
  }
}

/**
 * Wrap `fetch` so 402 responses with a Lightning invoice queue a payment request
 * in Passport (notification + badge; the popup shows and pays it).
 *
 * Runs in the **isolated** content-script world today (needed for chrome.runtime
 * messaging used by sign-in). Page-world `window.fetch` is not patched
 * until a MAIN-world injector (or dual content_scripts entry) lands — see SECURITY.md.
 */
export function installFabric402FetchInterceptor (): void {
  if (typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  if (window.__fabric402FetchInstalled) return;
  window.__fabric402FetchInstalled = true;

  const native = window.fetch.bind(window);

  window.fetch = function fabric402PatchedFetch (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return native(input, init).then((res) => {
      try {
        if (res.status !== 402) return res;

        const rawHeader =
          typeof res.headers.get === 'function' ? res.headers.get(FABRIC_PAYMENT_REQUEST_HEADER) : null;
        const fabricDecoded = decodeFabricPaymentRequestHeader(rawHeader);
        const wwwRaw = typeof res.headers.get === 'function' ? res.headers.get('www-authenticate') : null;
        const l402 = parseL402WWWAuthenticate(wwwRaw);
        const bolt11 = resolveBolt11From402(fabricDecoded, wwwRaw);
        const bolt11Trimmed = typeof bolt11 === 'string' ? bolt11.trim() : '';

        const hasL402Invoice = typeof l402.invoice === 'string' && l402.invoice.trim().startsWith('ln');
        const show =
          fabricDecoded != null ||
          hasL402Invoice ||
          bolt11Trimmed.startsWith('ln');

        if (!show) return res;

        let urlStr = '';
        try {
          if (typeof input === 'string') urlStr = input;
          else if (input instanceof Request) urlStr = input.url;
          else urlStr = String(input);
        } catch (err: unknown) {
          swallowNonFatal('fabric402-fetch-request-url', err);
          urlStr = '';
        }

        const invoice = bolt11Trimmed || (hasL402Invoice ? String(l402.invoice).trim() : '');
        if (!invoice.startsWith('ln') || !chrome.runtime?.sendMessage) return res;
        if (!(navigator.userActivation && navigator.userActivation.isActive)) return res;
        // Only the invoice and its labels leave the page; Passport shows them in its own popup.
        void chrome.runtime.sendMessage({
          type: FABRIC_RUNTIME_PAYMENT_REQUIRED,
          requestUrl: urlStr || window.location.href,
          bolt11: invoice,
          l402: hasL402Invoice,
          fabric: fabricDecoded
            ? { detail: fabricDecoded.detail, invoice: fabricDecoded.invoice, documentOffer: fabricDecoded.documentOffer }
            : null
        }).catch((err: unknown) => swallowNonFatal('fabric402-report', err));
      } catch (err: unknown) {
        swallowNonFatal('fabric402-fetch-interceptor', err);
      }
      return res;
    });
  };
}
