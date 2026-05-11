/// <reference types="chrome"/>
'use strict';

import { swallowNonFatal } from './utils/nonFatal';

/**
 * Tiny script loaded before `content.js` so E2E/tests can detect injection even if the
 * main bundle is slow or fails during initialization (WASM, interceptors, etc.).
 */
try {
  const v = chrome.runtime.id;
  const apply = (): void => {
    document.documentElement?.setAttribute('data-fabric-passport', v);
  };
  if (document.documentElement) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
} catch (err: unknown) {
  swallowNonFatal('content-marker-init', err);
}
