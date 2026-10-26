'use strict';

/**
 * In-memory Hub `/device-links` + `/identity/cross-sign` for Passport client tests.
 * Verifies tagged BIP340 offer / link signatures (v3) the same way `@fabric/http`
 * does, and serves the signatures on GET so clients can check them.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { verifyIdentitySchnorr } = require('../../src/utils/loadFabricPassport').identitySchnorr;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  buildDeviceLinkMessage,
  buildDeviceLinkOfferMessage,
  DEVICE_LINK_OFFER_TAG,
  DEVICE_LINK_TAG
} = require('@fabric/http/functions/fabricDeviceLinkMessages');

export type StubSession = {
  sessionId: string;
  origin: string;
  nonce: string;
  label: string;
  status: 'awaiting_offer' | 'pending' | 'accepted' | 'linked';
  initiator: { id: string; xpub: string; pubkeyHex: string; offerSignature?: string; countersignature?: string };
  responder: { id: string; xpub: string; pubkeyHex: string; signature: string } | null;
  linkMessage: string | null;
  offerMessage: string;
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

function randomHex (bytes: number): string {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  return Array.from(u).map((b) => b.toString(16).padStart(2, '0')).join('');
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
      const label = String(body.label || 'device');
      if (!identity || !identity.xpub) {
        return jsonResponse(400, { ok: false, error: 'identity.xpub required' });
      }
      if (body.nonce) {
        return jsonResponse(400, { ok: false, error: 'client nonce rejected; omit nonce and sign the server offerMessage' });
      }
      const initiatorId = String(identity.id || '');
      if (!signature) {
        const sessionId = randomHex(24);
        const nonce = randomHex(32);
        const offerMessage = buildDeviceLinkOfferMessage(sessionId, nonce, initiatorId, label, hubOrigin);
        sessions.set(sessionId, {
          sessionId,
          origin: hubOrigin,
          nonce,
          label,
          status: 'awaiting_offer',
          initiator: { id: initiatorId, xpub: String(identity.xpub), pubkeyHex: '' },
          responder: null,
          linkMessage: null,
          offerMessage
        });
        return jsonResponse(200, {
          ok: true,
          status: 'awaiting_offer',
          sessionId,
          nonce,
          label,
          offerMessage,
          initiatorId
        });
      }
      const session = sessions.get(String(body.sessionId || ''));
      if (!session || session.status !== 'awaiting_offer' || session.initiator.id !== initiatorId) {
        return jsonResponse(404, { ok: false, error: 'unknown device-link session' });
      }
      const verified = verifyIdentitySchnorr(session.offerMessage, signature, pubkeyHex, {
        id: initiatorId,
        xpub: identity.xpub
      }, DEVICE_LINK_OFFER_TAG);
      if (!verified.ok) {
        return jsonResponse(400, { ok: false, error: verified.error || 'invalid offer signature' });
      }
      session.initiator.pubkeyHex = pubkeyHex.toLowerCase();
      session.initiator.offerSignature = signature.toLowerCase();
      session.status = 'pending';
      return jsonResponse(200, {
        ok: true,
        status: 'pending',
        sessionId: session.sessionId,
        nonce: session.nonce,
        protocolUrl: `fabric://link?sessionId=${encodeURIComponent(session.sessionId)}&hub=${encodeURIComponent(hubOrigin)}`
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
          session.sessionId,
          session.nonce,
          session.initiator.id,
          String(identity.id),
          session.label,
          session.origin
        );
        const verified = verifyIdentitySchnorr(linkMessage, signature, pubkeyHex, {
          id: identity.id,
          xpub: identity.xpub
        }, DEVICE_LINK_TAG);
        if (!verified.ok) {
          return jsonResponse(400, { ok: false, error: verified.error || 'invalid responder signature' });
        }
        session.responder = {
          id: String(identity.id),
          xpub: String(identity.xpub),
          pubkeyHex: pubkeyHex.toLowerCase(),
          signature: signature.toLowerCase()
        };
        session.linkMessage = linkMessage;
        session.status = 'accepted';
        return jsonResponse(200, { ok: true, status: 'accepted' });
      }
      if (role === 'initiator') {
        if (!session.linkMessage) {
          return jsonResponse(409, { ok: false, error: 'responder has not accepted yet' });
        }
        if (identity.id !== session.initiator.id || pubkeyHex.toLowerCase() !== session.initiator.pubkeyHex) {
          return jsonResponse(400, { ok: false, error: 'initiator does not match the offer' });
        }
        const verified = verifyIdentitySchnorr(session.linkMessage, signature, pubkeyHex, {
          id: identity.id,
          xpub: identity.xpub
        }, DEVICE_LINK_TAG);
        if (!verified.ok) {
          return jsonResponse(400, { ok: false, error: verified.error || 'invalid initiator signature' });
        }
        session.initiator.countersignature = signature.toLowerCase();
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
        offerMessage: session.status === 'linked' ? undefined : session.offerMessage,
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
