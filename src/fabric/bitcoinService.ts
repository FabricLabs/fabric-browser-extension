'use strict';

/**
 * Bitcoin wallet service for Fabric Passport.
 *
 * Uses a Fabric node's `/services/bitcoin` HTTP API as a block-explorer and wallet backend.
 * Keys never leave the extension; only xpub-derived watch addresses are sent for balance lookups
 * (`GET …/services/bitcoin/xpub?xpub=…&addresses=…`).
 *
 * Compatible with any Fabric node that exposes the standard Bitcoin service surface
 * (hub.fabric.pub, local `node scripts/hub.js`, or any `@fabric/http` instance with Bitcoin enabled).
 */

import { BIP32Factory, BIP32Interface } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { swallowNonFatal } from '../utils/nonFatal';

bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout (url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface FabricBitcoinNodeConfig {
  baseUrl: string;
}

/** Optional auth for Hub watch-only xpub routes when `FABRIC_BITCOIN_XPUB_QUERY_TOKEN` is set. */
export interface FabricBitcoinHttpOpts {
  xpubQueryToken?: string | null;
}

function trimXpubQueryToken (t?: string | null): string | undefined {
  const s = String(t ?? '').trim();
  return s || undefined;
}

function xpubQueryAuthHeaders (xpubQueryToken?: string | null): Record<string, string> {
  const tok = trimXpubQueryToken(xpubQueryToken);
  if (!tok) return {};
  return { 'X-Fabric-Xpub-Query-Token': tok };
}

export interface WalletBalance {
  balanceSats: number;
  confirmedSats: number;
  unconfirmedSats: number;
  network: string | null;
  height: number | null;
  updatedAt: number;
}

export interface WalletTransaction {
  txid: string;
  amount: number;
  confirmations: number;
  time: number;
  category: string;
  address?: string;
  fee?: number;
  label?: string;
}

export interface BitcoinStatus {
  available: boolean;
  network: string | null;
  height: number | null;
  bestBlockHash: string | null;
  mempoolTxCount: number | null;
}

function networkFromName (name: string): bitcoin.networks.Network {
  const n = String(name || 'regtest').toLowerCase();
  if (n === 'mainnet' || n === 'main') return bitcoin.networks.bitcoin;
  if (n === 'testnet' || n === 'signet' || n === 'test') return bitcoin.networks.testnet;
  return bitcoin.networks.regtest;
}

/**
 * Decode an extended public key regardless of whether the chain is regtest/testnet/mainnet.
 * Fabric / Hub identities typically store a mainnet-prefixed `xpub` (BIP32 version bytes) while
 * the node runs regtest — `bip32.fromBase58(xpub, regtest)` rejects that mismatch.
 */
function decodeBip32Root (xpub: string): BIP32Interface | null {
  const trimmed = String(xpub || '').trim();
  if (!trimmed) return null;
  for (const net of [bitcoin.networks.bitcoin, bitcoin.networks.testnet, bitcoin.networks.regtest]) {
    try {
      return bip32.fromBase58(trimmed, net);
    } catch (_e) {
      /* try next network's version bytes */
    }
  }
  return null;
}

/**
 * Derive BIP84 (native SegWit) receive addresses from an xpub for watch-only balance.
 * Path: m/84'/0'/0'/0/i (external chain)
 */
export function deriveReceiveAddresses (xpub: string, networkName: string, count = 20): string[] {
  const addressNetwork = networkFromName(networkName);
  const root = decodeBip32Root(xpub);
  if (!root) return [];
  try {
    const addrs: string[] = [];
    for (let i = 0; i < count; i++) {
      const child = root.derive(0).derive(i);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: addressNetwork });
      if (address) addrs.push(address);
    }
    return addrs;
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-derive-receive-addrs', err);
    return [];
  }
}

/**
 * Derive a single receive address at a specific index.
 * Falls back to the xpub's own key when it's a leaf (no child derivation possible).
 */
export function deriveReceiveAddress (xpub: string, networkName: string, index = 0): string | null {
  if (!Number.isInteger(index) || index < 0) return null;
  const addressNetwork = networkFromName(networkName);
  const root = decodeBip32Root(xpub);
  if (!root) return null;
  try {
    try {
      const child = root.derive(0).derive(index);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network: addressNetwork });
      if (address) return address;
    } catch (err: unknown) {
      swallowNonFatal('bitcoin-derive-receive-index', err);
    }
    const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(root.publicKey), network: addressNetwork });
    return address ?? null;
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-derive-receive-address', err);
    return null;
  }
}

async function fabricJsonRpcPost (
  baseUrl: string,
  pathSuffix: string,
  method: string,
  params: unknown[] = []
): Promise<unknown> {
  const url = `${baseUrl.replace(/\/+$/, '')}${pathSuffix}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'RPC error');
  return body.result;
}

async function rpc (baseUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  return fabricJsonRpcPost(baseUrl, '/services/rpc', method, params);
}

async function bitcoinRpc (baseUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  return fabricJsonRpcPost(baseUrl, '/services/bitcoin', method, params);
}

export async function fetchBitcoinStatus (baseUrl: string): Promise<BitcoinStatus> {
  try {
    const r = await rpc(baseUrl, 'GetBitcoinStatus') as Record<string, unknown>;
    return {
      available: !!r?.available,
      network: typeof r?.network === 'string' ? r.network : null,
      height: typeof r?.height === 'number' ? r.height : null,
      bestBlockHash: typeof r?.bestHash === 'string' ? r.bestHash : (typeof r?.bestBlockHash === 'string' ? r.bestBlockHash : null),
      mempoolTxCount: typeof r?.mempoolTxCount === 'number' ? r.mempoolTxCount : null
    };
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-fetch-status', err);
    return { available: false, network: null, height: null, bestBlockHash: null, mempoolTxCount: null };
  }
}

export async function fetchWalletBalance (
  baseUrl: string,
  xpub: string,
  networkName: string,
  opts?: FabricBitcoinHttpOpts
): Promise<WalletBalance> {
  const addresses = deriveReceiveAddresses(xpub, networkName, 20);

  try {
    const status = await fetchBitcoinStatus(baseUrl);
    if (!status.available) {
      return { balanceSats: 0, confirmedSats: 0, unconfirmedSats: 0, network: null, height: null, updatedAt: Date.now() };
    }

    const root = baseUrl.replace(/\/+$/, '');
    const params = new URLSearchParams();
    params.set('xpub', xpub);
    if (addresses.length > 0) params.set('addresses', addresses.join(','));
    const path = `/services/bitcoin/xpub?${params.toString()}`;

    const res = await fetchWithTimeout(`${root}${path}`, {
      headers: { Accept: 'application/json', ...xpubQueryAuthHeaders(opts?.xpubQueryToken) }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const bal = data?.balanceSats ?? data?.balance_sats ?? 0;
    const conf = data?.confirmedSats ?? data?.confirmed_sats ?? bal;
    const unconf = data?.unconfirmedSats ?? data?.unconfirmed_sats ?? 0;

    return {
      balanceSats: Number(bal),
      confirmedSats: Number(conf),
      unconfirmedSats: Number(unconf),
      network: status.network,
      height: status.height,
      updatedAt: Date.now()
    };
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-fetch-wallet-balance', err);
    return { balanceSats: 0, confirmedSats: 0, unconfirmedSats: 0, network: networkName, height: null, updatedAt: Date.now() };
  }
}

export async function fetchTransactionHistory (
  baseUrl: string,
  xpub: string,
  networkName: string,
  count = 25,
  opts?: FabricBitcoinHttpOpts
): Promise<WalletTransaction[]> {
  const trimmedXpub = String(xpub || '').trim();
  if (!trimmedXpub) return [];

  const root = baseUrl.replace(/\/+$/, '');
  const limit = Math.max(1, Math.min(100, count));
  const watchAddrs = deriveReceiveAddresses(trimmedXpub, networkName, 50);
  const params = new URLSearchParams();
  params.set('xpub', trimmedXpub);
  params.set('limit', String(limit));
  if (watchAddrs.length > 0) {
    params.set('addresses', watchAddrs.join(','));
  }

  const path = `/services/bitcoin/xpub/transactions?${params.toString()}`;

  try {
    const res = await fetchWithTimeout(`${root}${path}`, {
      headers: { Accept: 'application/json', ...xpubQueryAuthHeaders(opts?.xpubQueryToken) }
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    const raw = data.transactions;
    if (!Array.isArray(raw)) return [];

    return raw.map((tx: Record<string, unknown>) => {
      const ourAmt = tx.ourAmount != null ? Number(tx.ourAmount) : NaN;
      const legacyAmt = tx.amount != null ? Number(tx.amount) : 0;
      const amountBtc = Number.isFinite(ourAmt) ? ourAmt : legacyAmt;
      return {
        txid: String(tx.txid || ''),
        amount: amountBtc,
        confirmations: Number(tx.confirmations || 0),
        time: Number(tx.time || tx.blocktime || tx.timereceived || 0),
        category: String(tx.category || 'receive'),
        address: typeof tx.address === 'string' ? tx.address : undefined,
        fee: typeof tx.fee === 'number' ? tx.fee : undefined,
        label: typeof tx.label === 'string' ? tx.label : undefined
      };
    });
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-fetch-tx-history', err);
    return [];
  }
}

export async function fetchReceiveAddressFromNode (baseUrl: string): Promise<string | null> {
  try {
    const addr = await bitcoinRpc(baseUrl, 'getnewaddress', ['', 'bech32']) as string;
    return typeof addr === 'string' ? addr : null;
  } catch (err: unknown) {
    swallowNonFatal('bitcoin-getnewaddress', err);
    return null;
  }
}

export async function broadcastTransaction (baseUrl: string, txHex: string): Promise<string> {
  const txid = await bitcoinRpc(baseUrl, 'sendrawtransaction', [txHex]) as string;
  return String(txid);
}

export function formatSats (sats: number): string {
  const n = Number(sats);
  if (!Number.isFinite(n)) return '0';
  if (Math.abs(n) >= 100_000_000) {
    return `${(n / 1e8).toFixed(8)} BTC`;
  }
  return `${Math.round(n).toLocaleString('en-US')} sats`;
}

export function formatBtc (sats: number): string {
  const n = Number(sats);
  if (!Number.isFinite(n)) return '0.00000000';
  return (n / 1e8).toFixed(8);
}
