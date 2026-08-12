'use strict';

/**
 * Origins the user has explicitly trusted via **Connect & register** to an active Hub/Fabric node
 * (same flow that registers `RegisterWebRTCPeer` metadata on the node).
 * Used only to attach `X-Fabric-Identity` and traffic metrics, not to ship keys to random sites.
 */
export const FABRIC_TRUSTED_HTTP_ORIGINS_KEY = 'fabric_trusted_http_origins';

/** DeclarativeNetRequest dynamic rule ids reserved for @fabric/passport (identity header). */
export const DNR_IDENTITY_HEADER_RULE_ID_MIN = 100;
export const DNR_IDENTITY_HEADER_RULE_ID_MAX = 199;

export const X_FABRIC_IDENTITY = 'X-Fabric-Identity';
