/**
 * Passport as a member of named federations — the same multisig every Hub
 * runs (`@fabric/core` `types/federation`): one descriptor, one Taproot vault,
 * k-of-n withdrawals signed by each member's own key.
 *
 * Passport has no Fabric peer, so a Hub carries its messages: frames are
 * signed here as `CONTRACT_MESSAGE`s and posted to the Hub's mailbox
 * (`/services/federations/messages`), which relays them to the mesh; frames
 * for this key are read back from the same mailbox and checked here (author
 * signature, federation id, membership, and every withdrawal PSBT rebuilt
 * before it is signed). The Hub is trusted for delivery only.
 *
 * When the mailbox Hub is itself a member it finalizes and broadcasts; in a
 * federation without it, the member whose signature completes the threshold
 * finalizes and hands the transaction to the Hub, which sends only spends of
 * that vault.
 */

import { Buffer } from 'buffer';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const core = require('../utils/loadFabricFederation');

export type WithdrawalSignature = { pubkey: string; leafHash: string; signature: string };

export interface FederationWithdrawal {
  requestId: string;
  fundedTxHex: string;
  vout: number;
  destinationAddress: string;
  amountSats: number;
  feeSats: number;
  changeSats: number;
  psbtBase64: string;
  /** x-only pubkey of the member that asked. */
  requestedBy: string;
  /** Signatures by x-only member pubkey. */
  signatures: Record<string, WithdrawalSignature[]>;
  status: 'pending' | 'broadcast';
  txid: string | null;
  error: string | null;
  at: number;
}

export interface FederationRecord {
  id: string;
  name: string | null;
  descriptor: any;
  vaultAddress: string;
  /** Compressed pubkey of the member that created it. */
  publisher: string;
  /** Contact hints from the invite, by compressed pubkey. */
  members: Array<{ pubkey: string; url: string | null; alias: string | null }>;
  /** This member's answer; `invited` until it answers. */
  status: 'invited' | 'accepted' | 'declined';
  /** Answers by x-only member pubkey (the publisher counts as accepted). */
  responses: Record<string, boolean>;
  withdrawals: Record<string, FederationWithdrawal>;
  createdAt: number;
  updatedAt: number;
}

export interface FederationMemberState {
  type: 'PassportFederations';
  version: 1;
  pubkey: string;
  hubBase: string;
  cursor: number;
  records: Record<string, FederationRecord>;
}

export interface HubFederationsStatus {
  network: string;
  pubkey: string | null;
}

export interface FederationVault {
  federationId: string;
  address: string;
  balanceSats: number;
  utxos: Array<{ txid: string; vout: number; amountSats: number; txHex?: string }>;
}

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

export interface FederationMemberOptions {
  hubBase: string;
  privateKeyHex: string;
  state?: FederationMemberState | null;
  fetch?: FetchLike;
  now?: () => number;
}

export function federationsAvailable (): boolean {
  return !!(core && core.Federation && core.Message && core.Key && core.fabricUri);
}

function messageTypes (): Record<string, string> {
  return core.Federation.MESSAGE_TYPES;
}

export class FederationMember {
  readonly hubBase: string;
  private key: any;
  private secret: Buffer;
  private fetchImpl: FetchLike;
  private now: () => number;
  private state: FederationMemberState;
  private hubStatus: HubFederationsStatus | null = null;

  constructor (opts: FederationMemberOptions) {
    if (!federationsAvailable()) throw new Error('Federations need a newer @fabric/core in this build');
    const hex = String(opts.privateKeyHex || '').replace(/^0x/i, '');
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('unlock this identity to use federations');
    this.key = new core.Key({ private: hex });
    this.secret = Buffer.from(hex, 'hex');
    this.hubBase = String(opts.hubBase || '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(this.hubBase)) throw new Error('choose a Hub to carry federation messages');
    this.fetchImpl = opts.fetch || ((url, init) => fetch(url, init) as any);
    this.now = opts.now || (() => Date.now());
    const saved = opts.state;
    const fresh = !saved || saved.type !== 'PassportFederations' || saved.pubkey !== this.pubkey;
    this.state = fresh
      ? { type: 'PassportFederations', version: 1, pubkey: this.pubkey, hubBase: this.hubBase, cursor: 0, records: {} }
      : { ...saved, records: { ...saved.records } };
    // Mailbox sequence numbers belong to one Hub.
    if (this.state.hubBase !== this.hubBase) {
      this.state.hubBase = this.hubBase;
      this.state.cursor = 0;
    }
  }

  /** Compressed member pubkey (the identity's Fabric key). */
  get pubkey (): string {
    return String(this.key.pubkey).toLowerCase();
  }

  get xonly (): string {
    return this.pubkey.slice(2);
  }

  export (): FederationMemberState {
    return JSON.parse(JSON.stringify(this.state));
  }

  list (): FederationRecord[] {
    return Object.values(this.state.records).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get (federationId: string): FederationRecord | null {
    return this.state.records[String(federationId || '').toLowerCase()] || null;
  }

  /** Invites still waiting for this member's answer. */
  pendingInvites (): FederationRecord[] {
    return this.list().filter((r) => r.status === 'invited');
  }

  /** Withdrawals this member has not signed yet. */
  pendingApprovals (): Array<{ record: FederationRecord; withdrawal: FederationWithdrawal }> {
    const out: Array<{ record: FederationRecord; withdrawal: FederationWithdrawal }> = [];
    for (const record of this.list()) {
      if (record.status !== 'accepted') continue;
      for (const w of Object.values(record.withdrawals)) {
        if (w.status === 'pending' && !w.signatures[this.xonly]) out.push({ record, withdrawal: w });
      }
    }
    return out;
  }

  /** Members that have accepted (x-only), the publisher included. */
  accepted (record: FederationRecord): string[] {
    return Object.keys(record.responses).filter((x) => record.responses[x] === true);
  }

  /** The Hub's network and federation key (cached). */
  async hub (): Promise<HubFederationsStatus> {
    if (this.hubStatus) return this.hubStatus;
    const data = await this.request('GET', '/services/federations');
    this.hubStatus = { network: String(data.network || ''), pubkey: data.pubkey ? String(data.pubkey).toLowerCase() : null };
    return this.hubStatus;
  }

  /** Read new frames for this key from the Hub's mailbox. */
  async sync (): Promise<{ received: number; rejected: number }> {
    let received = 0;
    let rejected = 0;
    for (let page = 0; page < 20; page++) {
      const q = `pubkey=${encodeURIComponent(this.pubkey)}&since=${this.state.cursor}`;
      const data = await this.request('GET', `/services/federations/messages?${q}`);
      for (const m of Array.isArray(data.messages) ? data.messages : []) {
        try {
          if (this.receive(String(m.fabric || ''))) received++;
        } catch (_) {
          rejected++;
        }
      }
      this.state.cursor = Math.max(this.state.cursor, Number(data.next) || 0);
      if (!data.more) break;
    }
    // Withdrawals that reached the threshold while this member was away.
    for (const record of this.list()) {
      for (const w of Object.values(record.withdrawals)) {
        if (w.status === 'pending') await this.maybeFinalize(record, w);
      }
    }
    return { received, rejected };
  }

  /**
   * Apply one signed frame. Returns false when it does not concern this member;
   * throws when it is forged or does not check out.
   */
  receive (uri: string): boolean {
    const T = messageTypes();
    const decoded = core.fabricUri.decodeFabricUri(uri, { allowedTypes: ['CONTRACT_MESSAGE'] });
    if (!decoded || !decoded.ok) throw new Error(decoded && decoded.error ? String(decoded.error) : 'not a fabric frame');
    if (!decoded.signed || !decoded.author) throw new Error('unsigned frame');
    const signer = String(decoded.author).toLowerCase();
    const body = JSON.parse(String(decoded.message.data || ''));
    if (!core.Federation.isMessage(body)) return false;
    const at = this.now();

    if (body.type === T.invite) {
      const descriptor = core.Federation.verifyInvite(body, signer);
      if (!core.Federation.isValidator(descriptor, this.pubkey)) return false;
      const id = core.Federation.descriptorId(descriptor);
      const known = this.state.records[id];
      if (known) return false;
      const publisher = String(descriptor.publisher);
      const own = publisher.slice(2) === this.xonly;
      this.state.records[id] = {
        id,
        name: typeof body.name === 'string' ? body.name.slice(0, 120) : null,
        descriptor,
        vaultAddress: core.Federation.vaultForDescriptor(descriptor).address,
        publisher,
        members: Array.isArray(body.members)
          ? body.members.filter((m: any) => m && core.Federation.isValidator(descriptor, m.pubkey)).map((m: any) => ({
            pubkey: String(m.pubkey).toLowerCase(),
            url: typeof m.url === 'string' ? m.url.slice(0, 300) : null,
            alias: typeof m.alias === 'string' ? m.alias.slice(0, 80) : null
          }))
          : descriptor.validators.map((pubkey: string) => ({ pubkey, url: null, alias: null })),
        status: own ? 'accepted' : 'invited',
        responses: { [publisher.slice(2)]: true },
        withdrawals: {},
        createdAt: at,
        updatedAt: at
      };
      return true;
    }

    const record = this.state.records[String(body.federationId || '').toLowerCase()];
    if (!record) return false;
    const from = core.Federation.verifySender(record.descriptor, body, signer);
    record.updatedAt = at;

    if (body.type === T.response) {
      record.responses[from] = body.accept === true;
      if (from === this.xonly) record.status = body.accept === true ? 'accepted' : 'declined';
      return true;
    }
    if (body.type === T.withdrawal) {
      const requestId = String(body.requestId || '').toLowerCase();
      if (record.withdrawals[requestId]) return false;
      const prepared = core.Federation.verifyWithdrawalRequest(record.descriptor, body);
      record.withdrawals[requestId] = {
        requestId,
        fundedTxHex: String(body.fundedTxHex),
        vout: prepared.vout,
        destinationAddress: String(body.destinationAddress),
        amountSats: prepared.amountSats,
        feeSats: prepared.feeSats,
        changeSats: prepared.changeSats,
        psbtBase64: prepared.psbtBase64,
        requestedBy: from,
        signatures: {},
        status: 'pending',
        txid: null,
        error: null,
        at
      };
      return true;
    }
    if (body.type === T.signature) {
      const w = record.withdrawals[String(body.requestId || '').toLowerCase()];
      if (!w || w.signatures[from]) return false;
      const own = (Array.isArray(body.signatures) ? body.signatures : []).filter((s: any) => s && String(s.pubkey).toLowerCase() === from);
      if (!own.length) throw new Error('signature message carries no signature from its sender');
      // Checks each signature against the transaction before keeping it.
      core.Federation.addWithdrawalSignatures({ descriptor: record.descriptor, psbtBase64: w.psbtBase64, signatures: own });
      w.signatures[from] = own.map((s: any) => ({ pubkey: from, leafHash: String(s.leafHash), signature: String(s.signature) }));
      return true;
    }
    if (body.type === T.broadcast) {
      const w = record.withdrawals[String(body.requestId || '').toLowerCase()];
      if (!w || w.status === 'broadcast') return false;
      if (!/^[0-9a-f]{64}$/i.test(String(body.txid || ''))) throw new Error('broadcast notice without a txid');
      w.status = 'broadcast';
      w.txid = String(body.txid).toLowerCase();
      w.error = null;
      return true;
    }
    return false;
  }

  /**
   * Create a federation of this identity and `members` (compressed pubkeys),
   * optionally with the mailbox Hub as a member, and invite them.
   */
  async create (opts: { name?: string; threshold: number; members: string[]; includeHub?: boolean }): Promise<FederationRecord> {
    const hub = await this.hub();
    const validators = [this.pubkey, ...(opts.members || []).map((m) => String(m || '').trim().toLowerCase()).filter(Boolean)];
    if (opts.includeHub) {
      if (!hub.pubkey) throw new Error('this Hub has no federation key');
      validators.push(hub.pubkey);
    }
    const descriptor = core.Federation.buildDescriptor({
      validators,
      threshold: Number(opts.threshold),
      network: hub.network,
      publisher: this.pubkey
    });
    if (descriptor.validators.length < 2) throw new Error('a federation needs at least one other member');
    if (descriptor.threshold < 2) throw new Error('a federation needs at least 2 signatures; a 1-key wallet is just a wallet');
    const hints = descriptor.validators.map((pubkey: string) => ({
      pubkey,
      url: (opts.includeHub && pubkey === hub.pubkey) ? this.hubBase : null
    }));
    const body = core.Federation.inviteMessage({ descriptor, name: opts.name ? String(opts.name).trim().slice(0, 120) : null, members: hints });
    await this.post(body);
    return this.state.records[body.federationId];
  }

  async respond (federationId: string, accept: boolean): Promise<FederationRecord> {
    const record = this.require(federationId);
    if (record.publisher.slice(2) === this.xonly) throw new Error('you created this federation');
    await this.post(core.Federation.responseMessage(record.id, accept === true));
    return record;
  }

  /** Spendable vault coins (read through the Hub's node). */
  async vault (federationId: string): Promise<FederationVault> {
    const record = this.require(federationId);
    const data = await this.request('GET', `/services/federations/${record.id}/vault`);
    if (String(data.address) !== record.vaultAddress) throw new Error('the Hub reported another vault address');
    return data as FederationVault;
  }

  /** Ask to pay `amountSats` out of the vault, and sign it. */
  async requestWithdrawal (federationId: string, opts: { destinationAddress: string; amountSats: number; feeSats: number }): Promise<FederationWithdrawal> {
    const record = this.require(federationId);
    if (record.status !== 'accepted') throw new Error('accept the federation first');
    const amountSats = Math.floor(Number(opts.amountSats));
    const feeSats = Math.floor(Number(opts.feeSats));
    const vault = await this.vault(record.id);
    const coin = vault.utxos
      .filter((u) => u.txHex && u.amountSats >= amountSats + feeSats)
      .sort((a, b) => a.amountSats - b.amountSats)[0];
    if (!coin) throw new Error(`no single vault coin covers ${amountSats + feeSats} sats`);
    const prepared = core.Federation.prepareWithdrawal({
      descriptor: record.descriptor,
      fundedTxHex: coin.txHex,
      vout: coin.vout,
      destinationAddress: String(opts.destinationAddress || '').trim(),
      amountSats,
      feeSats
    });
    await this.post(core.Federation.withdrawalMessage(record.id, {
      requestId: prepared.requestId,
      fundedTxHex: String(coin.txHex).toLowerCase(),
      vout: prepared.vout,
      destinationAddress: String(opts.destinationAddress || '').trim(),
      amountSats,
      feeSats
    }));
    await this.approve(record.id, prepared.requestId);
    return record.withdrawals[prepared.requestId];
  }

  /** Sign a withdrawal this member has rebuilt and checked. */
  async approve (federationId: string, requestId: string): Promise<FederationWithdrawal> {
    const record = this.require(federationId);
    if (record.status !== 'accepted') throw new Error('accept the federation first');
    const w = record.withdrawals[String(requestId || '').toLowerCase()];
    if (!w) throw new Error('unknown withdrawal request');
    if (w.status !== 'pending') throw new Error('this withdrawal is already on chain');
    if (!w.signatures[this.xonly]) {
      const signed = core.Federation.signWithdrawal({ psbtBase64: w.psbtBase64, privateKey: this.secret });
      await this.post(core.Federation.signatureMessage(record.id, w.requestId, signed.signatures));
    }
    await this.maybeFinalize(record, w);
    return w;
  }

  private async maybeFinalize (record: FederationRecord, w: FederationWithdrawal): Promise<boolean> {
    if (w.status !== 'pending') return false;
    const signers = Object.keys(w.signatures);
    if (signers.length < record.descriptor.threshold) return false;
    const hub = await this.hub().catch(() => null);
    // A member Hub broadcasts on its own; two finalizers would race.
    if (hub && hub.pubkey && core.Federation.isValidator(record.descriptor, hub.pubkey)) return false;
    try {
      const merged = core.Federation.addWithdrawalSignatures({
        descriptor: record.descriptor,
        psbtBase64: w.psbtBase64,
        signatures: signers.flatMap((x) => w.signatures[x])
      });
      const done = core.Federation.finalizeWithdrawal({ descriptor: record.descriptor, psbtBase64: merged.psbtBase64 });
      const sent = await this.request('POST', `/services/federations/${record.id}/transactions`, { txHex: done.txHex });
      const txid = String(sent.txid || done.txid).toLowerCase();
      w.status = 'broadcast';
      w.txid = txid;
      w.error = null;
      try {
        await this.post(core.Federation.broadcastMessage(record.id, w.requestId, txid));
      } catch (err: unknown) {
        w.error = `sent, but the broadcast notice failed: ${err instanceof Error ? err.message : String(err)}`;
      }
      return true;
    } catch (err: unknown) {
      w.error = err instanceof Error ? err.message : String(err);
      return false;
    }
  }

  private require (federationId: string): FederationRecord {
    const record = this.get(federationId);
    if (!record) throw new Error('unknown federation');
    return record;
  }

  /** Sign a body, hand it to the Hub, and apply it here. */
  private async post (body: object): Promise<void> {
    const msg = core.Message.fromVector(['CONTRACT_MESSAGE', JSON.stringify(body)]);
    msg.signWithKey(this.key);
    const uri = core.fabricUri.encodeFabricUri(msg);
    await this.request('POST', '/services/federations/messages', { fabric: uri });
    this.receive(uri);
  }

  private async request (method: 'GET' | 'POST', path: string, body?: object): Promise<any> {
    const res = await this.fetchImpl(`${this.hubBase}${path}`, {
      method,
      headers: body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 404 && /^\/services\/federations(\?|$)/.test(path)) throw new Error('this Hub does not carry federations');
      throw new Error(data && data.message ? String(data.message) : `Hub answered HTTP ${res.status}`);
    }
    return data;
  }
}
