'use strict';

/**
 * Bitcoin wallet service for Fabric Passport.
 *
 * Uses a Fabric node's `/services/bitcoin` HTTP API as a block-explorer and wallet backend.
 * Keys never leave the extension; only xpub-derived watch addresses are sent for balance lookups.
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
 * Derive BIP84 (native SegWit) receive addresses from an xpub for watch-only balance.
 * Path: m/84'/0'/0'/0/i (external chain)
 */
export function deriveReceiveAddresses (xpub: string, network: bitcoin.networks.Network, count = 20): string[] {
  try {
    const root = bip32.fromBase58(xpub, network);
    const addrs: string[] = [];
    for (let i = 0; i < count; i++) {
      const child = root.derive(0).derive(i);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network });
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
  const network = networkFromName(networkName);
  try {
    const root = bip32.fromBase58(xpub, network);
    try {
      const child = root.derive(0).derive(index);
      const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(child.publicKey), network });
      if (address) return address;
    } catch (err: unknown) {
      swallowNonFatal('bitcoin-derive-receive-index', err);
    }
    const { address } = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(root.publicKey), network });
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

export async function fetchWalletBalance (baseUrl: string, xpub: string, networkName: string): Promise<WalletBalance> {
  const network = networkFromName(networkName);
  const addresses = deriveReceiveAddresses(xpub, network, 20);

  try {
    const status = await fetchBitcoinStatus(baseUrl);
    if (!status.available) {
      return { balanceSats: 0, confirmedSats: 0, unconfirmedSats: 0, network: null, height: null, updatedAt: Date.now() };
    }

    const url = `${baseUrl.replace(/\/+$/, '')}/services/bitcoin/addresses`;
    const params = new URLSearchParams();
    if (addresses.length > 0) params.set('addresses', addresses.join(','));
    params.set('xpub', xpub);

    const res = await fetchWithTimeout(`${url}?${params.toString()}`, {
      headers: { Accept: 'application/json' }
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

export async function fetchTransactionHistory (baseUrl: string, count = 25): Promise<WalletTransaction[]> {
  try {
    const txs = await bitcoinRpc(baseUrl, 'listtransactions', ['*', count, 0, true]) as Array<Record<string, unknown>>;
    if (!Array.isArray(txs)) return [];
    return txs.map(tx => ({
      txid: String(tx.txid || ''),
      amount: Number(tx.amount || 0),
      confirmations: Number(tx.confirmations || 0),
      time: Number(tx.time || tx.timereceived || 0),
      category: String(tx.category || 'unknown'),
      address: typeof tx.address === 'string' ? tx.address : undefined,
      fee: typeof tx.fee === 'number' ? tx.fee : undefined,
      label: typeof tx.label === 'string' ? tx.label : undefined
    })).reverse();
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
