'use strict';

/**
 * Canonical Fabric message type constants and notification-routing metadata.
 *
 * These align with the Fabric protocol (`@fabric/core` wire types + inner domain types)
 * and are application-agnostic — any Fabric node (Hub, Sensemaker, custom service) may
 * emit them. The extension uses this registry to decide which messages deserve a desktop
 * notification and how to render them.
 *
 * @see hub.fabric.pub/functions/fabricMessageRegistry.js — outer wire opcodes
 * @see hub.fabric.pub/functions/messageTypes.js — inner domain constants
 * @see hub.fabric.pub/functions/federationContractInvite.js — invite JSON shape
 */

export const P2P_CHAT_MESSAGE = 'P2P_CHAT_MESSAGE' as const;
export const P2P_FILE_SEND = 'P2P_FILE_SEND' as const;
export const P2P_PEER_GOSSIP = 'P2P_PEER_GOSSIP' as const;
export const P2P_PEERING_OFFER = 'P2P_PEERING_OFFER' as const;

export const FEDERATION_CONTRACT_INVITE = 'FederationContractInvite' as const;
export const FEDERATION_CONTRACT_INVITE_RESPONSE = 'FederationContractInviteResponse' as const;
export const COLLABORATION_INVITATION = 'CollaborationInvitation' as const;

export const DELEGATION_SIGNATURE_REQUEST = 'DELEGATION_SIGNATURE_REQUEST' as const;
export const DELEGATION_SIGNATURE_RESOLUTION = 'DELEGATION_SIGNATURE_RESOLUTION' as const;

export const TOMBSTONE = 'Tombstone' as const;
export const DOCUMENT_OFFER = 'DOCUMENT_OFFER' as const;
export const BITCOIN_BLOCK = 'BitcoinBlock' as const;

export const INVENTORY_REQUEST = 'INVENTORY_REQUEST' as const;
export const INVENTORY_RESPONSE = 'INVENTORY_RESPONSE' as const;

export const CLIENT_NOTICE = 'CLIENT_NOTICE' as const;

export type NotificationPriority = 'high' | 'normal' | 'low' | 'silent';

export interface FabricMessageTypeDescriptor {
  type: string;
  label: string;
  notificationPriority: NotificationPriority;
  icon: string;
}

/**
 * Message types that may warrant a desktop notification, ordered by importance.
 * `notificationPriority` controls chrome.notifications urgency + user preference defaults.
 */
export const NOTIFICATION_WORTHY_TYPES: readonly FabricMessageTypeDescriptor[] = [
  {
    type: FEDERATION_CONTRACT_INVITE,
    label: 'Multisig wallet invitation',
    notificationPriority: 'high',
    icon: 'users'
  },
  {
    type: COLLABORATION_INVITATION,
    label: 'Collaboration invitation',
    notificationPriority: 'high',
    icon: 'handshake outline'
  },
  {
    type: DELEGATION_SIGNATURE_REQUEST,
    label: 'Signature request',
    notificationPriority: 'high',
    icon: 'pencil alternate'
  },
  {
    type: P2P_CHAT_MESSAGE,
    label: 'Chat message',
    notificationPriority: 'normal',
    icon: 'comment'
  },
  {
    type: P2P_FILE_SEND,
    label: 'File received',
    notificationPriority: 'normal',
    icon: 'file'
  },
  {
    type: DOCUMENT_OFFER,
    label: 'Document offer',
    notificationPriority: 'normal',
    icon: 'file alternate outline'
  },
  {
    type: CLIENT_NOTICE,
    label: 'Wallet notice',
    notificationPriority: 'normal',
    icon: 'bitcoin'
  },
  {
    type: TOMBSTONE,
    label: 'Content removed',
    notificationPriority: 'low',
    icon: 'trash alternate'
  },
  {
    type: BITCOIN_BLOCK,
    label: 'New block',
    notificationPriority: 'silent',
    icon: 'cube'
  }
] as const;

export function findMessageTypeDescriptor (type: string): FabricMessageTypeDescriptor | null {
  return NOTIFICATION_WORTHY_TYPES.find(d => d.type === type) ?? null;
}

export interface FederationInvitePayload {
  inviteId: string;
  inviterHubId: string | null;
  contractId: string | null;
  note: string | null;
  invitedAt: number;
  spendingTerms?: { mode: string; value: number } | null;
  proposedPolicy?: { validators: string[]; threshold: number } | null;
}

export interface CollaborationInvitePayload {
  type: typeof COLLABORATION_INVITATION;
  invitationId?: string;
  groupId?: string;
  groupName?: string;
  fromPeerId?: string;
}

/**
 * Attempt to parse a raw JSON string (or an outer P2P_CHAT_MESSAGE envelope)
 * into one of the known notification-worthy inner payloads.
 */
export function tryParseNotifiableMessage (raw: string): {
  messageType: string;
  payload: Record<string, unknown>;
} | null {
  try {
    let obj = JSON.parse(raw);

    // Unwrap P2P_CHAT_MESSAGE envelope
    if (obj && obj.type === P2P_CHAT_MESSAGE && obj.object && typeof obj.object.content === 'string') {
      try { obj = JSON.parse(obj.object.content); } catch { /* not JSON content */ }
    }

    // Unwrap GenericMessage envelope
    if (obj && (obj.type === 'GenericMessage' || obj.type === 'GENERIC_MESSAGE') && typeof obj.object === 'object') {
      obj = obj.object;
    }

    if (!obj || typeof obj.type !== 'string') return null;

    const descriptor = findMessageTypeDescriptor(obj.type);
    if (!descriptor) return null;

    return { messageType: obj.type, payload: obj };
  } catch {
    return null;
  }
}
