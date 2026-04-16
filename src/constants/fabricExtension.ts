/** Primary wallet + settings blob in chrome.storage.local / localStorage (popup + background must match). */
export const FABRIC_STATE_STORAGE_KEY = 'fabric_state';

/**
 * When set, the background service keeps WebSocket signaling (and offscreen WebRTC) on this node
 * even if no Fabric node is marked active in settings — set by application `postMessage` bridge or popup.
 * Key name kept for backward compatibility with existing stored registrations.
 */
export const FABRIC_MESH_HUB_REGISTRATION_KEY = 'fabric_mesh_hub_registration';
