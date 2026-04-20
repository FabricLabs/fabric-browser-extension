/**
 * Browser-side helpers for Fabric Protocol WebRTC peering.
 * Matches hub.fabric.pub Bridge conventions: signaling over Hub WebSocket (`wss://host:port/`)
 * and SDP/ICE envelopes tagged with `fabric-webrtc-v2` metadata.
 */

export const FABRIC_WEBRTC_SIGNAL_PROTOCOL = 'fabric-webrtc-v2' as const;

export interface FabricWebRTCSignalMeta {
  protocol: typeof FABRIC_WEBRTC_SIGNAL_PROTOCOL;
  sessionId: string;
  targetSessionId: string | null;
  revision: number;
}

export interface ParsedFabricHubAddress {
  host: string;
  port: number;
  secure: boolean;
  /** e.g. wss://hub.fabric.pub:443 */
  wsOrigin: string;
  raw: string;
}

/**
 * Parse a Hub base URL the same way as hub `Bridge._parseHubAddressString` (HTTP(S) → WS(S)).
 */
export function parseFabricHubAddress (input: string): ParsedFabricHubAddress | null {
  try {
    const raw = input == null ? '' : String(input).trim();
    if (!raw) return null;

    const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw);
    const url = new URL(hasScheme ? raw : `https://${raw}`);

    const proto = (url.protocol || '').replace(':', '');
    const secure = proto === 'https' || proto === 'wss';
    const host = url.hostname;
    const port = url.port ? Number(url.port) : (secure ? 443 : 80);
    if (!host || !port || Number.isNaN(port)) return null;

    const wsOrigin = (secure ? 'wss' : 'ws') + `://${host}:${port}`;
    return { host, port, secure, wsOrigin, raw };
  } catch {
    return null;
  }
}

export function fabricSignalingWebSocketUrl (hubAddress: string, path = '/'): string | null {
  const p = parseFabricHubAddress(hubAddress);
  if (!p) return null;
  const pathNorm = path.startsWith('/') ? path : `/${path}`;
  return `${p.wsOrigin}${pathNorm}`;
}

/**
 * Attach monotonic revision + session ids for Bridge-compatible signaling (see `bridge.webrtc.signal.test.js`).
 */
export function attachFabricSignalMeta<T extends object> (
  session: { localSessionId: string; remoteSessionId: string | null; localSignalRevision: number },
  payload: T
): T & { _fabric: FabricWebRTCSignalMeta } {
  session.localSignalRevision += 1;
  return {
    ...payload,
    _fabric: {
      protocol: FABRIC_WEBRTC_SIGNAL_PROTOCOL,
      sessionId: session.localSessionId,
      targetSessionId: session.remoteSessionId,
      revision: session.localSignalRevision
    }
  };
}

/** Default STUN for ICE gathering when connecting out from the extension. */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Create an {@link RTCPeerConnection} for Fabric data-channel peering (signaling still via Hub WebSocket).
 */
export function createFabricPeerConnection (iceServers?: RTCIceServer[]): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: iceServers ?? DEFAULT_ICE_SERVERS
  });
}

export interface FabricSignalingTestOk {
  url: string;
  subprotocol: string;
}

/**
 * Verify that the Hub WebSocket signaling endpoint accepts a connection, then close.
 */
export function testFabricSignalingReachable (
  hubAddress: string,
  path = '/',
  timeoutMs = 8000
): Promise<FabricSignalingTestOk> {
  const url = fabricSignalingWebSocketUrl(hubAddress, path);
  if (!url) return Promise.reject(new Error('Invalid Fabric hub address'));

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = window.setTimeout(() => {
      try {
        ws.close();
      } catch (_) {}
      reject(new Error('WebSocket open timed out'));
    }, timeoutMs);

    ws.onopen = () => {
      window.clearTimeout(t);
      const subprotocol = ws.protocol || '(negotiated)';
      try {
        ws.close();
      } catch (_) {}
      resolve({ url, subprotocol });
    };

    ws.onerror = () => {
      window.clearTimeout(t);
      reject(new Error('WebSocket connection failed'));
    };
  });
}
