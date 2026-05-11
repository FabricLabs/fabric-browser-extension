'use strict';

import {
  decodeFabricPaymentRequestHeader,
  parseL402WWWAuthenticate,
  resolveBolt11From402
} from '../utils/fabricHttp402';
import { FABRIC_PAYMENT_REQUEST_HEADER } from '../constants/fabric402';
import { showFabric402Overlay } from './fabric402OverlayDom';

declare global {
  interface Window {
    __fabric402FetchInstalled?: boolean;
  }
}

/**
 * Wrap `fetch` so 402 responses with Fabric payment headers prompt the Passport UI.
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
        } catch (_) {
          urlStr = '';
        }

        queueMicrotask(() => {
          showFabric402Overlay({
            requestUrl: urlStr || window.location.href,
            fabric: fabricDecoded,
            bolt11: bolt11Trimmed || undefined,
            wwwAuthenticate: wwwRaw
          });
        });
      } catch (_) {
        // never break callers
      }
      return res;
    });
  };
}
