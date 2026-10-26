/**
 * Background-side owner of the Passport budget agent: one `MarketAgent`
 * over the shared page index's offer book, persisted in the encrypted
 * datastore (`market:agent`), with inventory requests forwarded to the
 * offscreen mesh document (which signs and floods the wire frame).
 */

import { MarketAgent, type MarketAgentSettings, type MarketAgentState, type MarketSession } from './market';
import { getPageIndex } from './pageIndex';
import { fabricDsGet, fabricDsSet } from '../background/encryptedDatastore';
import { swallowNonFatal } from '../utils/nonFatal';

export const MARKET_AGENT_DS_KEY = 'market:agent';
export const MARKET_AGENT_SETTINGS_DS_KEY = 'market:agent:settings';

type MeshPoster = (msg: object) => void;

let shared: MarketAgent | null = null;
let settings: MarketAgentSettings = {};
let poster: MeshPoster | null = null;
let loading: Promise<MarketAgent> | null = null;

export function setMarketMeshPoster (fn: MeshPoster): void {
  poster = fn;
}

function build (): MarketAgent {
  const index = getPageIndex();
  const agent = new MarketAgent(settings, {
    book: index.book,
    publishInventoryRequest: (body) => {
      if (poster) poster({ type: 'PUBLISH_INVENTORY_REQUEST', body });
    },
    requestBlob: (session: MarketSession) => {
      // Passport has no blob transfer socket; a paired node or the seller's
      // Hub HTTP 402 path serves the bytes. Surface the request to the mesh.
      if (poster) poster({ type: 'PUBLISH_BLOB_REQUEST', session });
    }
  });
  const persist = () => { void persistMarketAgent(); };
  agent.on('fundingRequired', persist);
  agent.on('sessionConfirmed', persist);
  agent.on('sessionComplete', persist);
  agent.on('sessionFailed', persist);
  return agent;
}

export async function getMarketAgent (): Promise<MarketAgent> {
  if (shared) return shared;
  if (!loading) {
    loading = (async () => {
      try {
        const saved = await fabricDsGet<MarketAgentSettings>(MARKET_AGENT_SETTINGS_DS_KEY);
        if (saved && typeof saved === 'object') settings = saved;
      } catch (err: unknown) { swallowNonFatal('market-agent-settings', err); }
      const agent = build();
      try {
        const state = await fabricDsGet<MarketAgentState>(MARKET_AGENT_DS_KEY);
        if (state) agent.import(state);
      } catch (err: unknown) { swallowNonFatal('market-agent-restore', err); }
      shared = agent;
      return agent;
    })();
  }
  return loading;
}

export async function persistMarketAgent (): Promise<void> {
  if (!shared) return;
  try {
    await fabricDsSet(MARKET_AGENT_DS_KEY, shared.export());
    await getPageIndex().persistTelemetry();
  } catch (err: unknown) { swallowNonFatal('market-agent-persist', err); }
}

export async function configureMarketAgent (patch: MarketAgentSettings): Promise<MarketAgent> {
  const agent = await getMarketAgent();
  const next: MarketAgentSettings = { ...settings };
  if (patch.budgetSats != null) next.budgetSats = Math.max(0, Math.floor(Number(patch.budgetSats) || 0));
  if (patch.perPlanMaxSats != null) next.perPlanMaxSats = Math.max(0, Math.floor(Number(patch.perPlanMaxSats) || 0));
  if (patch.proximityWeight != null) next.proximityWeight = Math.min(1, Math.max(0, Number(patch.proximityWeight) || 0));
  if (patch.inventoryEveryMs != null) next.inventoryEveryMs = Math.max(0, Number(patch.inventoryEveryMs) || 0);
  settings = next;
  try { await fabricDsSet(MARKET_AGENT_SETTINGS_DS_KEY, settings); } catch (err: unknown) { swallowNonFatal('market-agent-settings', err); }
  // Budget applies live; other knobs rebuild the agent over the same state.
  const state = agent.export();
  if (next.budgetSats != null) state.budgetSats = next.budgetSats;
  shared = build().import(state);
  await persistMarketAgent();
  return shared;
}

/** Run one planning pass (alarm / popup driven) and persist. */
export async function tickMarketAgent (): Promise<{ planned: number; opened: number; skipped: number }> {
  const agent = await getMarketAgent();
  const out = agent.tick();
  await persistMarketAgent();
  return out;
}
