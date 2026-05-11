'use strict';

/**
 * When `FABRIC_HUB_BASE_URL` is set (e.g. `http://127.0.0.1:8080` from `@fabric/http` `npm run sample:hub` or a full Hub), UI tests can load mesh bridge on that origin. Use the **same** host form you resolve in the browser (127.0.0.1 vs localhost) — `pageOrigin` must match `hubAddress`’s origin.
 */
export function getHubMeshPageUrl (): string | null {
  const raw = process.env.FABRIC_HUB_BASE_URL?.trim();
  if (!raw) return null;
  const base = raw.replace(/\/$/, '/');
  const rel = (process.env.FABRIC_HUB_MESH_PATH || 'hub-mesh-bridge.html').replace(/^\//, '');
  try {
    return new URL(rel, base).href;
  } catch (err: unknown) {
    void err;
    return null;
  }
}
