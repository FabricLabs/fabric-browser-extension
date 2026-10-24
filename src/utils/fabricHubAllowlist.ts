/**
 * Allowed Hub HTTP origins for fabric://login and fabric://link (Passport).
 * Mirrors `@fabric/http/functions/fabricHubAllowlist` for the extension bundle.
 *
 * Default network hubs are **HTTPS-only**. Cleartext production origins require
 * an explicit `opts.extra` allowlist entry. Loopback `http://` remains allowed.
 *
 * Operator opt-in (no hardcoded preview hosts): pass exact origins or HTTPS
 * suffixes (`*.example.com`) via `opts.extra`, or store them under
 * {@link FABRIC_HUB_ALLOWLIST_STORAGE_KEY} in `chrome.storage.local`.
 */

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

export function isAllowedFabricHub (
  hubBase: string,
  opts: { extra?: string[]; allowLoopback?: boolean } = {}
): boolean {
  const origin = normalizeHubOrigin(hubBase);
  if (!origin) return false;
  if (opts.allowLoopback !== false && isLoopbackHubOrigin(origin)) return true;
  const entries = [
    ...parseAllowlistEntries([...DEFAULT_FABRIC_HUB_ORIGINS]),
    ...parseAllowlistEntries(opts.extra)
  ];
  return originMatchesAllowlistEntries(origin, entries);
}

export function assertAllowedFabricHub (
  hubBase: string,
  opts: { extra?: string[]; allowLoopback?: boolean } = {}
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
