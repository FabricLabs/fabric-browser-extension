'use strict';

import crypto from 'crypto';

/**
 * Deterministic id for a saved Bitcoin or Fabric connection (extension storage).
 * Not `@fabric/core` `Actor#id` and not a Fabric `Message` address.
 */
export function passportNodeListId (content: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return `node${hash.digest('hex').slice(0, 16)}`;
}
