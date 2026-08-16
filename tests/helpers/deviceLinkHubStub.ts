'use strict';

/**
 * In-memory Hub `/device-links` + `/identity/cross-sign` for Passport client tests.
 * Verifies BIP340 offer / link signatures the same way `@fabric/http` does.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyIdentitySchnorr } = require('@fabric/http/functions/fabricSiteLoginVerify');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildDeviceLinkMessage,
  buildDeviceLinkOfferMessage
} = require('@fabric/http/functions/fabricDeviceLinkMessages');

export type StubSession = {
  sessionId: string;
  origin: string;
  nonce: string;
  label: string;
  status: 'pending' | 'accepted' | 'linked';
  initiator: { id: string; xpub: string; pubkeyHex: string };
  responder: { id: string; xpub: string; pubkeyHex: string } | null;
  linkMessage: string | null;
};

type JsonBody = Record<string, unknown>;

const NATIVE_FETCH: typeof fetch | undefined = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : undefined;

function jsonResponse (status: number, body: JsonBody): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as Response;
}

function parseBody (init?: RequestInit): JsonBody {
  if (!init || init.body == null) return {};
  try {
    return JSON.parse(String(init.body)) as JsonBody;
  } catch {
    return {};
  }
}

export function installDeviceLinkHubStub (hubOrigin = 'https://relay.goon.vc'): {
  sessions: Map<string, StubSession>;
  crossSigns: JsonBody[];
  restore: () => void;
} {
  const sessions = new Map<string, StubSession>();
  const crossSigns: JsonBody[] = [];
  const prev = globalThis.fetch;

  (globalThis as { fetch: typeof fetch }).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = String((init && init.method) || 'GET').toUpperCase();
    const origin = url.origin;

    if (method === 'POST' && url.pathname === '/identity/cross-sign') {
      const body = parseBody(init);
      crossSigns.push(body);
      return jsonResponse(200, { ok: true });
    }
    if (method === 'POST' && url.pathname === '/services/star-citizen/identity/cross-sign') {
      return jsonResponse(404, { ok: false, error: 'not this host' });
    }

    if (origin !== hubOrigin) {
      return jsonResponse(404, { ok: false, error: 'unknown hub' });
    }

    if (method === 'POST' && url.pathname === '/device-links') {
      const body = parseBody(init);
      const identity = body.identity && typeof body.identity === 'object'
        ? body.identity as { id?: string; xpub?: string }
        : null;
      const signature = String(body.signature || '');
      const pubkeyHex = String(body.pubkeyHex || '');
      const nonce = String(body.nonce || '');
      const label = String(body.label || 'device');
      if (!identity || !identity.xpub || !signature || !pubkeyHex || !nonce) {
        return jsonResponse(400, { ok: false, error: 'identity.xpub, pubkeyHex, and signature required' });
      }
      const initiatorId = String(identity.id || '');
      const offerMessage = buildDeviceLinkOfferMessage(nonce, initiatorId, label, hubOrigin);
      const verified = verifyIdentitySchnorr(offerMessage, signature, pubkeyHex, {
        id: initiatorId,
        xpub: identity.xpub
      });
      if (!verified.ok) {
        return jsonResponse(400, { ok: false, error: verified.error || 'invalid offer signature' });
      }
      const sessionId = Array.from({ length: 24 }, () =>
        Math.floor(Math.random() * 16).toString(16)).join('') + Date.now().toString(16);
      const session: StubSession = {
        sessionId,
        origin: hubOrigin,
        nonce,
        label,
        status: 'pending',
        initiator: {
          id: initiatorId,
          xpub: String(identity.xpub),
          pubkeyHex: pubkeyHex.toLowerCase()
        },
        responder: null,
        linkMessage: null
      };
      sessions.set(sessionId, session);
      return jsonResponse(200, {
        ok: true,
        sessionId,
        nonce,
        protocolUrl: `fabric://link?sessionId=${encodeURIComponent(sessionId)}&hub=${encodeURIComponent(hubOrigin)}`
      });
    }

    const sigMatch = url.pathname.match(/^\/device-links\/([^/]+)\/signatures$/);
    if (method === 'POST' && sigMatch) {
      const session = sessions.get(decodeURIComponent(sigMatch[1]));
      if (!session) return jsonResponse(404, { ok: false, error: 'unknown or expired device link' });
      const body = parseBody(init);
      const role = String(body.role || '');
      const identity = body.identity && typeof body.identity === 'object'
        ? body.identity as { id?: string; xpub?: string }
        : null;
      const signature = String(body.signature || '');
      const pubkeyHex = String(body.pubkeyHex || '');
      if (!identity || !identity.id || !identity.xpub || !signature || !pubkeyHex) {
        return jsonResponse(400, { ok: false, error: 'signature required' });
      }
      if (role === 'responder') {
        const linkMessage = buildDeviceLinkMessage(
          session.nonce,
          session.initiator.id,
          String(identity.id),
          session.label
        );
        const verified = verifyIdentitySchnorr(linkMessage, signature, pubkeyHex, {
          id: identity.id,
          xpub: identity.xpub
        });
        if (!verified.ok) {
          return jsonResponse(400, { ok: false, error: verified.error || 'invalid responder signature' });
        }
        session.responder = {
          id: String(identity.id),
          xpub: String(identity.xpub),
          pubkeyHex: pubkeyHex.toLowerCase()
        };
        session.linkMessage = linkMessage;
        session.status = 'accepted';
        return jsonResponse(200, { ok: true, status: 'accepted' });
      }
      if (role === 'initiator') {
        if (!session.linkMessage) {
          return jsonResponse(409, { ok: false, error: 'responder has not accepted yet' });
        }
        const verified = verifyIdentitySchnorr(session.linkMessage, signature, pubkeyHex, {
          id: identity.id,
          xpub: identity.xpub
        });
        if (!verified.ok) {
          return jsonResponse(400, { ok: false, error: verified.error || 'invalid initiator signature' });
        }
        session.status = 'linked';
        return jsonResponse(200, {
          ok: true,
          status: 'linked',
          label: session.label,
          responder: session.responder
        });
      }
      return jsonResponse(400, { ok: false, error: 'role required' });
    }

    const getMatch = url.pathname.match(/^\/device-links\/([^/]+)$/);
    if (method === 'DELETE' && getMatch) {
      const id = decodeURIComponent(getMatch[1]);
      const session = sessions.get(id);
      if (!session) return jsonResponse(200, { ok: true, existed: false });
      if (session.status === 'linked') {
        return jsonResponse(409, { ok: false, error: 'already linked' });
      }
      sessions.delete(id);
      return jsonResponse(200, { ok: true, existed: true });
    }
    if (method === 'GET' && getMatch) {
      const session = sessions.get(decodeURIComponent(getMatch[1]));
      if (!session) return jsonResponse(404, { ok: false, error: 'unknown or expired device link' });
      return jsonResponse(200, {
        ok: true,
        status: session.status,
        sessionId: session.sessionId,
        origin: session.origin,
        nonce: session.nonce,
        label: session.label,
        initiator: session.initiator,
        responder: session.responder,
        linkMessage: session.linkMessage
      });
    }

    return jsonResponse(404, { ok: false, error: `no stub for ${method} ${url.pathname}` });
  }) as typeof fetch;

  return {
    sessions,
    crossSigns,
    restore () {
      if (typeof prev === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = prev;
      } else if (typeof NATIVE_FETCH === 'function') {
        (globalThis as { fetch: typeof fetch }).fetch = NATIVE_FETCH;
      }
      // Never `delete globalThis.fetch` — Node mocha later files (LiveRelay
      // interop) need the platform fetch, and a missing prev used to wipe it.
    }
  };
}
