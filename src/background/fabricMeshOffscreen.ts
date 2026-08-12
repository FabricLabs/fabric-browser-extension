/**
 * Runs inside the offscreen document: WebSocket signaling + RTCPeerConnection mesh
 * for Fabric browser peers (RegisterWebRTCPeer / ListWebRTCPeers / SendWebRTCSignal /
 * RelayFromWebRTC). Prefers binary AMP on data channels — no HTTP for mesh traffic.
 */
import Message from '@fabric/core/types/message';
import {
  fabricSignalingWebSocketUrl,
  createFabricPeerConnection,
  attachFabricSignalMeta,
  FABRIC_WEBRTC_SIGNAL_PROTOCOL
} from '../fabric/fabricWebRTCPeering';
import { tryParseNotifiableFabricFrame } from '../fabric/fabricWireNotify';
import { swallowNonFatal } from '../utils/nonFatal';

type MeshToBgMessage =
  | { type: 'MESH_READY' }
  | { type: 'MESH_SIGNALING'; event: 'open' | 'close' | 'error' | 'message'; hubAddress: string; detail?: string }
  | { type: 'MESH_PEER'; event: 'connected' | 'disconnected'; peerId: string; hubAddress: string }
  | { type: 'FABRIC_NODE_MESSAGE'; nodeAddress: string; messageType: string; payload: Record<string, unknown> };

function notifyBg (msg: MeshToBgMessage): void {
  try {
    void chrome.runtime.sendMessage(msg);
  } catch (err: unknown) {
    swallowNonFatal('mesh-notify-bg', err);
  }
}

let ws: WebSocket | null = null;
let hubAddressActive: string | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let discoverTimer: ReturnType<typeof setInterval> | null = null;
let localPeerId: string | null = null;

interface PeerEntry {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  initiator: boolean;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  localSessionId: string;
  remoteSessionId: string | null;
  localSignalRevision: number;
  remoteSignalRevision: number;
  signalQueue: Promise<void>;
}

const peers = new Map<string, PeerEntry>();
const MAX_MESH_PEERS = 5;

function newPeerId (): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function clearReconnect (): void {
  if (reconnectTimer != null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearDiscover (): void {
  if (discoverTimer != null) {
    clearInterval(discoverTimer);
    discoverTimer = null;
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

function sendJsonCall (method: string, params: unknown[]): void {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = Message.fromVector(['JSONCall', JSON.stringify({ method, params })]);
    const buf = msg.toBuffer();
    ws.send(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  } catch (err: unknown) {
    swallowNonFatal('mesh-jsoncall', err);
  }
}

function registerSelf (): void {
  if (!localPeerId) return;
  sendJsonCall('RegisterWebRTCPeer', [{
    peerId: localPeerId,
    timestamp: Date.now(),
    metadata: {
      client: 'fabric-passport-offscreen',
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'extension'
    }
  }]);
}

function discoverPeers (): void {
  if (!localPeerId) return;
  sendJsonCall('ListWebRTCPeers', [{
    peerId: localPeerId,
    excludeSelf: true
  }]);
}

function sendSignal (toPeerId: string, signal: object): void {
  if (!localPeerId) return;
  sendJsonCall('SendWebRTCSignal', [{
    fromPeerId: localPeerId,
    toPeerId,
    signal
  }]);
}

function relayFromWebRTC (originalType: string, originalBase64: string): void {
  if (!localPeerId) return;
  sendJsonCall('RelayFromWebRTC', [{
    fromPeerId: localPeerId,
    envelope: {
      original: originalBase64,
      originalType,
      hops: [{ from: localPeerId, at: Date.now() }]
    }
  }]);
}

function bufferToBase64 (u8: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s);
}

function attachDataChannel (peerId: string, dc: RTCDataChannel, entry: PeerEntry): void {
  entry.dc = dc;
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => {
    notifyBg({
      type: 'MESH_PEER',
      event: 'connected',
      peerId,
      hubAddress: hubAddressActive || ''
    });
  };
  dc.onclose = () => {
    notifyBg({
      type: 'MESH_PEER',
      event: 'disconnected',
      peerId,
      hubAddress: hubAddressActive || ''
    });
  };
  dc.onmessage = (ev) => {
    try {
      const data = ev.data;
      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const u8 = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const b64 = bufferToBase64(u8);
        // Prefer CONTRACT_MESSAGE / fabric-message fan-out to Hub → Fabric TCP.
        relayFromWebRTC('fabric-message', b64);
        const parsed = tryParseNotifiableFabricFrame(data);
        if (parsed) {
          notifyBg({
            type: 'FABRIC_NODE_MESSAGE',
            nodeAddress: hubAddressActive || '',
            messageType: parsed.messageType,
            payload: parsed.payload
          });
        }
        return;
      }
      if (typeof data === 'string') {
        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(data) as Record<string, unknown>;
        } catch (_) {
          return;
        }
        if (payload && payload.type === 'fabric-message' && typeof payload.data === 'string') {
          relayFromWebRTC('fabric-message', payload.data);
        }
      }
    } catch (err: unknown) {
      swallowNonFatal('mesh-dc-message', err);
    }
  };
}

function ensurePeer (peerId: string, initiator: boolean): PeerEntry {
  let entry = peers.get(peerId);
  if (entry) return entry;

  const pc = createFabricPeerConnection();
  entry = {
    pc,
    dc: null,
    initiator,
    polite: !!(localPeerId && localPeerId < peerId),
    makingOffer: false,
    ignoreOffer: false,
    localSessionId: `${localPeerId || 'ext'}:${peerId}:${Date.now().toString(36)}`,
    remoteSessionId: null,
    localSignalRevision: 0,
    remoteSignalRevision: 0,
    signalQueue: Promise.resolve()
  };
  peers.set(peerId, entry);

  pc.onicecandidate = (ev) => {
    if (!ev.candidate) return;
    const signal = attachFabricSignalMeta(entry!, {
      type: 'ice-candidate',
      candidate: ev.candidate.toJSON ? ev.candidate.toJSON() : ev.candidate
    });
    sendSignal(peerId, signal);
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      peers.delete(peerId);
    }
  };

  pc.ondatachannel = (ev) => {
    attachDataChannel(peerId, ev.channel, entry!);
  };

  if (initiator) {
    const dc = pc.createDataChannel('fabric', { ordered: true });
    attachDataChannel(peerId, dc, entry);
    void (async () => {
      try {
        entry!.makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const signal = attachFabricSignalMeta(entry!, {
          type: 'offer',
          sdp: pc.localDescription
        });
        sendSignal(peerId, signal);
      } catch (err: unknown) {
        swallowNonFatal('mesh-create-offer', err);
      } finally {
        entry!.makingOffer = false;
      }
    })();
  }

  return entry;
}

async function handleIncomingSignal (fromPeerId: string, signal: Record<string, unknown>): Promise<void> {
  const meta = signal._fabric as { protocol?: string; sessionId?: string; targetSessionId?: string | null; revision?: number } | undefined;
  if (!meta || meta.protocol !== FABRIC_WEBRTC_SIGNAL_PROTOCOL || !meta.sessionId) return;

  const entry = ensurePeer(fromPeerId, false);
  if (meta.targetSessionId && meta.targetSessionId !== entry.localSessionId) return;

  entry.signalQueue = entry.signalQueue.then(async () => {
    const pc = entry.pc;
    if (signal.type === 'offer' && signal.sdp) {
      if (!entry.remoteSessionId || entry.remoteSessionId !== meta.sessionId) {
        entry.remoteSessionId = meta.sessionId;
        entry.remoteSignalRevision = 0;
      }
      if (Number.isFinite(meta.revision)) {
        entry.remoteSignalRevision = Math.max(entry.remoteSignalRevision || 0, Number(meta.revision));
      }
      const offerCollision = entry.makingOffer || pc.signalingState !== 'stable';
      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;
      await pc.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const answerSignal = attachFabricSignalMeta(entry, {
        type: 'answer',
        sdp: pc.localDescription
      });
      sendSignal(fromPeerId, answerSignal);
      return;
    }
    if (signal.type === 'answer' && signal.sdp) {
      await pc.setRemoteDescription(signal.sdp as RTCSessionDescriptionInit);
      return;
    }
    if (signal.type === 'ice-candidate' && signal.candidate) {
      try {
        await pc.addIceCandidate(signal.candidate as RTCIceCandidateInit);
      } catch (err: unknown) {
        swallowNonFatal('mesh-add-ice', err);
      }
    }
  }).catch((err) => swallowNonFatal('mesh-signal-queue', err));
}

function handleHubFrame (data: ArrayBuffer | string): void {
  let detail: string;
  if (typeof data === 'string') {
    detail = data.slice(0, 200);
  } else {
    detail = `binary:${data.byteLength}`;
  }
  notifyBg({
    type: 'MESH_SIGNALING',
    event: 'message',
    hubAddress: hubAddressActive || '',
    detail
  });

  try {
    let body: unknown = null;
    if (typeof data === 'string') {
      body = JSON.parse(data);
    } else {
      const msg = Message.fromBuffer(Buffer.from(data));
      if (!msg) return;
      if (msg.type === 'JSONCall' || msg.type === 'JSON_CALL') {
        body = JSON.parse(String(msg.body || ''));
      }
    }
    if (!body || typeof body !== 'object') return;
    const call = body as { method?: string; params?: unknown[]; result?: unknown };
    // Hub replies as JSONCall with method JSONCallResult, last param = result.
    let result: Record<string, unknown> | null = null;
    if (call.method === 'JSONCallResult' && Array.isArray(call.params) && call.params.length) {
      result = call.params[call.params.length - 1] as Record<string, unknown>;
    } else if (call.result && typeof call.result === 'object') {
      result = call.result as Record<string, unknown>;
    }
    if (!result) return;

    if (result.type === 'ListWebRTCPeersResult' && Array.isArray(result.peers)) {
      for (const row of result.peers as Array<{ id?: string; peerId?: string }>) {
        if (peers.size >= MAX_MESH_PEERS) break;
        const id = String(row.id || row.peerId || '');
        if (!id || id === localPeerId || peers.has(id)) continue;
        // Deterministic initiator: lower id offers.
        const initiator = !!(localPeerId && localPeerId < id);
        ensurePeer(id, initiator);
      }
      return;
    }
    if (result.type === 'WebRTCSignal' && result.fromPeerId && result.signal) {
      void handleIncomingSignal(String(result.fromPeerId), result.signal as Record<string, unknown>);
    }
  } catch (err: unknown) {
    swallowNonFatal('mesh-hub-frame', err);
  }

  const parsed = tryParseNotifiableFabricFrame(data);
  if (parsed) {
    notifyBg({
      type: 'FABRIC_NODE_MESSAGE',
      nodeAddress: hubAddressActive || '',
      messageType: parsed.messageType,
      payload: parsed.payload
    });
  }
}

export function stopMeshSignaling (): void {
  hubAddressActive = null;
  localPeerId = null;
  clearReconnect();
  clearDiscover();
  if (ws) {
    try {
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
    } catch (err: unknown) {
      swallowNonFatal('mesh-ws-close', err);
    }
    ws = null;
  }
  for (const [, entry] of peers) {
    try {
      entry.pc.close();
    } catch (err: unknown) {
      swallowNonFatal('mesh-pc-close', err);
    }
  }
  peers.clear();
}

export function startMeshSignaling (hubAddress: string): void {
  stopMeshSignaling();
  hubAddressActive = hubAddress;
  localPeerId = newPeerId();
  const url = fabricSignalingWebSocketUrl(hubAddress, '/');
  if (!url) {
    notifyBg({ type: 'MESH_SIGNALING', event: 'error', hubAddress, detail: 'Invalid hub address' });
    return;
  }

  try {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    ws = socket;

    socket.onopen = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'open', hubAddress });
      registerSelf();
      discoverPeers();
      clearDiscover();
      discoverTimer = setInterval(() => {
        registerSelf();
        discoverPeers();
      }, 15000);
    };

    socket.onclose = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'close', hubAddress });
      ws = null;
      clearDiscover();
      if (hubAddressActive === hubAddress) scheduleReconnect();
    };

    socket.onerror = () => {
      notifyBg({ type: 'MESH_SIGNALING', event: 'error', hubAddress });
    };

    socket.onmessage = (ev) => {
      handleHubFrame(ev.data as ArrayBuffer | string);
    };
  } catch (e: unknown) {
    notifyBg({
      type: 'MESH_SIGNALING',
      event: 'error',
      hubAddress,
      detail: e instanceof Error ? e.message : 'WebSocket error'
    });
    scheduleReconnect();
  }
}

/** @deprecated use ensurePeer via discovery; kept for PEER_ENSURE IPC */
export function meshEnsurePeerConnection (peerId: string): RTCPeerConnection {
  return ensurePeer(peerId, !!(localPeerId && localPeerId < peerId)).pc;
}

export function meshDropPeerConnection (peerId: string): void {
  const entry = peers.get(peerId);
  if (entry) {
    try {
      entry.pc.close();
    } catch (err: unknown) {
      swallowNonFatal('mesh-drop-pc', err);
    }
    peers.delete(peerId);
  }
}

/**
 * Publish author-signed AMP bytes onto mesh + Hub RelayFromWebRTC (no HTTP).
 */
export function meshPublishFabricWire (wireBase64: string, originalType = 'fabric-message'): boolean {
  if (!wireBase64) return false;
  let sent = 0;
  try {
    const raw = Uint8Array.from(atob(wireBase64), (c) => c.charCodeAt(0));
    for (const [, entry] of peers) {
      if (entry.dc && entry.dc.readyState === 'open') {
        entry.dc.send(raw);
        sent += 1;
      }
    }
  } catch (err: unknown) {
    swallowNonFatal('mesh-publish-dc', err);
  }
  relayFromWebRTC(originalType, wireBase64);
  return sent > 0 || !!localPeerId;
}

export function meshStatus (): { peerId: string | null; peers: number; hubAddress: string | null } {
  return {
    peerId: localPeerId,
    peers: peers.size,
    hubAddress: hubAddressActive
  };
}
