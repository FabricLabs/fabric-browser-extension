/**
 * Runs inside the offscreen document: WebSocket signaling + placeholder RTCPeerConnection map for Fabric mesh.
 */
import {
  fabricSignalingWebSocketUrl,
  createFabricPeerConnection
} from '../fabric/fabricWebRTCPeering';
import { tryParseNotifiableMessage } from '../fabric/messageTypes';

type MeshToBgMessage =
  | { type: 'MESH_READY' }
  | { type: 'MESH_SIGNALING'; event: 'open' | 'close' | 'error' | 'message'; hubAddress: string; detail?: string }
  | { type: 'FABRIC_NODE_MESSAGE'; nodeAddress: string; messageType: string; payload: Record<string, unknown> };

function notifyBg (msg: MeshToBgMessage): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch (_) {}
}

let ws: WebSocket | null = null;
let hubAddressActive: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
/** Reserved for upcoming fabric-webrtc-v2 signaling exchanges. */
const peerConnections = new Map<string, RTCPeerConnection>();

function clearReconnect (): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect (): void {
  clearReconnect();
  if (!hubAddressActive) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (hubAddressActive) startMeshSignaling(hubAddressActive);
  }, 5000);
}

export function stopMeshSignaling (): void {
  hubAddressActive = null;
  clearReconnect();
  if (ws) {
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch (_) {}
    ws = null;
  }
  for (const [, pc] of peerConnections) {
    try {
      pc.close();
    } catch (_) {}
  }
  peerConnections.clear();
}

export function startMeshSignaling (hubAddress: string): void {
  stopMeshSignaling();
  hubAddressActive = hubAddress;
  const url = fabricSignalingWebSocketUrl(hubAddress, '/');
  if (!url) {
    notifyBg({ type: 'MESH_SIGNALING', event: 'error', hubAddress, detail: 'Invalid hub address' });
    return;
  }

  try {
    const socket = new WebSocket(url);
    ws = socket;

    socket.onopen = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'open', hubAddress });
    };

    socket.onclose = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'close', hubAddress });
      ws = null;
      if (hubAddressActive === hubAddress) scheduleReconnect();
    };

    socket.onerror = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'error', hubAddress });
    };

    socket.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : '';
      const detail = raw ? raw.slice(0, 200) : `binary:${(ev.data as ArrayBuffer).byteLength}`;
      notifyBg({ type: 'MESH_SIGNALING', event: 'message', hubAddress, detail });

      if (raw) {
        const parsed = tryParseNotifiableMessage(raw);
        if (parsed) {
          notifyBg({ type: 'FABRIC_NODE_MESSAGE', nodeAddress: hubAddress, messageType: parsed.messageType, payload: parsed.payload });
        }
      }
    };
  } catch (e) {
    notifyBg({
      type: 'MESH_SIGNALING',
      event: 'error',
      hubAddress,
      detail: e instanceof Error ? e.message : 'WebSocket error'
    });
    scheduleReconnect();
  }
}

/**
 * Create a tracked RTCPeerConnection for a logical peer id (signaling to be wired to Hub WebSocket).
 */
export function meshEnsurePeerConnection (peerId: string): RTCPeerConnection {
  let pc = peerConnections.get(peerId);
  if (pc) return pc;
  pc = createFabricPeerConnection();
  peerConnections.set(peerId, pc);
  pc.addEventListener('connectionstatechange', () => {
    if (pc?.connectionState === 'failed' || pc?.connectionState === 'closed') {
      peerConnections.delete(peerId);
    }
  });
  return pc;
}

export function meshDropPeerConnection (peerId: string): void {
  const pc = peerConnections.get(peerId);
  if (pc) {
    try {
      pc.close();
    } catch (_) {}
    peerConnections.delete(peerId);
  }
}
