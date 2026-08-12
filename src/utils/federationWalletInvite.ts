'use strict';

/**
 * Multisig / federation wallet invites — thin Passport edge over
 * `@fabric/http/functions/federationContractInvite` + Hub JSON-RPC
 * (`SendPeerMessage`, `GetNetworkStatus`).
 */

import { swallowNonFatal } from './nonFatal';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const inviteHttp = require('./loadFederationContractInvite');

export const PUBKEY_RE = /^0[23][0-9a-fA-F]{64}$/;

export type SpendingTerms = { mode: 'percent' | 'sats'; value: number };
export type ProposedPolicy = { validators: string[]; threshold: number };

export type FederationWalletInvite = {
  type: string;
  v: number;
  inviteId: string;
  inviterHubId?: string | null;
  contractId?: string | null;
  note?: string | null;
  invitedAt?: number;
  spendingTerms?: SpendingTerms | null;
  proposedPolicy?: ProposedPolicy | null;
  termsSummary?: string | null;
  groupName?: string | null;
  groupId?: string | null;
  role?: string | null;
};

export function parseFederationWalletInvite (value: unknown): FederationWalletInvite | null {
  try {
    return inviteHttp.parseFederationContractInviteLoose(value) as FederationWalletInvite | null;
  } catch (err: unknown) {
    swallowNonFatal('federation-wallet-invite-parse', err);
    return null;
  }
}

export function formatInviteSpendingSummary (invite: FederationWalletInvite | Record<string, unknown>): string {
  try {
    return String(inviteHttp.formatFederationInviteSpendingSummary(invite) || '');
  } catch (_) {
    return '';
  }
}

export function normalizeProposedPolicy (raw: unknown): ProposedPolicy | null {
  return inviteHttp.normalizeProposedPolicy(raw) as ProposedPolicy | null;
}

export function normalizeSpendingTerms (raw: unknown): SpendingTerms | null {
  return inviteHttp.normalizeSpendingTerms(raw) as SpendingTerms | null;
}

/**
 * Human one-liner for notifications: "2-of-3 · cap 10% · Multisig wallet".
 */
export function summarizeMultisigWalletInvite (
  payload: Record<string, unknown>,
  nodeHint?: string
): string {
  const invite = parseFederationWalletInvite(payload) || (payload as FederationWalletInvite);
  const node = nodeHint || 'Fabric';
  const parts: string[] = [];
  const policy = normalizeProposedPolicy(invite.proposedPolicy);
  if (policy) parts.push(`${policy.threshold}-of-${policy.validators.length}`);
  const cap = formatInviteSpendingSummary(invite);
  if (cap) {
    const short = cap.replace(/^Spending cap:\s*/i, 'cap ');
    parts.push(short);
  } else if (invite.note) {
    parts.push(String(invite.note).slice(0, 60));
  }
  const name = invite.groupName || (typeof payload.name === 'string' ? payload.name : null);
  if (name) parts.push(String(name));
  if (!parts.length) parts.push('multisig / co-signer invite');
  return `${node}: ${parts.join(' · ')}`;
}

export function buildMultisigWalletInviteJson (fields: {
  inviteId: string;
  inviterHubId: string | null;
  contractId?: string | null;
  note?: string | null;
  spendingTerms?: SpendingTerms | null;
  proposedPolicy?: ProposedPolicy | null;
  termsSummary?: string | null;
  groupName?: string | null;
}): string {
  return inviteHttp.buildFederationContractInviteJson(fields);
}

export function buildMultisigWalletInviteResponseJson (fields: {
  inviteId: string;
  accept: boolean;
  responderPubkey?: string | null;
}): string {
  return inviteHttp.buildFederationContractInviteResponseJson(fields);
}

async function hubRpc (
  hubBase: string,
  method: string,
  params: unknown[] = []
): Promise<Record<string, unknown>> {
  const base = hubBase.replace(/\/+$/, '');
  const res = await fetch(`${base}/services/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return (body.result && typeof body.result === 'object') ? body.result as Record<string, unknown> : {};
}

export type HubPeerRow = { id: string; address: string; label?: string | null };

/**
 * Connected Fabric peers from Hub GetNetworkStatus (excludes browser bridges).
 */
export async function listHubPeersForInvite (hubBase: string): Promise<HubPeerRow[]> {
  const status = await hubRpc(hubBase, 'GetNetworkStatus', []);
  const peers = Array.isArray(status.peers) ? status.peers : [];
  const out: HubPeerRow[] = [];
  for (const p of peers) {
    if (!p || typeof p !== 'object') continue;
    const row = p as Record<string, unknown>;
    const id = String(row.id || '');
    const address = String(row.address || '');
    if (id.startsWith('fabric-bridge-') || address.startsWith('fabric-bridge-')) continue;
    if (!id && !address) continue;
    out.push({
      id: id || address,
      address: address || id,
      label: typeof row.label === 'string' ? row.label : (typeof row.nickname === 'string' ? row.nickname : null)
    });
  }
  return out;
}

/**
 * Send invite JSON as peer chat content (same path as Hub Co-signer session panel).
 */
export async function sendPeerChatJson (
  hubBase: string,
  peerIdOrAddress: string,
  jsonText: string
): Promise<Record<string, unknown>> {
  const result = await hubRpc(hubBase, 'SendPeerMessage', [peerIdOrAddress, jsonText]);
  if (result.status === 'error') {
    throw new Error(String(result.message || 'SendPeerMessage failed'));
  }
  return result;
}

/**
 * Create a v2 multisig wallet invite and deliver it to a connected peer.
 */
export async function publishMultisigWalletInvite (opts: {
  hubBase: string;
  peerIdOrAddress: string;
  inviterHubId: string | null;
  inviterPubkey: string;
  peerPubkey?: string | null;
  threshold: number;
  spendingTerms: SpendingTerms;
  note?: string;
  termsSummary?: string;
  contractId?: string | null;
  groupName?: string | null;
}): Promise<{ inviteId: string; inviteJson: string }> {
  const validators = [opts.inviterPubkey];
  if (opts.peerPubkey && PUBKEY_RE.test(opts.peerPubkey) &&
      opts.peerPubkey.toLowerCase() !== opts.inviterPubkey.toLowerCase()) {
    validators.push(opts.peerPubkey);
  }
  const thr = Math.max(1, Math.min(opts.threshold, validators.length));
  const proposedPolicy = normalizeProposedPolicy({ validators, threshold: thr });
  if (!proposedPolicy) throw new Error('invalid proposed policy');
  const spendingTerms = normalizeSpendingTerms(opts.spendingTerms);
  if (!spendingTerms) throw new Error('invalid spending terms');

  const inviteId = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const inviteJson = buildMultisigWalletInviteJson({
    inviteId,
    inviterHubId: opts.inviterHubId,
    contractId: opts.contractId || null,
    note: opts.note || null,
    spendingTerms,
    proposedPolicy,
    termsSummary: opts.termsSummary || null,
    groupName: opts.groupName || 'Shared wallet'
  });

  await sendPeerChatJson(opts.hubBase, opts.peerIdOrAddress, inviteJson);
  return { inviteId, inviteJson };
}

/**
 * Accept or reject a received invite (sends FederationContractInviteResponse).
 */
export async function respondToMultisigWalletInvite (opts: {
  hubBase: string;
  invite: FederationWalletInvite;
  accept: boolean;
  responderPubkey: string | null;
  /** Override reply target (defaults to inviterHubId). */
  toPeerId?: string | null;
}): Promise<void> {
  const to = String(opts.toPeerId || opts.invite.inviterHubId || '').trim();
  if (!to) throw new Error('inviter peer id missing — cannot reply');
  if (opts.accept && (!opts.responderPubkey || !PUBKEY_RE.test(opts.responderPubkey))) {
    throw new Error('unlock a compressed secp256k1 identity before accepting');
  }
  const json = buildMultisigWalletInviteResponseJson({
    inviteId: opts.invite.inviteId,
    accept: opts.accept,
    responderPubkey: opts.accept ? opts.responderPubkey : null
  });
  await sendPeerChatJson(opts.hubBase, to, json);
}
