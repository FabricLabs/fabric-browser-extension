/**
 * Canonical Fabric message type constants and notification-routing metadata.
 *
 * Aligns with `@fabric/core` application-namespace CONTRACT_MESSAGE bodies
 * plus a few Passport/Hub activity types. Product-only GoonCitizen types
 * (missions, GroupShare) are included so mesh peers running Passport still
 * surface them when gossip reaches the extension.
 *
 * @see @fabric/core/functions/applicationNamespaces.js
 * @see hub.fabric.pub/functions/messageTypes.js
 */

import { swallowNonFatal } from '../utils/nonFatal';

export const P2P_CHAT_MESSAGE = 'P2P_CHAT_MESSAGE' as const;
export const P2P_FILE_SEND = 'P2P_FILE_SEND' as const;
export const P2P_PEER_GOSSIP = 'P2P_PEER_GOSSIP' as const;
export const P2P_PEERING_OFFER = 'P2P_PEERING_OFFER' as const;

export const CONTRACT_PUBLISH = 'CONTRACT_PUBLISH' as const;
export const CONTRACT_MESSAGE = 'CONTRACT_MESSAGE' as const;
export const P2P_CONTRACT_PUBLISH = 'P2P_CONTRACT_PUBLISH' as const;
export const P2P_CONTRACT_MESSAGE = 'P2P_CONTRACT_MESSAGE' as const;

export const FEDERATION_CONTRACT_INVITE = 'FederationContractInvite' as const;
export const FEDERATION_CONTRACT_INVITE_RESPONSE = 'FederationContractInviteResponse' as const;
export const COLLABORATION_INVITATION = 'CollaborationInvitation' as const;

export const GROUP_CHAT = 'GroupChat' as const;
export const GROUP_CHANGE = 'GroupChange' as const;
export const GROUP_CHANGE_PROPOSAL = 'GroupChangeProposal' as const;
export const GROUP_CHANGE_VOTE = 'GroupChangeVote' as const;
export const GROUP_SHARE = 'GroupShare' as const;
export const CONTRACT_CAPABILITY_GRANT = 'ContractCapabilityGrant' as const;
export const CONTRACT_WITHDRAWAL_REQUEST = 'ContractWithdrawalRequest' as const;
export const CONTRACT_WITHDRAWAL_WITNESS = 'ContractWithdrawalWitness' as const;

/** GoonCitizen product bodies (app catalog; still visible on Passport mesh). */
export const MISSION_BROADCAST = 'MissionBroadcast' as const;
export const MISSION_CREATED = 'MissionCreated' as const;

export const DELEGATION_SIGNATURE_REQUEST = 'DELEGATION_SIGNATURE_REQUEST' as const;
export const DELEGATION_SIGNATURE_RESOLUTION = 'DELEGATION_SIGNATURE_RESOLUTION' as const;

export const TOMBSTONE = 'Tombstone' as const;
export const DOCUMENT_OFFER = 'DOCUMENT_OFFER' as const;
export const BITCOIN_BLOCK = 'BitcoinBlock' as const;
export const CONTRACT_PUBLISH_LOG = 'ContractPublish' as const;

export const INVENTORY_REQUEST = 'INVENTORY_REQUEST' as const;
export const INVENTORY_RESPONSE = 'INVENTORY_RESPONSE' as const;

export const CLIENT_NOTICE = 'CLIENT_NOTICE' as const;

export type NotificationPriority = 'high' | 'normal' | 'low' | 'silent';

export interface FabricMessageTypeDescriptor {
  type: string;
  label: string;
  notificationPriority: NotificationPriority;
  icon: string;
  /** True when this is an Application Resource Contract body / publish event. */
  arc?: boolean;
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
    icon: 'users',
    arc: true
  },
  {
    type: GROUP_CHANGE_PROPOSAL,
    label: 'Group change proposal',
    notificationPriority: 'high',
    icon: 'balance scale',
    arc: true
  },
  {
    type: CONTRACT_WITHDRAWAL_REQUEST,
    label: 'Contract withdrawal',
    notificationPriority: 'high',
    icon: 'money bill alternate',
    arc: true
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
    type: MISSION_BROADCAST,
    label: 'Mission offer',
    notificationPriority: 'high',
    icon: 'bullhorn',
    arc: true
  },
  {
    type: GROUP_SHARE,
    label: 'Group offer',
    notificationPriority: 'high',
    icon: 'share alternate',
    arc: true
  },
  {
    type: GROUP_CHANGE,
    label: 'Group membership change',
    notificationPriority: 'normal',
    icon: 'user plus',
    arc: true
  },
  {
    type: GROUP_CHANGE_VOTE,
    label: 'Proposal vote',
    notificationPriority: 'low',
    icon: 'check',
    arc: true
  },
  {
    type: FEDERATION_CONTRACT_INVITE_RESPONSE,
    label: 'Multisig invite response',
    notificationPriority: 'normal',
    icon: 'reply',
    arc: true
  },
  {
    type: CONTRACT_CAPABILITY_GRANT,
    label: 'Contract capability',
    notificationPriority: 'normal',
    icon: 'key',
    arc: true
  },
  {
    type: CONTRACT_WITHDRAWAL_WITNESS,
    label: 'Withdrawal witness',
    notificationPriority: 'normal',
    icon: 'pencil',
    arc: true
  },
  {
    type: GROUP_CHAT,
    label: 'Group chat',
    notificationPriority: 'normal',
    icon: 'comments',
    arc: true
  },
  {
    type: CONTRACT_PUBLISH_LOG,
    label: 'Contract published',
    notificationPriority: 'normal',
    icon: 'file code outline',
    arc: true
  },
  {
    type: MISSION_CREATED,
    label: 'Mission created',
    notificationPriority: 'low',
    icon: 'flag',
    arc: true
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

/** Descriptors marked as Application Resource Contract traffic. */
export function listArcMessageTypes (): FabricMessageTypeDescriptor[] {
  return NOTIFICATION_WORTHY_TYPES.filter((d) => d.arc === true);
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
 * Short human body for chrome.notifications from an ARC / domain payload.
 */
export function summarizeNotifiablePayload (
  messageType: string,
  payload: Record<string, unknown>,
  nodeHint?: string
): string {
  const node = nodeHint || 'Fabric';
  const note = typeof payload.note === 'string' ? payload.note.trim() : '';
  if (note) return `${node}: ${note.slice(0, 120)}`;

  const content = typeof payload.content === 'string' ? payload.content.trim()
    : (payload.object && typeof (payload.object as { content?: string }).content === 'string'
      ? String((payload.object as { content: string }).content).trim()
      : '');
  if (content) return `${node}: ${content.slice(0, 120)}`;

  if (messageType === GROUP_CHANGE_PROPOSAL || messageType === GROUP_CHANGE) {
    const action = typeof payload.action === 'string' ? payload.action : 'change';
    const member = typeof payload.member === 'string' ? payload.member.slice(0, 12) + '…' : '';
    const votes = payload.signatures && typeof payload.signatures === 'object'
      ? Object.keys(payload.signatures as object).length
      : null;
    const thr = payload.threshold != null ? Number(payload.threshold) : null;
    const tally = votes != null && thr != null ? ` · ${votes}/${thr} votes` : '';
    return `${node}: ${action}${member ? ' ' + member : ''}${tally}`;
  }

  if (messageType === GROUP_CHANGE_VOTE) {
    const pid = typeof payload.proposalId === 'string' ? payload.proposalId.slice(0, 10) : 'proposal';
    return `${node}: vote on ${pid}…`;
  }

  if (messageType === FEDERATION_CONTRACT_INVITE) {
    try {
      // Lazy require so unit tests without webpack still resolve when linked.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { summarizeMultisigWalletInvite } = require('../utils/federationWalletInvite');
      return summarizeMultisigWalletInvite(payload, node);
    } catch (_) {
      const name = typeof payload.groupName === 'string' ? payload.groupName
        : (typeof payload.name === 'string' ? payload.name : 'shared wallet');
      return `${node}: multisig invite · ${name}`;
    }
  }

  if (messageType === MISSION_BROADCAST) {
    const mission = payload.mission && typeof payload.mission === 'object'
      ? payload.mission as { title?: string }
      : null;
    const title = (mission && mission.title) || (typeof payload.title === 'string' ? payload.title : 'Mission');
    return `${node}: ${title}`;
  }

  const contractId = typeof payload.contractId === 'string' ? payload.contractId
    : (typeof payload.contract === 'string' ? payload.contract : null);
  if (contractId) return `${node}: contract ${contractId.slice(0, 12)}…`;

  const descriptor = findMessageTypeDescriptor(messageType);
  return `${descriptor ? descriptor.label : messageType} from ${node}`;
}

/**
 * Pull the inner domain `type` from a CONTRACT_MESSAGE / GenericMessage-shaped object.
 */
export function extractInnerMessageType (obj: Record<string, unknown> | null): string | null {
  if (!obj || typeof obj !== 'object') return null;
  const direct = typeof obj.type === 'string' ? obj.type : null;
  if (direct && findMessageTypeDescriptor(direct)) return direct;
  if (direct === CONTRACT_MESSAGE || direct === P2P_CONTRACT_MESSAGE ||
      direct === 'ContractMessage') {
    const inner = obj.object && typeof obj.object === 'object'
      ? obj.object as Record<string, unknown>
      : obj;
    const t = typeof inner.type === 'string' ? inner.type
      : (typeof inner['@type'] === 'string' ? inner['@type'] : null);
    return t;
  }
  if (direct === CONTRACT_PUBLISH || direct === P2P_CONTRACT_PUBLISH ||
      direct === CONTRACT_PUBLISH_LOG) {
    return CONTRACT_PUBLISH_LOG;
  }
  const nested = obj.object && typeof obj.object === 'object'
    ? obj.object as Record<string, unknown>
    : null;
  if (nested && typeof nested.type === 'string') return nested.type;
  return direct;
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
      try {
        obj = JSON.parse(obj.object.content);
      } catch (err: unknown) {
        swallowNonFatal('fabric-notifiable-inner-json', err);
      }
    }

    // Unwrap GenericMessage envelope
    if (obj && (obj.type === 'GenericMessage' || obj.type === 'GENERIC_MESSAGE') && typeof obj.object === 'object') {
      obj = obj.object;
    }

    if (!obj || typeof obj !== 'object') return null;

    // CONTRACT_MESSAGE { type, contract, object|…fields }
    if (obj.type === CONTRACT_MESSAGE || obj.type === P2P_CONTRACT_MESSAGE ||
        obj.type === 'ContractMessage') {
      const body = (obj.object != null && typeof obj.object === 'object')
        ? Object.assign({}, obj.object as object, {
          contractId: obj.contract || (obj.object as { contractId?: string }).contractId || null
        })
        : obj;
      const innerType = typeof body.type === 'string' ? body.type
        : (typeof body['@type'] === 'string' ? body['@type'] : null);
      if (!innerType) return null;
      const descriptor = findMessageTypeDescriptor(innerType);
      if (!descriptor) return null;
      return { messageType: innerType, payload: body as Record<string, unknown> };
    }

    if (obj.type === CONTRACT_PUBLISH || obj.type === P2P_CONTRACT_PUBLISH) {
      const descriptor = findMessageTypeDescriptor(CONTRACT_PUBLISH_LOG);
      if (!descriptor) return null;
      return {
        messageType: CONTRACT_PUBLISH_LOG,
        payload: (obj.object && typeof obj.object === 'object'
          ? obj.object
          : obj) as Record<string, unknown>
      };
    }

    if (typeof obj.type !== 'string') return null;

    const descriptor = findMessageTypeDescriptor(obj.type);
    if (!descriptor) return null;

    return { messageType: obj.type, payload: obj };
  } catch (err: unknown) {
    swallowNonFatal('fabric-notifiable-parse', err);
    return null;
  }
}
