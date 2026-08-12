'use strict';

/**
 * Parse Hub WebSocket frames (binary Fabric Message preferred) into
 * notification-worthy payloads. Hub HTTPServer broadcasts AMP `Message.toBuffer()`;
 * legacy plain-JSON string frames remain accepted.
 *
 * Application Resource Contracts arrive as `CONTRACT_MESSAGE` /
 * `P2P_CONTRACT_MESSAGE` (and publishes as `CONTRACT_PUBLISH`); those outer
 * frames are unwrapped to the inner body `type` for Passport notifications.
 */

import { swallowNonFatal } from '../utils/nonFatal';
import {
  BITCOIN_BLOCK,
  CONTRACT_MESSAGE,
  CONTRACT_PUBLISH,
  P2P_CHAT_MESSAGE,
  P2P_CONTRACT_MESSAGE,
  P2P_CONTRACT_PUBLISH,
  P2P_FILE_SEND,
  tryParseNotifiableMessage
} from './messageTypes';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const Message = require('@fabric/core/types/message');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MAGIC_BYTES, HEADER_SIZE } = require('@fabric/core/constants');

export type NotifiableFabricResult = {
  messageType: string;
  payload: Record<string, unknown>;
};

const MAX_RELAY_DEPTH = 4;

function asBuffer (data: unknown): Buffer | null {
  if (data == null) return null;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

function looksLikeFabricMagic (buf: Buffer): boolean {
  return Buffer.isBuffer(buf) && buf.length >= HEADER_SIZE && buf.readUInt32BE(0) === MAGIC_BYTES;
}

function parseJsonObject (raw: string): Record<string, unknown> | null {
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch (err: unknown) {
    swallowNonFatal('fabric-wire-notify-json', err);
  }
  return null;
}

function parseContractFrameBody (body: string): NotifiableFabricResult | null {
  const fromJson = tryParseNotifiableMessage(body);
  if (fromJson) return fromJson;
  // Body may already be the inner domain object without an outer type wrapper.
  const obj = parseJsonObject(body);
  if (!obj) return null;
  const wrapped = tryParseNotifiableMessage(JSON.stringify({
    type: CONTRACT_MESSAGE,
    contract: obj.contract || obj.contractId || null,
    object: obj
  }));
  return wrapped;
}

/**
 * Inspect a decoded AMP Message (and nested P2P_RELAY inners) for notify payloads.
 */
export function tryParseNotifiableWireMessage (
  message: { type?: string; body?: string; raw?: { data?: Buffer } },
  depth = 0
): NotifiableFabricResult | null {
  if (!message || depth > MAX_RELAY_DEPTH) return null;
  const type = String(message.type || '');

  if (type === 'P2P_RELAY') {
    const rawBody = message.raw && Buffer.isBuffer(message.raw.data) ? message.raw.data : null;
    if (rawBody && looksLikeFabricMagic(rawBody)) {
      try {
        return tryParseNotifiableWireMessage(Message.fromBuffer(rawBody), depth + 1);
      } catch (err: unknown) {
        swallowNonFatal('fabric-wire-notify-relay-raw', err);
        return null;
      }
    }
    const envelope = typeof message.body === 'string' ? parseJsonObject(message.body) : null;
    if (!envelope) return null;
    const original = envelope.original;
    const originalType = envelope.originalType != null ? String(envelope.originalType) : '';
    if (originalType === 'fabric-message' && typeof original === 'string') {
      try {
        const innerBuf = Buffer.from(original, 'base64');
        return tryParseNotifiableFabricFrame(innerBuf);
      } catch (err: unknown) {
        swallowNonFatal('fabric-wire-notify-relay-b64', err);
        return null;
      }
    }
    if (typeof original === 'string') {
      const fromJson = tryParseNotifiableMessage(original);
      if (fromJson) return fromJson;
      if (originalType === P2P_CHAT_MESSAGE || originalType === 'CHAT_MESSAGE' || originalType === 'ChatMessage') {
        const chat = parseJsonObject(original);
        if (chat) return { messageType: P2P_CHAT_MESSAGE, payload: chat };
      }
      if (
        originalType === CONTRACT_MESSAGE ||
        originalType === P2P_CONTRACT_MESSAGE ||
        originalType === CONTRACT_PUBLISH ||
        originalType === P2P_CONTRACT_PUBLISH
      ) {
        return parseContractFrameBody(original);
      }
    }
    return null;
  }

  if (
    type === 'GENERIC_MESSAGE' ||
    type === 'GenericMessage' ||
    type === 'P2P_BASE_MESSAGE'
  ) {
    return typeof message.body === 'string' ? tryParseNotifiableMessage(message.body) : null;
  }

  if (
    type === CONTRACT_MESSAGE ||
    type === P2P_CONTRACT_MESSAGE ||
    type === 'ContractMessage' ||
    type === CONTRACT_PUBLISH ||
    type === P2P_CONTRACT_PUBLISH
  ) {
    return typeof message.body === 'string' ? parseContractFrameBody(message.body) : null;
  }

  if (type === 'P2P_CHAT_MESSAGE' || type === 'CHAT_MESSAGE' || type === 'ChatMessage') {
    if (typeof message.body !== 'string') return null;
    const nested = tryParseNotifiableMessage(message.body);
    if (nested) return nested;
    const chat = parseJsonObject(message.body);
    if (chat) return { messageType: P2P_CHAT_MESSAGE, payload: chat };
    return null;
  }

  if (type === 'P2P_FILE_SEND') {
    const obj = typeof message.body === 'string' ? parseJsonObject(message.body) : null;
    return { messageType: P2P_FILE_SEND, payload: obj || { type: P2P_FILE_SEND } };
  }

  if (type === 'BITCOIN_BLOCK' || type === 'BitcoinBlock') {
    const obj = typeof message.body === 'string' ? parseJsonObject(message.body) : null;
    return {
      messageType: BITCOIN_BLOCK,
      payload: obj ? { ...obj, type: BITCOIN_BLOCK } : { type: BITCOIN_BLOCK }
    };
  }

  // Outer type itself may be notification-worthy (rare); try body as JSON first.
  if (typeof message.body === 'string') {
    const fromBody = tryParseNotifiableMessage(message.body);
    if (fromBody) return fromBody;
  }
  return null;
}

/**
 * Parse a WebSocket `message` event payload: binary Fabric Message or legacy JSON string.
 */
export function tryParseNotifiableFabricFrame (data: unknown): NotifiableFabricResult | null {
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (!trimmed) return null;
    // Rare: base64-ish binary misdelivered as string — only try JSON path.
    return tryParseNotifiableMessage(trimmed);
  }

  const buf = asBuffer(data);
  if (!buf || !looksLikeFabricMagic(buf)) return null;

  try {
    const message = Message.fromBuffer(buf);
    return tryParseNotifiableWireMessage(message, 0);
  } catch (err: unknown) {
    swallowNonFatal('fabric-wire-notify-fromBuffer', err);
    return null;
  }
}
