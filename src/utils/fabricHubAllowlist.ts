/**
 * Allowed Hub HTTP origins for fabric://login and fabric://link (Passport).
 * Mirrors `@fabric/http/functions/fabricHubAllowlist` for the extension bundle.
 */

export const DEFAULT_FABRIC_HUB_ORIGINS = [
  'https://hub.fabric.pub',
  'http://hub.fabric.pub',
  'https://relay.goon.vc',
  'http://relay.goon.vc',
  'https://goon.vc',
  'http://goon.vc'
] as const;

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

function allowlistFromEnv (): string[] {
  // Extension cannot read process.env FABRIC_HUB_ALLOWLIST at build time for
  // operator overrides; chrome.storage extras can be passed via `extra`.
  return [];
}

export function isAllowedFabricHub (
  hubBase: string,
  opts: { extra?: string[]; allowLoopback?: boolean } = {}
): boolean {
  const origin = normalizeHubOrigin(hubBase);
  if (!origin) return false;
  if (opts.allowLoopback !== false && isLoopbackHubOrigin(origin)) return true;
  const allowed = new Set<string>([
    ...DEFAULT_FABRIC_HUB_ORIGINS.map((o) => normalizeHubOrigin(o)).filter((x): x is string => !!x),
    ...allowlistFromEnv(),
    ...(Array.isArray(opts.extra)
      ? opts.extra.map((s) => normalizeHubOrigin(s)).filter((x): x is string => !!x)
      : [])
  ]);
  return allowed.has(origin);
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
