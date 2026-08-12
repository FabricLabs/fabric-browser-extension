'use strict';

import {
  startMeshSignaling,
  stopMeshSignaling,
  meshEnsurePeerConnection,
  meshDropPeerConnection,
  meshPublishFabricWire
} from './fabricMeshOffscreen';

const port = chrome.runtime.connect({ name: 'fabric-mesh-runtime' });

port.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  if (m.type === 'START_MESH' && typeof m.hubAddress === 'string') {
    startMeshSignaling(m.hubAddress);
  }
  if (m.type === 'STOP_MESH') {
    stopMeshSignaling();
  }
  if (m.type === 'PING') {
    port.postMessage({ type: 'PONG', ts: Date.now() });
  }
  if (m.type === 'PEER_ENSURE' && typeof m.peerId === 'string') {
    meshEnsurePeerConnection(m.peerId);
  }
  if (m.type === 'PEER_DROP' && typeof m.peerId === 'string') {
    meshDropPeerConnection(m.peerId);
  }
  if (m.type === 'PUBLISH_WIRE' && typeof m.wireBase64 === 'string') {
    const ok = meshPublishFabricWire(
      m.wireBase64,
      typeof m.originalType === 'string' ? m.originalType : 'fabric-message'
    );
    port.postMessage({ type: 'PUBLISH_WIRE_RESULT', ok });
  }
});
