/**
 * Window.postMessage bridge between a Fabric application page and the content script.
 * Enables any Fabric node to "install" long-lived WebRTC mesh: background opens offscreen doc + signaling.
 * The source identifier `fabric-hub` is kept for backward compatibility with deployed Hub pages.
 */
export const FABRIC_HUB_POSTMESSAGE_SOURCE = 'fabric-hub' as const;

export const FABRIC_HUB_REGISTER_MESH = 'FABRIC_HUB_REGISTER_MESH' as const;
export const FABRIC_HUB_UNREGISTER_MESH = 'FABRIC_HUB_UNREGISTER_MESH' as const;

export interface FabricHubRegisterMeshMessage {
  source: typeof FABRIC_HUB_POSTMESSAGE_SOURCE;
  type: typeof FABRIC_HUB_REGISTER_MESH;
  /** Full Fabric node base URL, e.g. https://hub.fabric.pub or http://127.0.0.1:8080 */
  hubAddress: string;
}

export interface FabricHubUnregisterMeshMessage {
  source: typeof FABRIC_HUB_POSTMESSAGE_SOURCE;
  type: typeof FABRIC_HUB_UNREGISTER_MESH;
}
