'use strict';

export interface BitcoinNode {
  id: string;
  connectionString: string;
  isActive: boolean;
}

/** Hub base URL for WebSocket signaling (WebRTC); same shape as Bridge `hubAddress`. */
export interface FabricNode {
  id: string;
  hubAddress: string;
  isActive: boolean;
}

/** Public Hub JSON-RPC passthrough (`verifymessage`, etc.); no wallet RPC without bitcoind behind the Hub. */
const HUB_FABRIC_BITCOIN_RPC = 'https://hub.fabric.pub/services/bitcoin';

/** Default Fabric playnet-style bitcoind RPC (regtest); only the host changes for LAN presets. */
function playnetBitcoindUrl (host: string): string {
  return `http://ahp7iuGhae8mooBahFaYieyaixei6too:naiRe9wo5vieFayohje5aegheenoh4ee@${host}:20444`;
}

export const DEFAULT_BITCOIN_NODES: BitcoinNode[] = [
  { id: 'hub-fabric-pub', connectionString: HUB_FABRIC_BITCOIN_RPC, isActive: true },
  { id: 'playnet-regtest', connectionString: playnetBitcoindUrl('127.0.0.1'), isActive: false },
  { id: 'lan-192-168-50-5', connectionString: playnetBitcoindUrl('192.168.50.5'), isActive: false },
  { id: 'lan-192-168-50-2', connectionString: playnetBitcoindUrl('192.168.50.2'), isActive: false }
];

/** Quick-fill for the "Add node" field (same URLs as defaults). */
export const BITCOIN_HOST_PRESETS: ReadonlyArray<{ id: string; label: string; connectionString: string }> = [
  { id: 'hub', label: 'hub.fabric.pub', connectionString: HUB_FABRIC_BITCOIN_RPC },
  { id: 'playnet', label: '127.0.0.1 (playnet)', connectionString: playnetBitcoindUrl('127.0.0.1') },
  { id: 'lan50-5', label: '192.168.50.5', connectionString: playnetBitcoindUrl('192.168.50.5') },
  { id: 'lan50-2', label: '192.168.50.2', connectionString: playnetBitcoindUrl('192.168.50.2') }
];

const HUB_FABRIC_HUB_BASE = 'https://hub.fabric.pub';
const RELAY_GOON_HUB_BASE = 'https://relay.goon.vc';

function fabricHubAt (host: string, port: number): string {
  const p = host.includes(':') ? `[${host}]` : host;
  return `http://${p}:${port}`;
}

export const DEFAULT_FABRIC_NODES: FabricNode[] = [
  { id: 'hub-fabric-pub', hubAddress: HUB_FABRIC_HUB_BASE, isActive: true },
  { id: 'relay-goon-vc', hubAddress: RELAY_GOON_HUB_BASE, isActive: false },
  /** Local `@fabric/hub`: `node scripts/hub.js` (HTTP API + SPA). */
  { id: 'local-hub-http', hubAddress: fabricHubAt('127.0.0.1', 8080), isActive: false },
  /** Local Hub webpack dev server (proxies `/services`, `/settings` → :8080). */
  { id: 'local-hub-webpack', hubAddress: fabricHubAt('127.0.0.1', 3000), isActive: false },
  { id: 'local-passport-serve', hubAddress: fabricHubAt('127.0.0.1', 3003), isActive: false },
  { id: 'lan-192-168-50-5', hubAddress: fabricHubAt('192.168.50.5', 3003), isActive: false },
  { id: 'lan-192-168-50-2', hubAddress: fabricHubAt('192.168.50.2', 3003), isActive: false }
];

export const FABRIC_HUB_PRESETS: ReadonlyArray<{ id: string; label: string; hubAddress: string }> = [
  { id: 'hub', label: 'hub.fabric.pub', hubAddress: HUB_FABRIC_HUB_BASE },
  { id: 'relay', label: 'relay.goon.vc', hubAddress: RELAY_GOON_HUB_BASE },
  { id: 'local-8080', label: '127.0.0.1:8080 (local Hub)', hubAddress: fabricHubAt('127.0.0.1', 8080) },
  { id: 'local-3000', label: '127.0.0.1:3000 (webpack dev)', hubAddress: fabricHubAt('127.0.0.1', 3000) },
  { id: 'local', label: '127.0.0.1:3003', hubAddress: fabricHubAt('127.0.0.1', 3003) },
  { id: 'lan50-5', label: '192.168.50.5:3003', hubAddress: fabricHubAt('192.168.50.5', 3003) },
  { id: 'lan50-2', label: '192.168.50.2:3003', hubAddress: fabricHubAt('192.168.50.2', 3003) }
];
