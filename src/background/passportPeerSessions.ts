'use strict';

/**
 * Background side of Passport peer sessions (v3): Passport opens the
 * connection to a peer itself, checks the peer's key, and keeps the session.
 *
 * - A page names the peer (`PASSPORT_PEER_CONNECT`: endpoints and, ideally,
 *   its key). The background opens a WebSocket, sends `PASSPORT_CONNECT`, and
 *   reads the peer's signed challenge. It generates a session key and queues
 *   the sign-in for the popup, which signs the assertion with the identity key.
 * - {@link finishPeerSignIn} sends the assertion and reads `PASSPORT_SESSION`.
 *   The session (with its private session key) stays here, in
 *   `chrome.storage.session`; the page gets only a public view.
 * - Calls (`PASSPORT_PEER_CALL`) are signed with the session key and answered
 *   only for the page origin that opened the session. A dropped socket is
 *   reopened and re-bound with `PASSPORT_RESUME`, without asking the user.
 *
 * The service worker holds the sockets; peers send keepalives, which keep it
 * running while a socket is open.
 *
 * An `http(s):` endpoint is an HTTP peer: the handshake runs on
 * `POST /sessions/peer` (with the binding the connect returned), and the page
 * then asks for one signed `X-Fabric-Request` per request
 * ({@link authorizePeerRequest}) instead of making calls through Passport.
 */

import {
  FABRIC_PASSPORT_PEER_KEYS_KEY,
  FABRIC_PASSPORT_PEER_SESSIONS_KEY
} from '../constants/siteLogin';
import { swallowNonFatal } from '../utils/nonFatal';
import { createPeerRequest } from '../utils/passportPeerRequest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../utils/loadFabricPassport');

type Fail = { ok: false; error: string };

/** How long to wait for a peer (not the user). */
export const PEER_REPLY_TIMEOUT_MS = 15_000;
/** Most open peer sockets. */
export const MAX_PEER_CONNECTIONS = 16;
/** Most open peer sessions. */
export const MAX_PEER_SESSIONS = 64;
/** Longest JSON a page may send in one call. */
export const MAX_PEER_CALL_CHARS = 256 * 1024;
/** Longest body a page may have Passport sign for one HTTP request. */
export const MAX_PEER_REQUEST_BODY_CHARS = 1024 * 1024;

type Conn = {
  id: string;
  endpoint: string;
  /** `ws` for a WebSocket peer, `http` for an HTTP peer. */
  kind: 'ws' | 'http';
  ws: WebSocket | null;
  /** HTTP handshake binding, sent back with the assertion. */
  binding: string | null;
  send: (frame: Buffer) => void;
  listeners: Set<(frame: Buffer) => void>;
  open: boolean;
};

export type PeerSessionRecord = {
  sessionId: string;
  /** Page origin that opened the session; the only one it answers. */
  origin: string;
  peer: string;
  endpoint: string;
  /** `ws` (calls through Passport) or `http` (signed requests). */
  transport: 'ws' | 'http';
  /** The peer's HTTP origin: requests Passport signs must go there. */
  base: string;
  /** Private session key, hex. Never leaves the background. */
  sessionKey: string;
  sessionPubkey: string;
  identity: { id: string; pubkey: string };
  network: string | null;
  disclosed: string[];
  wallet?: unknown;
  cosigner?: { pubkey: string } | null;
  issuedAt: number;
  expiresAt: number;
};

/** What a page sees of a session. */
export type PeerSessionView = {
  sessionId: string;
  peer: string;
  transport: 'ws' | 'http';
  base: string;
  identity: { id: string; pubkey: string };
  network: string | null;
  disclosed: string[];
  wallet?: unknown;
  cosigner?: { pubkey: string } | null;
  expiresAt: number;
};

const conns = new Map<string, Conn>();
/** Live socket per session id. */
const sessionConn = new Map<string, string>();

function randomHex (bytes: number): string {
  const out = new Uint8Array(bytes);
  crypto.getRandomValues(out);
  return Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function toBytes (data: unknown): Buffer | null {
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

export function frameType (buffer: Buffer | null): string | null {
  if (!buffer || buffer.length < 76 || !core.Message) return null;
  return core.Message.canonicalTypeName(buffer.readUInt32BE(72));
}

async function sha256Hex (text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Correlation hash the peer puts on a JSONCall result (`@fabric/http` `computeWebSocketJsonCallHashPair`). */
export async function jsonCallHash (body: string): Promise<string> {
  return sha256Hex(await sha256Hex(body));
}

/** Pure: may `origin` use this session now? */
export function sessionAnswersOrigin (record: PeerSessionRecord | null | undefined, origin: string | null, now: number = Date.now()): { ok: true } | Fail {
  if (!record) return { ok: false, error: 'unknown_session' };
  if (!origin || record.origin !== origin) return { ok: false, error: 'not_your_session' };
  if (record.expiresAt <= now) return { ok: false, error: 'expired' };
  return { ok: true };
}

export function sessionView (record: PeerSessionRecord): PeerSessionView {
  const view: PeerSessionView = {
    sessionId: record.sessionId,
    peer: record.peer,
    transport: record.transport,
    base: record.base,
    identity: record.identity,
    network: record.network,
    disclosed: record.disclosed,
    expiresAt: record.expiresAt
  };
  if (record.wallet) view.wallet = record.wallet;
  if (record.cosigner) view.cosigner = { pubkey: record.cosigner.pubkey };
  return view;
}

function sessionArea (): chrome.storage.StorageArea | null {
  return (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.session) || null;
}

async function readMap<T> (key: string): Promise<Record<string, T>> {
  const area = sessionArea();
  if (!area) return {};
  const got = await area.get(key);
  const value = got && got[key];
  return value && typeof value === 'object' ? value as Record<string, T> : {};
}

async function writeMap<T> (key: string, value: Record<string, T>): Promise<void> {
  const area = sessionArea();
  if (!area) throw new Error('session storage unavailable');
  await area.set({ [key]: value });
}

/** Writes to the session maps go through one queue (read-modify-write). */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T> (work: () => Promise<T>): Promise<T> {
  const run = queue.then(work, work);
  queue = run.catch(() => undefined);
  return run;
}

export async function readPeerSessions (now: number = Date.now()): Promise<Record<string, PeerSessionRecord>> {
  const all = await readMap<PeerSessionRecord>(FABRIC_PASSPORT_PEER_SESSIONS_KEY);
  return Object.fromEntries(Object.entries(all).filter(([, r]) => r && r.expiresAt > now));
}

async function saveSession (record: PeerSessionRecord): Promise<void> {
  await serialized(async () => {
    const live = await readPeerSessions();
    live[record.sessionId] = record;
    const kept = Object.entries(live).sort((a, b) => b[1].issuedAt - a[1].issuedAt).slice(0, MAX_PEER_SESSIONS);
    await writeMap(FABRIC_PASSPORT_PEER_SESSIONS_KEY, Object.fromEntries(kept));
  });
}

async function dropSession (sessionId: string): Promise<void> {
  await serialized(async () => {
    const live = await readPeerSessions();
    delete live[sessionId];
    await writeMap(FABRIC_PASSPORT_PEER_SESSIONS_KEY, live);
  });
}

/** Keep a pending sign-in's private session key until the popup answers. */
export async function holdSessionKey (requestId: string, privateHex: string, expiresAt: number): Promise<void> {
  await serialized(async () => {
    const now = Date.now();
    const keys = await readMap<{ key: string; expiresAt: number }>(FABRIC_PASSPORT_PEER_KEYS_KEY);
    const next = Object.fromEntries(Object.entries(keys).filter(([, v]) => v && v.expiresAt > now));
    next[requestId] = { key: privateHex, expiresAt };
    await writeMap(FABRIC_PASSPORT_PEER_KEYS_KEY, next);
  });
}

async function takeSessionKey (requestId: string): Promise<string | null> {
  return serialized(async () => {
    const keys = await readMap<{ key: string; expiresAt: number }>(FABRIC_PASSPORT_PEER_KEYS_KEY);
    const found = keys[requestId];
    delete keys[requestId];
    await writeMap(FABRIC_PASSPORT_PEER_KEYS_KEY, keys);
    return found && found.expiresAt > Date.now() ? found.key : null;
  });
}

/** A fresh session key: `{ privateHex, pubkey }`. */
export function newSessionKey (): { privateHex: string; pubkey: string } {
  const key = new core.Key();
  // `key.private` is the 32 raw bytes; `privkey` is a binary string, not hex.
  return { privateHex: Buffer.from(key.private).toString('hex'), pubkey: String(key.pubkey).toLowerCase() };
}

function keyFrom (privateHex: string): any {
  return new core.Key({ private: privateHex });
}

function closeConn (conn: Conn): void {
  conn.open = false;
  conns.delete(conn.id);
  for (const [sessionId, id] of sessionConn) if (id === conn.id) sessionConn.delete(sessionId);
  if (conn.ws) {
    try { conn.ws.close(); } catch (err: unknown) { swallowNonFatal('peer-socket-close', err); }
  }
}

/** The HTTP origin of a peer endpoint (`wss://h/` → `https://h`). */
export function peerBase (endpoint: string): string | null {
  try {
    const url = new URL(endpoint);
    const protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol;
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    return `${protocol}//${url.host}`;
  } catch {
    return null;
  }
}

/** An HTTP peer's handshake as a connection: each frame is a POST, its answer the peer's next frame. */
function openHttpConnection (endpoint: string): Conn {
  const base = peerBase(endpoint);
  if (!base) throw new Error('not an http(s) endpoint');
  const conn: Conn = {
    id: randomHex(16),
    endpoint: base,
    kind: 'http',
    ws: null,
    binding: null,
    listeners: new Set(),
    open: true,
    send: (frame: Buffer) => {
      const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (conn.binding && frameType(frame) !== 'PASSPORT_CONNECT') headers['X-Fabric-Binding'] = conn.binding;
      const deliver = (buffer: Buffer) => { for (const listener of [...conn.listeners]) listener(buffer); };
      const refuse = (error: string) => deliver(core.passport.createRefusal({ error, answers: frame }).message.toBuffer());
      fetch(`${base}/sessions/peer`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ frame: core.fabricUri.encodeFabricUri(frame) }),
        cache: 'no-store',
        credentials: 'omit'
      }).then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (json && typeof json.binding === 'string') conn.binding = json.binding;
        const decoded = json && typeof json.frame === 'string' ? core.fabricUri.decodeFabricUri(json.frame, { allowUnsigned: true }) : null;
        if (decoded && decoded.ok) deliver(Buffer.from(decoded.buffer));
        else refuse((json && json.error) || `HTTP ${res.status}`);
      }).catch((err: unknown) => refuse(err instanceof Error ? err.message : 'unreachable'));
    }
  };
  conns.set(conn.id, conn);
  return conn;
}

/** Open a socket to the first endpoint that answers. */
export async function openPeerConnection (endpoints: string[], timeoutMs: number = PEER_REPLY_TIMEOUT_MS): Promise<Conn> {
  if (conns.size >= MAX_PEER_CONNECTIONS) {
    const oldest = conns.values().next().value;
    if (oldest) closeConn(oldest);
  }
  let lastError = 'no endpoints';
  for (const endpoint of endpoints) {
    if (/^https?:/i.test(endpoint)) return openHttpConnection(endpoint);
    try {
      const ws = await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(endpoint);
        socket.binaryType = 'arraybuffer';
        const timer = setTimeout(() => { try { socket.close(); } catch { /* closed */ } reject(new Error('timeout')); }, timeoutMs);
        socket.addEventListener('open', () => { clearTimeout(timer); resolve(socket); }, { once: true });
        socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('unreachable')); }, { once: true });
      });
      const conn: Conn = { id: randomHex(16), endpoint, kind: 'ws', ws, binding: null, listeners: new Set(), open: true, send: (frame: Buffer) => ws.send(frame) };
      ws.addEventListener('message', (event: MessageEvent) => {
        const bytes = toBytes(event.data);
        if (!bytes) return;
        for (const listener of [...conn.listeners]) listener(bytes);
      });
      ws.addEventListener('close', () => closeConn(conn));
      conns.set(conn.id, conn);
      return conn;
    } catch (err: unknown) {
      lastError = `${endpoint}: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  throw new Error(`peer unreachable (${lastError})`);
}

function nextFrame (conn: Conn, types: string[], timeoutMs: number = PEER_REPLY_TIMEOUT_MS): Promise<{ type: string; buffer: Buffer }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { conn.listeners.delete(on); reject(new Error('peer did not answer')); }, timeoutMs);
    function on (buffer: Buffer): void {
      const type = frameType(buffer);
      if (!type || !types.includes(type)) return;
      clearTimeout(timer);
      conn.listeners.delete(on);
      resolve({ type, buffer });
    }
    conn.listeners.add(on);
  });
}

function refusal (buffer: Buffer): string {
  const read = core.passport.readRefusal(buffer);
  return read.ok ? `peer refused: ${read.error}` : 'peer refused';
}

export type PeerChallenge = {
  connId: string;
  endpoint: string;
  uri: string;
  hash: string;
  nonce: string;
  peer: string;
  homes: string[];
  purpose: string | null;
  network: string | null;
  request: string[];
  expiresAt: number;
};

/**
 * Connect to a peer and get its signed challenge, checked against the key the
 * page named (when it named one) and this connection's nonce.
 */
export async function requestPeerChallenge (params: {
  endpoints: string[];
  peer: string | null;
  origin: string;
  request: string[];
}): Promise<({ ok: true } & { challenge: PeerChallenge }) | Fail> {
  let conn: Conn;
  try {
    conn = await openPeerConnection(params.endpoints);
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const connect = core.passport.createConnect({ peer: params.peer || undefined, origin: params.origin, request: params.request });
    const wait = nextFrame(conn, ['PASSPORT_CHALLENGE', 'PASSPORT_REFUSED']);
    conn.send(connect.message.toBuffer());
    const got = await wait;
    if (got.type === 'PASSPORT_REFUSED') throw new Error(refusal(got.buffer));
    const read = core.passport.readChallenge(got.buffer, { peer: params.peer || undefined, clientNonce: connect.clientNonce });
    if (!read.ok) throw new Error(`peer challenge: ${read.error}`);
    if (read.challenge.v !== core.passport.PASSPORT_PEER_VERSION) throw new Error('peer challenge: not a peer challenge');
    const c = read.challenge;
    return {
      ok: true,
      challenge: {
        connId: conn.id,
        endpoint: conn.endpoint,
        uri: core.fabricUri.encodeFabricUri(got.buffer),
        hash: String(read.hash),
        nonce: String(c.nonce),
        peer: String(c.peer),
        homes: Array.isArray(c.homes) ? c.homes.map(String) : [],
        purpose: c.purpose ? String(c.purpose) : null,
        network: c.network ? String(c.network) : null,
        request: (c.request || []).map(String),
        expiresAt: Number(c.expiresAt)
      }
    };
  } catch (err: unknown) {
    closeConn(conn);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop a pending sign-in's socket and key (declined, expired, or replaced). */
export async function abandonPeerSignIn (row: { connId?: string; requestId: string }): Promise<void> {
  const conn = row.connId ? conns.get(row.connId) : null;
  if (conn) closeConn(conn);
  await takeSessionKey(row.requestId).catch(() => null);
}

/**
 * Send the approved assertion on the sign-in's socket and keep the session.
 * @param row The pending sign-in (its socket, peer, origin, and session key's pubkey).
 * @param assertion `fabric:` PASSPORT_ASSERTION, already verified against the row.
 * @param disclosed What the user agreed to share.
 */
export async function finishPeerSignIn (
  row: { requestId: string; connId?: string; origin: string; peer?: string | null; sessionKey?: string | null; network: string | null },
  assertion: string,
  disclosed: string[]
): Promise<({ ok: true } & { session: PeerSessionView }) | Fail> {
  const conn = row.connId ? conns.get(row.connId) : null;
  const privateHex = await takeSessionKey(row.requestId);
  if (!conn || !conn.open) return { ok: false, error: 'connection_lost' };
  if (!privateHex || !row.peer || !row.sessionKey) {
    closeConn(conn);
    return { ok: false, error: 'connection_lost' };
  }
  try {
    const decoded = core.fabricUri.decodeFabricUri(assertion, { allowedTypes: ['PASSPORT_ASSERTION'] });
    if (!decoded.ok) throw new Error(`assertion: ${decoded.error}`);
    const assertionHash = await crypto.subtle.digest('SHA-256', decoded.buffer);
    const hashHex = Array.from(new Uint8Array(assertionHash), (b) => b.toString(16).padStart(2, '0')).join('');
    const wait = nextFrame(conn, ['PASSPORT_SESSION', 'PASSPORT_REFUSED']);
    conn.send(decoded.buffer);
    const got = await wait;
    if (got.type === 'PASSPORT_REFUSED') throw new Error(refusal(got.buffer));
    const read = core.passport.readPeerSession(got.buffer, { peer: row.peer, sessionKey: row.sessionKey, assertionHash: hashHex });
    if (!read.ok) throw new Error(`peer session: ${read.error}`);
    const verified = core.passport.verifyAssertion(assertion, {
      peer: row.peer,
      nonce: decoded.message.toFields().nonce,
      challengeHash: Buffer.from(decoded.message.toFields().challengeHash || []).toString('hex'),
      allow: disclosed
    });
    const record: PeerSessionRecord = {
      sessionId: read.session.sessionId,
      origin: row.origin,
      peer: row.peer,
      endpoint: conn.endpoint,
      transport: conn.kind,
      base: peerBase(conn.endpoint) || conn.endpoint,
      sessionKey: privateHex,
      sessionPubkey: row.sessionKey,
      identity: read.session.identity,
      network: row.network || (verified.ok ? verified.network : null),
      disclosed,
      wallet: verified.ok && verified.wallet ? verified.wallet : undefined,
      cosigner: verified.ok && verified.cosigner ? { pubkey: verified.cosigner.pubkey } : null,
      issuedAt: read.session.issuedAt,
      expiresAt: read.session.expiresAt
    };
    await saveSession(record);
    if (conn.kind === 'ws') sessionConn.set(record.sessionId, conn.id);
    else closeConn(conn);
    return { ok: true, session: sessionView(record) };
  } catch (err: unknown) {
    closeConn(conn);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The session's live socket, reopening and resuming with the session key when it dropped. */
async function socketFor (record: PeerSessionRecord): Promise<Conn> {
  const id = sessionConn.get(record.sessionId);
  const live = id ? conns.get(id) : null;
  if (live && live.open) return live;
  const conn = await openPeerConnection([record.endpoint]);
  try {
    const connect = core.passport.createConnect({ peer: record.peer });
    const challengeWait = nextFrame(conn, ['PASSPORT_CHALLENGE', 'PASSPORT_REFUSED']);
    conn.send(connect.message.toBuffer());
    const got = await challengeWait;
    if (got.type === 'PASSPORT_REFUSED') throw new Error(refusal(got.buffer));
    const resume = core.passport.createResume({ sessionId: record.sessionId, challenge: got.buffer, peer: record.peer }, keyFrom(record.sessionKey));
    const sessionWait = nextFrame(conn, ['PASSPORT_SESSION', 'PASSPORT_REFUSED']);
    conn.send(resume.message.toBuffer());
    const reply = await sessionWait;
    if (reply.type === 'PASSPORT_REFUSED') throw new Error(refusal(reply.buffer));
    const read = core.passport.readPeerSession(reply.buffer, { peer: record.peer, sessionKey: record.sessionPubkey });
    if (!read.ok || read.session.sessionId !== record.sessionId) throw new Error('the peer did not resume this session');
    sessionConn.set(record.sessionId, conn.id);
    return conn;
  } catch (err: unknown) {
    closeConn(conn);
    throw err;
  }
}

/**
 * A page calls a JSON-RPC method on a peer as its session.
 * @param m `{ sessionId, method, params }`
 * @param origin The origin the browser reported for the calling frame.
 */
export async function callPeerSession (m: Record<string, unknown>, origin: string | null): Promise<({ ok: true } & { result: unknown }) | Fail> {
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId.toLowerCase() : '';
  const method = typeof m.method === 'string' ? m.method : '';
  if (!/^[0-9a-f]{64}$/.test(sessionId) || !method || method.length > 128) return { ok: false, error: 'invalid_call' };
  const record = (await readPeerSessions())[sessionId];
  const allowed = sessionAnswersOrigin(record, origin);
  if (!allowed.ok) return allowed;
  if (record.transport === 'http') return { ok: false, error: 'http_peer_use_signed_requests' };
  const body = JSON.stringify({ method, params: Array.isArray(m.params) ? m.params : [] });
  if (body.length > MAX_PEER_CALL_CHARS) return { ok: false, error: 'call_too_large' };
  let conn: Conn;
  try {
    conn = await socketFor(record);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/unknown or expired session|session key/.test(message)) await dropSession(sessionId);
    return { ok: false, error: message };
  }
  const hash = await jsonCallHash(body);
  const frame = core.Message.fromVector(['JSONCall', body]).signWithKey(keyFrom(record.sessionKey));
  return new Promise((resolve) => {
    const timer = setTimeout(() => { conn.listeners.delete(on); resolve({ ok: false, error: 'peer did not answer' }); }, PEER_REPLY_TIMEOUT_MS * 2);
    function on (buffer: Buffer): void {
      if (frameType(buffer) !== 'JSON_CALL') return;
      let parsed: any = null;
      try {
        parsed = JSON.parse(core.Message.fromBuffer(buffer).body);
      } catch {
        return;
      }
      if (!parsed || parsed.method !== 'JSONCallResult' || !Array.isArray(parsed.params) || parsed.params[0] !== hash) return;
      clearTimeout(timer);
      conn.listeners.delete(on);
      if (parsed.error) resolve({ ok: false, error: String(parsed.error.message || 'call failed') });
      else resolve({ ok: true, result: parsed.params[1] });
    }
    conn.listeners.add(on);
    conn.send(frame.toBuffer());
  });
}

/**
 * Pure: the path and query Passport may sign for `url` on a session, or why
 * not. The request must go to the peer's own origin.
 */
export function signableTarget (record: PeerSessionRecord, url: unknown): { ok: true; target: string } | Fail {
  if (typeof url !== 'string' || url.length > 4096) return { ok: false, error: 'invalid_url' };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  if (parsed.origin !== record.base) return { ok: false, error: 'not_this_peer' };
  return { ok: true, target: `${parsed.pathname}${parsed.search}` };
}

/**
 * A page asks Passport to sign one HTTP request to the peer as its session:
 * an `X-Fabric-Request` bound to the method, path and query, and body.
 * @param m `{ sessionId, url, method, body }`
 * @param origin The origin the browser reported for the calling frame.
 */
export async function authorizePeerRequest (m: Record<string, unknown>, origin: string | null): Promise<({ ok: true } & { header: string }) | Fail> {
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId.toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(sessionId)) return { ok: false, error: 'invalid_request' };
  const record = (await readPeerSessions())[sessionId];
  const allowed = sessionAnswersOrigin(record, origin);
  if (!allowed.ok) return allowed;
  const target = signableTarget(record, m.url);
  if (!target.ok) return target;
  const method = typeof m.method === 'string' ? m.method.toUpperCase() : 'GET';
  if (!/^[A-Z]{1,16}$/.test(method)) return { ok: false, error: 'invalid_method' };
  const body = typeof m.body === 'string' ? m.body : '';
  if (body.length > MAX_PEER_REQUEST_BODY_CHARS) return { ok: false, error: 'body_too_large' };
  try {
    const signed = createPeerRequest({
      sessionId,
      peer: record.peer,
      method,
      target: target.target,
      body
    }, keyFrom(record.sessionKey));
    return { ok: true, header: signed.uri };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** A page ends a session it opened. */
export async function closePeerSession (m: Record<string, unknown>, origin: string | null): Promise<{ ok: true } | Fail> {
  const sessionId = typeof m.sessionId === 'string' ? m.sessionId.toLowerCase() : '';
  const record = (await readPeerSessions())[sessionId];
  const allowed = sessionAnswersOrigin(record, origin);
  if (!allowed.ok && allowed.error !== 'expired') return allowed;
  const id = sessionConn.get(sessionId);
  sessionConn.delete(sessionId);
  const conn = id ? conns.get(id) : null;
  if (conn && ![...sessionConn.values()].includes(conn.id)) closeConn(conn);
  await dropSession(sessionId);
  return { ok: true };
}
