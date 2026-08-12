'use strict';

/** Page → content script `postMessage` source (same as site login). */
export const FABRIC_SITE_POSTMESSAGE_SOURCE = 'fabric-site';

/** Page asks Passport to complete a mutual device-link as responder. */
export const FABRIC_DEVICE_LINK_REQUEST = 'FABRIC_DEVICE_LINK_REQUEST';

/** Passport → page result after approve/reject/error. */
export const FABRIC_DEVICE_LINK_RESULT = 'FABRIC_DEVICE_LINK_RESULT';

/** chrome.storage.session key for a pending device-link offer. */
export const FABRIC_PENDING_DEVICE_LINK_KEY = 'fabric_pending_device_link';

/** Runtime message: content script → background. */
export const FABRIC_RUNTIME_DEVICE_LINK_REQUEST = 'FABRIC_DEVICE_LINK_REQUEST';

/** Runtime message: popup ↔ background for pending device link. */
export const FABRIC_RUNTIME_DEVICE_LINK_GET = 'FABRIC_DEVICE_LINK_GET';
export const FABRIC_RUNTIME_DEVICE_LINK_CLEAR = 'FABRIC_DEVICE_LINK_CLEAR';
export const FABRIC_RUNTIME_DEVICE_LINK_COMPLETE = 'FABRIC_DEVICE_LINK_COMPLETE';
