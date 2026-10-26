/// <reference types="chrome"/>
'use strict';

import { PASSPORT_MARKER_VERSION } from './constants/siteLogin';
import { swallowNonFatal } from './utils/nonFatal';

/**
 * Tiny script loaded before `content.js`: tells pages which Passport protocol
 * runs here (`data-fabric-passport="2"`). The value is the protocol version,
 * never the extension id, so pages can't fingerprint the install.
 */
try {
  const apply = (): void => {
    document.documentElement?.setAttribute('data-fabric-passport', PASSPORT_MARKER_VERSION);
  };
  if (document.documentElement) apply();
  else document.addEventListener('DOMContentLoaded', apply, { once: true });
} catch (err: unknown) {
  swallowNonFatal('content-marker-init', err);
}
