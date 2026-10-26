/**
 * Allowed Hub HTTP origins for device links (`fabric://link`) and Hub calls from Passport.
 * Mirrors `@fabric/http/functions/fabricHubAllowlist` for the extension bundle.
 *
 * Default network hubs are **HTTPS-only**. Cleartext production origins require
 * an explicit `opts.extra` allowlist entry. A loopback Hub counts only when it is
 * the active Fabric node in Passport settings (`opts.activeHub`): any local
 * process can listen on a loopback port.
 *
 * Operator opt-in (no hardcoded preview hosts): pass exact origins or HTTPS
 * suffixes (`*.example.com`) via `opts.extra`, or store them under
 * {@link FABRIC_HUB_ALLOWLIST_STORAGE_KEY} in `chrome.storage.local`.
 */

import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';

export const DEFAULT_FABRIC_HUB_ORIGINS = [
  'https://hub.fabric.pub',
  'https://hub.goon.vc',
  'https://relay.goon.vc',
  'https://goon.vc'
] as const;

/** chrome.storage.local key: string | string[] of origins and optional `*.suffix`. */
export const FABRIC_HUB_ALLOWLIST_STORAGE_KEY = 'fabric.hub.allowlist';

export function normalizeHubOrigin (raw: string): string | null {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

function isLoopbackHubOrigin (origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function normalizeHttpsHostSuffix (raw: string): string | null {
  let s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s.startsWith('suffix:')) s = s.slice(7).trim();
  if (s.startsWith('*.')) s = s.slice(1);
  if (!s.startsWith('.')) s = `.${s}`;
  const labels = s.slice(1).split('.').filter(Boolean);
  if (labels.length < 2) return null;
  if (!/^\.[a-z0-9.-]+$/.test(s)) return null;
  if (s.includes('..')) return null;
  return s;
}

type AllowlistEntry =
  | { kind: 'origin'; origin: string }
  | { kind: 'https-suffix'; suffix: string };

export function parseAllowlistToken (token: string): AllowlistEntry | null {
  const raw = String(token || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.startsWith('*.') || lower.startsWith('suffix:') || (lower.startsWith('.') && !lower.includes('://'))) {
    const suffix = normalizeHttpsHostSuffix(raw);
    if (!suffix) return null;
    return { kind: 'https-suffix', suffix };
  }
  const origin = normalizeHubOrigin(raw);
  if (!origin) return null;
  return { kind: 'origin', origin };
}

export function parseAllowlistEntries (raw: string | string[] | null | undefined): AllowlistEntry[] {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const out: AllowlistEntry[] = [];
  for (const part of parts) {
    const entry = parseAllowlistToken(part);
    if (entry) out.push(entry);
  }
  return out;
}

function originMatchesAllowlistEntries (origin: string, entries: AllowlistEntry[]): boolean {
  if (!origin || !entries.length) return false;
  let host = '';
  let isHttps = false;
  try {
    const u = new URL(origin);
    host = u.hostname.toLowerCase();
    isHttps = u.protocol === 'https:';
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.kind === 'origin' && entry.origin === origin) return true;
    if (entry.kind === 'https-suffix' && isHttps) {
      const suffix = entry.suffix;
      const bare = suffix.slice(1);
      if (host === bare || host.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * Load operator allowlist tokens from extension storage (exact origins and/or `*.suffix`).
 */
export async function loadFabricHubAllowlistExtras (): Promise<string[]> {
  try {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) return [];
    const bag = await chrome.storage.local.get(FABRIC_HUB_ALLOWLIST_STORAGE_KEY);
    const raw = bag && bag[FABRIC_HUB_ALLOWLIST_STORAGE_KEY];
    if (Array.isArray(raw)) {
      return raw.map((s) => String(s || '').trim()).filter(Boolean);
    }
    if (typeof raw === 'string' && raw.trim()) {
      return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    }
  } catch {
    /* ignore storage failures — fail closed to defaults */
  }
  return [];
}

function activeHubUrl (hubAddress: string): string {
  const raw = String(hubAddress || '').trim();
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/** Origin of the active Fabric node in Passport settings, or null. */
export function activeFabricHubFromState (state: unknown): string | null {
  if (!state || typeof state !== 'object') return null;
  const settings = (state as Record<string, unknown>).settings as Record<string, unknown> | undefined;
  const nodes = settings?.fabricNodes as Array<{ isActive?: boolean; hubAddress?: string }> | undefined;
  if (!Array.isArray(nodes)) return null;
  const active = nodes.find((n) => n && n.isActive && typeof n.hubAddress === 'string' && n.hubAddress.trim());
  return active && active.hubAddress ? normalizeHubOrigin(activeHubUrl(active.hubAddress)) : null;
}

/** Allowlist extras plus the active Fabric node, read from extension storage. */
export async function loadFabricHubGateOptions (): Promise<FabricHubGateOptions> {
  const extra = await loadFabricHubAllowlistExtras();
  let activeHub: string | null = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      const bag = await chrome.storage.local.get(FABRIC_STATE_STORAGE_KEY);
      activeHub = activeFabricHubFromState(bag && bag[FABRIC_STATE_STORAGE_KEY]);
    }
  } catch {
    activeHub = null;
  }
  return { extra, activeHub };
}

/** Runtime message: content script asks the background for {@link loadFabricHubGateOptions}. */
export const FABRIC_RUNTIME_HUB_GATE_OPTIONS = 'FABRIC_HUB_GATE_OPTIONS';

/**
 * Content-script twin of {@link loadFabricHubGateOptions}: the background reads the
 * active node so Passport state never loads into a page's renderer. Without an
 * answer, no loopback Hub is allowed.
 */
export async function requestFabricHubGateOptions (): Promise<FabricHubGateOptions> {
  const extra = await loadFabricHubAllowlistExtras();
  let activeHub: string | null = null;
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
      const res = await chrome.runtime.sendMessage({ type: FABRIC_RUNTIME_HUB_GATE_OPTIONS });
      const raw = res && typeof res.activeHub === 'string' ? res.activeHub : null;
      activeHub = raw ? normalizeHubOrigin(raw) : null;
    }
  } catch {
    activeHub = null;
  }
  return { extra, activeHub };
}

/** Save operator allowlist tokens; returns the tokens that parsed. */
export async function saveFabricHubAllowlistExtras (raw: string | string[]): Promise<string[]> {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,]+/);
  const kept = parts.map((s) => String(s || '').trim()).filter((s) => !!parseAllowlistToken(s));
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
    await chrome.storage.local.set({ [FABRIC_HUB_ALLOWLIST_STORAGE_KEY]: kept });
  }
  return kept;
}

/**
 * Host-permission pattern a cleartext LAN hub needs (`optional_host_permissions`),
 * or null when the manifest already covers it (HTTPS, loopback) or it is a suffix.
 */
export function lanHubPermissionPattern (token: string): string | null {
  const entry = parseAllowlistToken(token);
  if (!entry || entry.kind !== 'origin') return null;
  if (!entry.origin.startsWith('http://') || isLoopbackHubOrigin(entry.origin)) return null;
  return `${entry.origin.replace(/:\d+$/, '')}/*`;
}

export type FabricHubGateOptions = {
  extra?: string[];
  /** Origin of the active Fabric node; the only loopback Hub allowed. */
  activeHub?: string | null;
};

export function isAllowedFabricHub (
  hubBase: string,
  opts: FabricHubGateOptions = {}
): boolean {
  const origin = normalizeHubOrigin(hubBase);
  if (!origin) return false;
  if (isLoopbackHubOrigin(origin)) {
    const active = opts.activeHub ? normalizeHubOrigin(activeHubUrl(opts.activeHub)) : null;
    return !!active && active === origin;
  }
  const entries = [
    ...parseAllowlistEntries([...DEFAULT_FABRIC_HUB_ORIGINS]),
    ...parseAllowlistEntries(opts.extra)
  ];
  return originMatchesAllowlistEntries(origin, entries);
}

export function assertAllowedFabricHub (
  hubBase: string,
  opts: FabricHubGateOptions = {}
): { ok: true; hubBase: string } | { ok: false; error: string } {
  const origin = normalizeHubOrigin(hubBase);
  if (!origin) return { ok: false, error: 'invalid hub origin' };
  if (!isAllowedFabricHub(origin, opts)) {
    return {
      ok: false,
      error: `hub origin not allowed: ${origin}`
    };
  }
  return { ok: true, hubBase: origin };
}
