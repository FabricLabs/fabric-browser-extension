'use strict';

/// <reference path="../types/fabric.d.ts" />

/**
 * Identity and HD material align with hub.fabric.pub patterns: `@fabric/core/types/key` + `Identity`
 * use the same `tiny-secp256k1` + `bip32` stack.
 *
 * **Fabric concepts (do not conflate):**
 * - **`Actor`** (`@fabric/core/types/actor`) — stateful entity with JSON Patch, `commit()`, and
 *   content-derived **`id`** from `toGenericMessage()` (sorted `{ type, object }`), not arbitrary strings.
 * - **`Message`** — extends `Actor`; **AMP** wire envelope with opcodes and **BIP-340 Schnorr** on the
 *   **Fabric/Message** tagged hash (`signWithKey` / `verifyWithKey`). This is what peers and services exchange.
 * - **Bitcoin Signed Message** — ECDSA + Bitcoin Core’s message prefix; used here for **RPC** / wallet UX only.
 *
 * Passport’s saved Bitcoin node / hub rows use **`passportNodeListId`**: a short stable **UI storage key**,
 * not `Actor#id` and not a Fabric **`Message`**.
 *
 * @see https://github.com/FabricLabs/hub.fabric.pub — components/IdentityManager.js, functions/fabricBrowserIdentityDev.js
 */

import {
  INVALID_BECH32_TEST_VECTORS,
  INVALID_BIP32_TEST_VECTORS,
  VALID_BECH32_TEST_VECTORS,
  VALID_BIP32_TEST_VECTORS
} from '../crypto/vectors';

// Dependencies
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { wordlists, mnemonicToSeedSync, generateMnemonic } from 'bip39';
import { bech32m } from 'bech32';
import { BIP32Factory, BIP32Interface } from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bitcoin from 'bitcoinjs-lib';
import { FABRIC_KEY_DERIVATION_PATH } from '@fabric/core/constants';
import { FABRIC_STATE_STORAGE_KEY } from '../constants/fabricExtension';
import { PASSPORT_EXTENSION_VERSION } from '../constants/extensionVersion';
import { swallowNonFatal } from '../utils/nonFatal';
import SiteLoginPrompt from './SiteLoginPrompt';
import DeviceLinkPrompt from './DeviceLinkPrompt';
import FederationWalletInviteModal from './FederationWalletInviteModal';
import MultisigWalletInvitePanel from './MultisigWalletInvitePanel';
import crypto from 'crypto';

bitcoin.initEccLib(ecc);

// Semantic UI
import { Button, Message, Loader, Segment, Form, Input, TextArea, List, Icon, Modal, Popup, Table } from 'semantic-ui-react';
import { FabricBackgroundMeshActions } from './FabricBackgroundMeshActions';

// Services
import { validateXpub } from '../utils/xpub';
import { testFabricSignalingReachable, type FabricSignalingTestOk } from '../fabric/fabricWebRTCPeering';
import { touchFabricActivity, readFabricActivityMs } from '../utils/fabricActivityStorage';
import {
  fetchWalletBalance,
  fetchTransactionHistory,
  fetchBitcoinStatus,
  deriveReceiveAddress,
  formatSats,
  formatBtc,
  type WalletBalance,
  type WalletTransaction,
  type BitcoinStatus
} from '../fabric/bitcoinService';
import { requestHubRegtestFaucet } from '../utils/fabricHubFaucet';
import {
  parseFederationWalletInvite,
  PUBKEY_RE,
  type FederationWalletInvite
} from '../utils/federationWalletInvite';
import { FEDERATION_CONTRACT_INVITE } from '../fabric/messageTypes';

const bip32 = BIP32Factory(ecc);

function hash256 (buf: Buffer): Buffer {
  return crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
}

/** Bitcoin Core message prefix + varint length + UTF-8 payload. */
function encodeBitcoinSignedMessagePayload (message: string): Buffer {
  const prefix = Buffer.from('\x18Bitcoin Signed Message:\n', 'utf8');
  const msgBuf = Buffer.from(message, 'utf8');
  const n = msgBuf.length;
  let lenEnc: Buffer;
  if (n < 253) {
    lenEnc = Buffer.from([n]);
  } else if (n <= 0xffff) {
    lenEnc = Buffer.allocUnsafe(3);
    lenEnc[0] = 0xfd;
    lenEnc.writeUInt16LE(n, 1);
  } else if (n <= 0xffffffff) {
    lenEnc = Buffer.allocUnsafe(5);
    lenEnc[0] = 0xfe;
    lenEnc.writeUInt32LE(n, 1);
  } else {
    throw new Error('Message too long');
  }
  return Buffer.concat([prefix, lenEnc, msgBuf]);
}

function bitcoinMessageHash (message: string): Buffer {
  return hash256(encodeBitcoinSignedMessagePayload(message));
}

function looksLikeCompressedPubHex (s: string): boolean {
  return /^0[23][0-9a-fA-F]{64}$/.test(String(s).trim());
}

function signBitcoinMessageLocal (message: string, privateKeyHex: string): { signature: string; publicKeyHex: string } {
  const d = Uint8Array.from(Buffer.from(privateKeyHex, 'hex'));
  if (!ecc.isPrivate(d)) {
    throw new Error('Invalid private key');
  }
  const pub = ecc.pointFromScalar(d, true);
  if (!pub) {
    throw new Error('Could not derive public key');
  }
  const hash = Uint8Array.from(bitcoinMessageHash(message));
  const rec = ecc.signRecoverable(hash, d);
  const flag = 27 + rec.recoveryId + 4;
  const sig = Buffer.concat([Buffer.from([flag]), Buffer.from(rec.signature)]);
  return {
    signature: sig.toString('base64'),
    publicKeyHex: Buffer.from(pub).toString('hex')
  };
}

function verifyBitcoinMessageLocal (message: string, signatureBase64: string, compressedPubHex: string): boolean {
  const sigBuf = Buffer.from(String(signatureBase64).trim(), 'base64');
  if (sigBuf.length !== 65) return false;
  let flag = sigBuf[0] - 27;
  let compressed = false;
  if (flag >= 4) {
    compressed = true;
    flag -= 4;
  }
  if (flag < 0 || flag > 3) return false;
  const recoveryId = flag as 0 | 1 | 2 | 3;
  const sig64 = Uint8Array.from(sigBuf.subarray(1, 65));
  const hash = Uint8Array.from(bitcoinMessageHash(message));
  const recovered = ecc.recover(hash, sig64, recoveryId, compressed);
  if (!recovered) return false;
  return Buffer.from(recovered).toString('hex').toLowerCase() === compressedPubHex.replace(/^0x/i, '').toLowerCase();
}

function bitcoinNetworkFromName (name: string): bitcoin.networks.Network {
  const n = String(name || 'regtest').toLowerCase();
  if (n === 'mainnet') return bitcoin.networks.bitcoin;
  if (n === 'testnet' || n === 'signet') return bitcoin.networks.testnet;
  return bitcoin.networks.regtest;
}

/** P2PKH (base58) or native P2WPKH (bech32 v0 keyhash); network must match the address. */
function verifyBitcoinMessageForAddress (
  message: string,
  signatureBase64: string,
  address: string,
  networkName: string
): boolean {
  const network = bitcoinNetworkFromName(networkName);
  const sigBuf = Buffer.from(String(signatureBase64).trim(), 'base64');
  if (sigBuf.length !== 65) return false;
  let flag = sigBuf[0] - 27;
  let compressed = false;
  if (flag >= 4) {
    compressed = true;
    flag -= 4;
  }
  if (flag < 0 || flag > 3) return false;
  const recoveryId = flag as 0 | 1 | 2 | 3;
  const sig64 = Uint8Array.from(sigBuf.subarray(1, 65));
  const hash = Uint8Array.from(bitcoinMessageHash(message));
  const recovered = ecc.recover(hash, sig64, recoveryId, compressed);
  if (!recovered) return false;
  const pub = Buffer.from(recovered);
  const pkh = bitcoin.crypto.hash160(pub);
  const addr = String(address).trim();
  try {
    if (addr.toLowerCase().startsWith(`${network.bech32}1`)) {
      const d = bitcoin.address.fromBech32(addr);
      if (d.prefix !== network.bech32) return false;
      if (d.version === 0 && d.data.length === 20) {
        return Buffer.compare(d.data, pkh) === 0;
      }
      return false;
    }
    const dec = bitcoin.address.fromBase58Check(addr);
    return dec.version === network.pubKeyHash && Buffer.compare(dec.hash, pkh) === 0;
  } catch (err: unknown) {
    swallowNonFatal('verify-btc-message-address', err);
    return false;
  }
}

function verifyBitcoinMessageAddressAcrossNetworks (message: string, signatureBase64: string, address: string): boolean {
  return ['regtest', 'mainnet', 'testnet'].some(net =>
    verifyBitcoinMessageForAddress(message, signatureBase64, address, net)
  );
}

function mightBeBitcoinP2pkhOrP2wpkhAddress (s: string): boolean {
  const t = String(s).trim();
  if (looksLikeCompressedPubHex(t)) return false;
  return /^(bc1|tb1|bcrt1|[13])[a-zA-HJ-NP-Z0-9]{14,}$/i.test(t);
}

// Utility function to truncate string in the middle
const truncateMiddle = (str: string | undefined, frontLen: number = 5, backLen: number = 5): string => {
  if (!str) return '';
  if (str.length <= frontLen + backLen) return str;
  return `${str.slice(0, frontLen)}...${str.slice(-backLen)}`;
};

function formatUnknownError (err: unknown): string {
  return err instanceof Error ? err.message : 'Unknown error';
}

// Test bech32m implementation
const testBech32m = () => {
  console.log('Testing bech32m implementation...');

  // Test valid vectors
  for (const vector of VALID_BECH32_TEST_VECTORS) {
    try {
      const { prefix, words } = bech32m.decode(vector);
      const reencoded = bech32m.encode(prefix, words);
      if (reencoded !== vector.toLowerCase()) {
        console.error(`Valid test vector failed: ${vector}`);
        console.error(`Reencoded as: ${reencoded}`);
        return false;
      }
    } catch (error: unknown) {
      console.error(`Valid test vector failed: ${vector}`);
      console.error(`Error: ${formatUnknownError(error)}`);
      return false;
    }
  }

  // Test invalid vectors
  for (const { str, reason } of INVALID_BECH32_TEST_VECTORS) {
    try {
      bech32m.decode(str);
      console.error(`Invalid test vector passed: ${str}`);
      console.error(`Expected reason: ${reason}`);
      return false;
    } catch (_expected: unknown) {
      // Expected failure
    }
  }

  console.log('All bech32m tests passed!');
  return true;
};

const testBIP32 = () => {
  console.log('Testing BIP32 implementation...');

  // Helper function to convert path format
  const convertPath = (path: string): string => {
    if (path === 'm') return path;
    // Convert H to ' for hardened keys
    return path.replace(/H/g, "'");
  };

  // Test valid vectors
  for (const vector of VALID_BIP32_TEST_VECTORS) {
    try {
      console.log(`Testing seed: ${vector.seed}`);
      const seed = Buffer.from(vector.seed, 'hex');
      const root = bip32.fromSeed(seed);

      for (const chain of vector.chains) {
        console.log(`Testing path: ${chain.path}`);
        try {
          let derived;
          if (chain.path === 'm') {
            // For root key, use the root directly
            derived = root;
          } else {
            // Convert path format and derive
            const convertedPath = convertPath(chain.path);
            derived = root.derivePath(convertedPath);
          }

          const xpub = derived.neutered().toBase58();
          const xprv = derived.toBase58();

          if (xpub !== chain.xpub) {
            console.error(`Xpub mismatch for path ${chain.path}`);
            console.error(`Expected: ${chain.xpub}`);
            console.error(`Got: ${xpub}`);
            return false;
          }

          if (xprv !== chain.xprv) {
            console.error(`Xprv mismatch for path ${chain.path}`);
            console.error(`Expected: ${chain.xprv}`);
            console.error(`Got: ${xprv}`);
            return false;
          }

          console.log(`✓ Path ${chain.path} passed`);
        } catch (error: unknown) {
          console.error(`Failed to derive path ${chain.path}:`, formatUnknownError(error));
          return false;
        }
      }
    } catch (error: unknown) {
      console.error(`Failed to process seed ${vector.seed}:`, formatUnknownError(error));
      return false;
    }
  }

  // Test invalid vectors
  for (const vector of INVALID_BIP32_TEST_VECTORS) {
    try {
      bip32.fromBase58(vector);
      console.error(`Invalid test vector passed: ${vector}`);
      return false;
    } catch (_expected: unknown) {
      console.log(`✓ Invalid vector rejected as expected: ${vector}`);
    }
  }

  console.log('All BIP32 tests passed!');
  return true;
};

type KeyGenerationState = 'initial' | 'warning' | 'generating' | 'complete' | 'xpub_login' | 'xprv_login' | 'logged_in' | 'wallet' | 'peers' | 'password_entry' | 'add_identity' | 'confirmation' | 'no_password_warning' | 'settings' | 'derivation_password_warning' | 'seed_phrase_entry' | 'identity_detail' | 'login_selection' | 'seed_phrase_login' | 'sign_message' | 'restore_identity' | 'verify_message' | 'derivation_password_entry';
type WalletSubView = 'receive' | 'history' | 'send' | 'faucet' | null;
type XpubLoginState = 'input' | 'validating' | 'error';
type PasswordState = 'input' | 'verifying' | 'error';

interface Identity {
  id: string;
  bech32: string;
  xpub: string;
  publicKeyHex: string;
  /** Present when the identity was derived from seed in-session; used for offline message signing. */
  privateKeyHex?: string;
  name?: string;
  isCurrent: boolean;
  loadedAt: string;
  hasPrivateKey: boolean;
  balance?: string;
}

interface KeyPairStorage {
  public: string;
  private: string;
}

function isKeyPairStorage (k: unknown): k is KeyPairStorage {
  if (!k || typeof k !== 'object') return false;
  const o = k as Record<string, unknown>;
  return (
    typeof o.public === 'string' &&
    typeof o.private === 'string' &&
    /^[0-9a-f]+$/i.test(o.public) &&
    /^[0-9a-f]+$/i.test(o.private)
  );
}

interface BitcoinNode {
  id: string;
  connectionString: string;
  isActive: boolean;
}

/** Hub base URL for WebSocket signaling (WebRTC); same shape as Bridge `hubAddress`. */
interface FabricNode {
  id: string;
  hubAddress: string;
  isActive: boolean;
}

interface BitcoinNodeTestResult {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  difficulty: number;
  chainwork: string;
  mediantime: number;
}

/** Public Hub JSON-RPC passthrough (`verifymessage`, etc.); no wallet RPC without bitcoind behind the Hub. */
const HUB_FABRIC_BITCOIN_RPC = 'https://hub.fabric.pub/services/bitcoin';

/** Default Fabric playnet-style bitcoind RPC (regtest); only the host changes for LAN presets. */
function playnetBitcoindUrl (host: string): string {
  return `http://ahp7iuGhae8mooBahFaYieyaixei6too:naiRe9wo5vieFayohje5aegheenoh4ee@${host}:20444`;
}

const DEFAULT_BITCOIN_NODES: BitcoinNode[] = [
  { id: 'hub-fabric-pub', connectionString: HUB_FABRIC_BITCOIN_RPC, isActive: true },
  { id: 'playnet-regtest', connectionString: playnetBitcoindUrl('127.0.0.1'), isActive: false },
  { id: 'lan-192-168-50-5', connectionString: playnetBitcoindUrl('192.168.50.5'), isActive: false },
  { id: 'lan-192-168-50-2', connectionString: playnetBitcoindUrl('192.168.50.2'), isActive: false }
];

/** Quick-fill for the "Add node" field (same URLs as defaults). */
const BITCOIN_HOST_PRESETS: ReadonlyArray<{ id: string; label: string; connectionString: string }> = [
  { id: 'hub', label: 'hub.fabric.pub', connectionString: HUB_FABRIC_BITCOIN_RPC },
  { id: 'playnet', label: '127.0.0.1 (playnet)', connectionString: playnetBitcoindUrl('127.0.0.1') },
  { id: 'lan50-5', label: '192.168.50.5', connectionString: playnetBitcoindUrl('192.168.50.5') },
  { id: 'lan50-2', label: '192.168.50.2', connectionString: playnetBitcoindUrl('192.168.50.2') }
];

const HUB_FABRIC_HUB_BASE = 'https://hub.fabric.pub';

function fabricHubAt (host: string, port: number): string {
  const p = host.includes(':') ? `[${host}]` : host;
  return `http://${p}:${port}`;
}

const DEFAULT_FABRIC_NODES: FabricNode[] = [
  { id: 'hub-fabric-pub', hubAddress: HUB_FABRIC_HUB_BASE, isActive: true },
  /** Local `@fabric/hub`: `node scripts/hub.js` (HTTP API + SPA). */
  { id: 'local-hub-http', hubAddress: fabricHubAt('127.0.0.1', 8080), isActive: false },
  /** Local Hub webpack dev server (proxies `/services`, `/settings` → :8080). */
  { id: 'local-hub-webpack', hubAddress: fabricHubAt('127.0.0.1', 3000), isActive: false },
  { id: 'local-passport-serve', hubAddress: fabricHubAt('127.0.0.1', 3003), isActive: false },
  { id: 'lan-192-168-50-5', hubAddress: fabricHubAt('192.168.50.5', 3003), isActive: false },
  { id: 'lan-192-168-50-2', hubAddress: fabricHubAt('192.168.50.2', 3003), isActive: false }
];

const FABRIC_HUB_PRESETS: ReadonlyArray<{ id: string; label: string; hubAddress: string }> = [
  { id: 'hub', label: 'hub.fabric.pub', hubAddress: HUB_FABRIC_HUB_BASE },
  { id: 'local-8080', label: '127.0.0.1:8080 (local Hub)', hubAddress: fabricHubAt('127.0.0.1', 8080) },
  { id: 'local-3000', label: '127.0.0.1:3000 (webpack dev)', hubAddress: fabricHubAt('127.0.0.1', 3000) },
  { id: 'local', label: '127.0.0.1:3003', hubAddress: fabricHubAt('127.0.0.1', 3003) },
  { id: 'lan50-5', label: '192.168.50.5:3003', hubAddress: fabricHubAt('192.168.50.5', 3003) },
  { id: 'lan50-2', label: '192.168.50.2:3003', hubAddress: fabricHubAt('192.168.50.2', 3003) }
];

// Move DEFAULT_SETTINGS before state declarations
const DEFAULT_SETTINGS = {
  autoLockTimer: 15,
  /** Same default as `@fabric/core/constants` FABRIC_KEY_DERIVATION_PATH (hub / Fabric identity). */
  derivationPath: FABRIC_KEY_DERIVATION_PATH,
  bitcoinNodes: DEFAULT_BITCOIN_NODES,
  fabricNodes: DEFAULT_FABRIC_NODES,
  /** Optional; must match Hub `FABRIC_BITCOIN_XPUB_QUERY_TOKEN` when the hub gates xpub scans. */
  xpubQueryToken: ''
};

interface Settings {
  autoLockTimer: number;
  derivationPath: string;
  bitcoinNodes: BitcoinNode[];
  fabricNodes: FabricNode[];
  xpubQueryToken: string;
}

function normalizeSettings (raw: Partial<Settings> | undefined): Settings {
  const rawTimer = raw?.autoLockTimer;
  const autoLockTimer =
    typeof rawTimer === 'number' && Number.isFinite(rawTimer)
      ? Math.max(0, Math.min(720, Math.trunc(rawTimer)))
      : DEFAULT_SETTINGS.autoLockTimer;
  return {
    autoLockTimer,
    derivationPath:
      typeof raw?.derivationPath === 'string' && raw.derivationPath.trim()
        ? raw.derivationPath
        : DEFAULT_SETTINGS.derivationPath,
    bitcoinNodes: Array.isArray(raw?.bitcoinNodes) ? raw.bitcoinNodes : DEFAULT_SETTINGS.bitcoinNodes,
    fabricNodes: Array.isArray(raw?.fabricNodes) ? raw.fabricNodes : DEFAULT_SETTINGS.fabricNodes,
    xpubQueryToken:
      typeof raw?.xpubQueryToken === 'string' ? raw.xpubQueryToken : DEFAULT_SETTINGS.xpubQueryToken
  };
}

/** Encrypted extended private key (base58) at `path`, unlocked with the same password used for seed-derived login. */
interface WalletCryptoV1 {
  v: 1;
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  path: string;
}

interface StorageState {
  keys: KeyPairStorage[];
  identities: Identity[];
  blobs: unknown[];
  settings: Settings;
  /** Per-identity encrypted account xprv (identity id → blob). */
  walletCryptos?: Record<string, WalletCryptoV1>;
  /** @deprecated Single-blob format; migrated to walletCryptos on load. */
  walletCrypto?: WalletCryptoV1;
}

type IdentityDebugPanelState = StorageState | { error: string };

const WALLET_PBKDF2_ITERATIONS = 200_000;

function isWalletCryptoV1 (x: unknown): x is WalletCryptoV1 {
  if (!x || typeof x !== 'object') return false;
  const o = x as Record<string, unknown>;
  return (
    o.v === 1 &&
    typeof o.salt === 'string' &&
    typeof o.iv === 'string' &&
    typeof o.tag === 'string' &&
    typeof o.ciphertext === 'string' &&
    typeof o.path === 'string'
  );
}

function encryptAccountXprv (xprvBase58: string, password: string, path: string): WalletCryptoV1 {
  const salt = crypto.randomBytes(16);
  const key = crypto.pbkdf2Sync(password, salt, WALLET_PBKDF2_ITERATIONS, 32, 'sha256');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(xprvBase58, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    tag: tag.toString('hex'),
    ciphertext: enc.toString('hex'),
    path
  };
}

function decryptAccountXprv (blob: WalletCryptoV1, password: string): string {
  const salt = Buffer.from(blob.salt, 'hex');
  const key = crypto.pbkdf2Sync(password, salt, WALLET_PBKDF2_ITERATIONS, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(blob.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(blob.tag, 'hex'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'hex')),
    decipher.final()
  ]).toString('utf8');
}

function coerceWalletCryptosFromStorage (parsed: StorageState): Record<string, WalletCryptoV1> {
  const out: Record<string, WalletCryptoV1> = {};
  if (parsed.walletCryptos && typeof parsed.walletCryptos === 'object') {
    for (const [id, val] of Object.entries(parsed.walletCryptos)) {
      if (isWalletCryptoV1(val)) out[id] = val;
    }
  }
  if (Object.keys(out).length === 0 && parsed.walletCrypto && isWalletCryptoV1(parsed.walletCrypto)) {
    const first = parsed.identities?.find((id: Identity) => id.hasPrivateKey);
    if (first?.id) out[first.id] = parsed.walletCrypto;
  }
  return out;
}

/** Never persist raw private key hex in identities (session-only `privateKeyHex`). */
function stripPrivateKeyHexFromIdentities (identities: Identity[]): Identity[] {
  return identities.map(({ privateKeyHex, ...rest }) => rest);
}

/** Build identity + encrypted xprv from a BIP32 node at `path` (password encrypts the stored xprv). */
function identityAndWalletBlobFromNode (
  derivedKey: BIP32Interface,
  path: string,
  encryptPassword: string
): { identity: Identity; blob: WalletCryptoV1 } {
  const pubKeyPoint = derivedKey.publicKey;
  if (!pubKeyPoint || pubKeyPoint.length !== 33) {
    throw new Error('Invalid public key');
  }
  const publicKeyHex = Buffer.from(pubKeyPoint).toString('hex');
  const xCoord = pubKeyPoint.slice(1, 33);
  const words = bech32m.toWords(xCoord);
  const bech32mEncoded = bech32m.encode('id', words);
  const xprv = derivedKey.toBase58();
  const identity: Identity = {
    id: bech32mEncoded,
    xpub: derivedKey.neutered().toBase58(),
    publicKeyHex,
    bech32: bech32mEncoded,
    isCurrent: true,
    name: bech32mEncoded,
    loadedAt: new Date().toISOString(),
    hasPrivateKey: true,
    privateKeyHex: derivedKey.privateKey
      ? Buffer.from(derivedKey.privateKey).toString('hex')
      : undefined
  };
  return { identity, blob: encryptAccountXprv(xprv, encryptPassword, path) };
}

const STORAGE_KEY = FABRIC_STATE_STORAGE_KEY;

// Create the wordlist options once
const bip39Wordlist = wordlists.english;

// Add timeAgo formatter
const timeAgo = (date: string) => {
  const seconds = Math.floor((new Date().getTime() - new Date(date).getTime()) / 1000);
  let interval = seconds / 31536000;
  if (interval > 1) return Math.floor(interval) + ' years ago';
  interval = seconds / 2592000;
  if (interval > 1) return Math.floor(interval) + ' months ago';
  interval = seconds / 86400;
  if (interval > 1) return Math.floor(interval) + ' days ago';
  interval = seconds / 3600;
  if (interval > 1) return Math.floor(interval) + ' hours ago';
  interval = seconds / 60;
  if (interval > 1) return Math.floor(interval) + ' minutes ago';
  return Math.floor(seconds) + ' seconds ago';
};

/**
 * Deterministic id for Passport’s saved connection list (extension storage).
 * **Not** `@fabric/core` `Actor#id` (Hash256 chain over `toGenericMessage`) and **not** a `Message` address.
 */
const passportNodeListId = (content: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return `node${hash.digest('hex').slice(0, 16)}`;
};

/** POST target: bitcoind root, or Hub `.../services/bitcoin` JSON-RPC. */
function getBitcoinRpcPostUrl (connectionString: string): string {
  const base = new URL(connectionString);
  const path = (base.pathname || '').replace(/\/+$/, '');
  if (path && path !== '/') {
    return `${base.origin}${path}`;
  }
  return base.origin;
}

function buildBitcoinRpcHeaders (connectionString: string): Record<string, string> {
  const url = new URL(connectionString);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (url.username || url.password) {
    headers.Authorization = `Basic ${btoa(`${url.username}:${url.password}`)}`;
  }
  return headers;
}

function getActiveBitcoinNode (nodes: BitcoinNode[]): BitcoinNode | null {
  return nodes.find(n => n.isActive) ?? null;
}

// Add function to make RPC requests
const makeRPCRequest = async (node: BitcoinNode, method: string, params: unknown[]): Promise<unknown> => {
  const headers = buildBitcoinRpcHeaders(node.connectionString);
  const postUrl = getBitcoinRpcPostUrl(node.connectionString);

  try {
    const response = await fetch(postUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'test',
        method,
        params
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    if (data.error) {
      throw new Error(data.error.message || 'RPC Error');
    }

    return data.result;
  } catch (error) {
    if (error instanceof Error && error.message.includes('Failed to fetch')) {
      throw new Error('Could not connect to Bitcoin node. Please ensure bitcoind is running.');
    }
    throw error;
  }
};

// Add wallet management functions
const ensureWalletLoaded = async (node: BitcoinNode): Promise<string> => {
  try {
    // Try to load the default wallet first
    try {
      await makeRPCRequest(node, 'loadwallet', ['default']);
      return 'default';
    } catch (error) {
      // If wallet doesn't exist, create it
      if (error instanceof Error && error.message.includes('not found')) {
        try {
          // Create a new descriptor wallet (default in newer versions)
          await makeRPCRequest(node, 'createwallet', [
            'default',     // wallet_name
            false,         // disable_private_keys
            false,         // blank
            '',           // passphrase
            true,         // avoid_reuse
            true,         // descriptors - use descriptor wallet (SQLite)
            true          // load_on_startup
          ]);
          return 'default';
        } catch (createError) {
          // If wallet already exists but couldn't be loaded, try unloading first
          if (createError instanceof Error && createError.message.includes('already exists')) {
            await makeRPCRequest(node, 'unloadwallet', ['default']);
            await makeRPCRequest(node, 'loadwallet', ['default']);
            return 'default';
          }
          throw createError;
        }
      }

      // If default wallet can't be loaded/created, try listing available wallets
      const walletsRaw = await makeRPCRequest(node, 'listwallets', []);
      if (Array.isArray(walletsRaw) && walletsRaw.length > 0) {
        const firstWallet = walletsRaw[0];
        if (typeof firstWallet === 'string') {
          return firstWallet;
        }
      }

      // If no wallets available, create a new one with timestamp
      const timestamp = new Date().getTime();
      const walletName = `wallet_${timestamp}`;
      await makeRPCRequest(node, 'createwallet', [
        walletName,    // wallet_name
        false,         // disable_private_keys
        false,         // blank
        '',           // passphrase
        true,         // avoid_reuse
        true,         // descriptors - use descriptor wallet (SQLite)
        true          // load_on_startup
      ]);
      return walletName;
    }
  } catch (error) {
    console.error('Wallet management error:', error);
    throw new Error('Failed to ensure wallet is loaded: ' + (error instanceof Error ? error.message : 'Unknown error'));
  }
};

// Update the type definition to include masterKey
interface GeneratedValues {
  seed: Buffer;
  privateKey: string;
  publicKey: string;
  xCoord: Buffer;
  bech32mEncoded: string;
  masterKey: BIP32Interface;
}

const IdentityManager = () => {
  const [state, setState] = useState<KeyGenerationState>('initial');
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [seedWords, setSeedWords] = useState<string[]>([]);
  const [xpubState, setXpubState] = useState<XpubLoginState>('input');
  const [xpub, setXpub] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [passwordState, setPasswordState] = useState<PasswordState>('input');
  const [identities, setIdentities] = useState<Identity[]>([]);
  const [debugInfo, setDebugInfo] = useState<IdentityDebugPanelState | null>(null);
  const [showDebug, setShowDebug] = useState<boolean>(false);
  const [showPassword, setShowPassword] = useState<boolean>(false);
  const [confirmationSeed, setConfirmationSeed] = useState<string>('');
  const [confirmationPassword, setConfirmationPassword] = useState<string>('');
  const [derivationPassword, setDerivationPassword] = useState<string>('');
  const [derivationPasswordState, setDerivationPasswordState] = useState<PasswordState>('input');
  const [editingIdentity, setEditingIdentity] = useState<Identity | null>(null);
  const [newIdentityName, setNewIdentityName] = useState<string>('');
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  /** Same destructive action as footer Logout; modal copy differs for Settings "Clear Data". */
  const [eraseConfirmMode, setEraseConfirmMode] = useState<'logout' | 'erase_all'>('logout');
  const [selectedIdentity, setSelectedIdentity] = useState<Identity | null>(null);
  const [showSensitiveInfo, setShowSensitiveInfo] = useState<boolean>(false);
  const [isValidPhrase, setIsValidPhrase] = useState<boolean>(true);
  const [generatedValues, setGeneratedValues] = useState<GeneratedValues | null>(null);
  const [messageToSign, setMessageToSign] = useState<string>('');
  const [signature, setSignature] = useState<string | null>(null);
  const [showSignature, setShowSignature] = useState<boolean>(false);
  const [verificationResult, setVerificationResult] = useState<string | null>(null);
  const [newNodeConnection, setNewNodeConnection] = useState<string>('');
  const [messageToVerify, setMessageToVerify] = useState<string>('');
  const [signatureToVerify, setSignatureToVerify] = useState<string>('');
  const [pubkeyToVerify, setPubkeyToVerify] = useState<string>('');
  const [testingNode, setTestingNode] = useState<BitcoinNode | null>(null);
  const [testResult, setTestResult] = useState<BitcoinNodeTestResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [isTestModalOpen, setIsTestModalOpen] = useState<boolean>(false);

  const [newFabricHubAddress, setNewFabricHubAddress] = useState<string>('');
  const [testingFabricNode, setTestingFabricNode] = useState<FabricNode | null>(null);
  const [fabricTestError, setFabricTestError] = useState<string | null>(null);
  const [fabricTestOk, setFabricTestOk] = useState<FabricSignalingTestOk | null>(null);
  const [isFabricTestModalOpen, setIsFabricTestModalOpen] = useState<boolean>(false);
  const [walletCryptos, setWalletCryptos] = useState<Record<string, WalletCryptoV1>>({});
  const [signUnlockPassword, setSignUnlockPassword] = useState('');
  const [signUnlockError, setSignUnlockError] = useState<string | null>(null);
  const [isSigning, setIsSigning] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  const [storageHydrated, setStorageHydrated] = useState(false);
  const [nodeSigninBusy, setNodeSigninBusy] = useState(false);
  const [nodeSigninResult, setNodeSigninResult] = useState<{ ok: boolean; fabricPeerId?: string; clock?: number; nodeAddress?: string; error?: string } | null>(null);
  const [arcNotifications, setArcNotifications] = useState<Array<{
    key: string;
    messageType: string;
    label: string;
    arc: boolean;
    summary: string;
    receivedAt: number | null;
    payload?: Record<string, unknown> | null;
    nodeAddress?: string | null;
  }>>([]);
  const [arcNotificationsBusy, setArcNotificationsBusy] = useState(false);
  const [walletInviteReview, setWalletInviteReview] = useState<{
    invite: FederationWalletInvite;
    replyPeerId: string | null;
  } | null>(null);

  const [walletBalance, setWalletBalance] = useState<WalletBalance | null>(null);
  const [walletBalanceLoading, setWalletBalanceLoading] = useState(false);
  const [walletTxs, setWalletTxs] = useState<WalletTransaction[]>([]);
  const [walletTxsLoading, setWalletTxsLoading] = useState(false);
  const [walletView, setWalletView] = useState<WalletSubView>(null);
  const [btcStatus, setBtcStatus] = useState<BitcoinStatus | null>(null);
  const [receiveAddr, setReceiveAddr] = useState<string | null>(null);
  const [receiveAddrIdx, setReceiveAddrIdx] = useState(0);
  const [sendAddr, setSendAddr] = useState('');
  const [sendAmountSats, setSendAmountSats] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);
  const [faucetAddr, setFaucetAddr] = useState('');
  const [faucetAmountSats, setFaucetAmountSats] = useState('10000');
  const [faucetLoading, setFaucetLoading] = useState(false);
  const [faucetMsg, setFaucetMsg] = useState<{ type: 'ok' | 'err'; text: string; txid?: string } | null>(null);

  const [settings, setSettings] = useState<Settings>({
    autoLockTimer: DEFAULT_SETTINGS.autoLockTimer,
    derivationPath: DEFAULT_SETTINGS.derivationPath,
    bitcoinNodes: DEFAULT_SETTINGS.bitcoinNodes,
    fabricNodes: DEFAULT_SETTINGS.fabricNodes,
    xpubQueryToken: DEFAULT_SETTINGS.xpubQueryToken
  });

  // Create a memoized version of the wordlist
  const wordlist = useMemo(() => bip39Wordlist, []);

  // Add state for whether we should start editing on detail view
  const [startEditingOnDetail, setStartEditingOnDetail] = useState<boolean>(false);

  const lastUserActivityRef = useRef(Date.now());
  const lastActivityPersistedRef = useRef(0);
  const [showAutoLockBanner, setShowAutoLockBanner] = useState(false);

  const bumpUserActivity = useCallback(() => {
    const t = Date.now();
    lastUserActivityRef.current = t;
    if (t - lastActivityPersistedRef.current >= 4000) {
      lastActivityPersistedRef.current = t;
      void touchFabricActivity(t);
    }
  }, []);

  const performAutoLock = useCallback(() => {
    setIdentities(prev => {
      const hadPk = prev.some(i => !!i.privateKeyHex);
      if (hadPk) setShowAutoLockBanner(true);
      return prev.map(id => {
        if (!id.privateKeyHex) return id;
        const { privateKeyHex, ...rest } = id;
        return rest;
      });
    });
    setSelectedIdentity(prev => {
      if (!prev?.privateKeyHex) return prev;
      const { privateKeyHex, ...rest } = prev;
      return rest;
    });
    setSeedPhrase(sp => {
      if (sp) setShowAutoLockBanner(true);
      return null;
    });
    setGeneratedValues(gv => {
      if (gv) setShowAutoLockBanner(true);
      return null;
    });
    setPassword('');
    setSignUnlockPassword('');
    setSignUnlockError(null);
    setMessageToSign('');
    setSignature(null);
    setShowSignature(false);
    setPubkeyToVerify('');
    setVerificationResult(null);
    setClipboardNotice(null);

    setState(s => {
      if (s === 'sign_message' || s === 'verify_message' || s === 'identity_detail') return 'logged_in';
      if (s === 'settings') return 'logged_in';
      const interrupted: KeyGenerationState[] = [
        'generating',
        'complete',
        'confirmation',
        'warning',
        'seed_phrase_entry',
        'derivation_password_entry',
        'derivation_password_warning',
        'seed_phrase_login',
        'restore_identity',
        'add_identity',
        'xpub_login'
      ];
      if (interrupted.includes(s)) return 'logged_in';
      return s;
    });

    const now = Date.now();
    lastUserActivityRef.current = now;
    lastActivityPersistedRef.current = now;
    void touchFabricActivity(now);
  }, []);

  useEffect(() => {
    if (!storageHydrated) return;
    let alive = true;
    void (async () => {
      const stored = await readFabricActivityMs();
      if (!alive) return;
      const minutes = settings.autoLockTimer;
      const shouldLock =
        minutes > 0 && stored != null && Date.now() - stored >= minutes * 60_000;
      if (shouldLock) {
        performAutoLock();
        lastUserActivityRef.current = Date.now();
      } else {
        lastUserActivityRef.current = stored ?? Date.now();
      }
    })();
    return () => {
      alive = false;
    };
  }, [storageHydrated, settings.autoLockTimer, performAutoLock]);

  useEffect(() => {
    if (!storageHydrated || settings.autoLockTimer <= 0) return;
    const hasSk =
      identities.some(i => !!i.privateKeyHex) ||
      !!seedPhrase ||
      !!generatedValues;
    if (!hasSk) return;
    const id = window.setInterval(() => {
      if (Date.now() - lastUserActivityRef.current >= settings.autoLockTimer * 60_000) {
        performAutoLock();
      }
    }, 8000);
    return () => window.clearInterval(id);
  }, [
    storageHydrated,
    settings.autoLockTimer,
    identities,
    seedPhrase,
    generatedValues,
    performAutoLock
  ]);

  useEffect(() => {
    if (!storageHydrated || settings.autoLockTimer <= 0) return;
    const bump = () => bumpUserActivity();
    window.addEventListener('keydown', bump);
    window.addEventListener('mousedown', bump);
    window.addEventListener('touchstart', bump, { passive: true } as AddEventListenerOptions);
    return () => {
      window.removeEventListener('keydown', bump);
      window.removeEventListener('mousedown', bump);
      window.removeEventListener('touchstart', bump);
    };
  }, [storageHydrated, settings.autoLockTimer, bumpUserActivity]);

  useEffect(() => {
    testBIP32();
    testBech32m();

    const initializeStorage = async () => {
      try {
        let savedState;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const result = await chrome.storage.local.get(STORAGE_KEY);
          savedState = result[STORAGE_KEY];
        } else {
          savedState = localStorage.getItem(STORAGE_KEY);
          if (savedState) {
            savedState = JSON.parse(savedState);
          }
        }

        if (savedState) {
          try {
            const parsedState = savedState as StorageState;
            setWalletCryptos(coerceWalletCryptosFromStorage(parsedState));
            if (parsedState.settings) {
              setSettings(normalizeSettings(parsedState.settings));
            }
            if (parsedState.identities && parsedState.identities.length > 0) {
              setIdentities(parsedState.identities);
              // Only set state to logged_in if we have valid identities
              if (parsedState.identities.some(id => id.id && id.xpub)) {
                setState('logged_in');
              }
            }
          } catch (error) {
            console.error('Failed to parse saved state:', error);
            // Clear corrupted data
            if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
              await chrome.storage.local.remove(STORAGE_KEY);
            } else {
              localStorage.removeItem(STORAGE_KEY);
            }
          }
        }
      } catch (error) {
        console.error('Failed to initialize storage:', error);
      } finally {
        setStorageHydrated(true);
      }
    };
    initializeStorage();
  }, []);

  useEffect(() => {
    const saveState = async () => {
      if (!storageHydrated) return;
      try {
        const keyPairs: KeyPairStorage[] = [];

        // If we have a master key from seed phrase, store its key pair
        if (seedPhrase && password) {
          const seed = mnemonicToSeedSync(seedPhrase, password);
          const masterKey = bip32.fromSeed(seed);
          if (masterKey.privateKey && masterKey.publicKey) {
            keyPairs.push({
              private: Buffer.from(masterKey.privateKey).toString('hex'),
              public: Buffer.from(masterKey.publicKey).toString('hex')
            });
          }

          // Store key pairs for each identity that has one
          identities.forEach((identity: Identity) => {
            if (identity.hasPrivateKey) {
              const derivedKey = masterKey.derivePath(settings.derivationPath);
              if (derivedKey.privateKey && derivedKey.publicKey) {
                keyPairs.push({
                  private: Buffer.from(derivedKey.privateKey).toString('hex'),
                  public: Buffer.from(derivedKey.publicKey).toString('hex')
                });
              }
            }
          });
        }

        const state: StorageState = {
          keys: keyPairs,
          identities: stripPrivateKeyHexFromIdentities(identities),
          blobs: [],
          settings: settings,
          walletCryptos
        };

        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          await chrome.storage.local.set({ [STORAGE_KEY]: state });
        } else {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        }
      } catch (error) {
        console.error('Failed to save state:', error);
      }
    };
    saveState();
  }, [identities, settings, walletCryptos, storageHydrated]);

  useEffect(() => {
    const loadDebugInfo = async () => {
      try {
        let savedState;
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          const result = await chrome.storage.local.get(STORAGE_KEY);
          savedState = result[STORAGE_KEY];
        } else {
          const stateStr = localStorage.getItem(STORAGE_KEY);
          if (stateStr) {
            savedState = JSON.parse(stateStr);
          }
        }

        if (savedState) {
          setDebugInfo(savedState);
        }
      } catch (error) {
        console.error('Failed to load debug info:', error);
        setDebugInfo({ error: 'Failed to load storage' });
      }
    };
    loadDebugInfo();
  }, []);

  const handleDerivationPasswordEntry = () => {
    // If password is empty, show warning
    if (!password.trim()) {
      setState('derivation_password_warning');
      return;
    }

    // Validate password strength
    if (password.length < 8) {
      setPasswordState('error');
      setVerificationResult('Derivation password must be at least 8 characters long');
      return;
    }

    setPasswordState('verifying');
    setState('generating');
    handleGenerateKey();
  };

  const handleGenerateKey = async () => {
    try {
      // Add artificial delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Generate a BIP39 mnemonic
      const mnemonic = generateMnemonic(256, undefined, wordlists.english);
      setSeedPhrase(mnemonic);

      // Generate the seed from the mnemonic
      const seed = mnemonicToSeedSync(mnemonic);

      // Generate the master key (aligned with the mnemonic seed)
      const masterKey = bip32.fromSeed(seed);

      const pub = Buffer.from(masterKey.publicKey);
      if (pub.length !== 33 || (pub[0] !== 0x02 && pub[0] !== 0x03)) {
        throw new Error('Expected compressed secp256k1 public key from BIP32');
      }
      const xCoord = pub.subarray(1, 33);
      const publicKey = pub.toString('hex');
      const privateKey = masterKey.privateKey
        ? Buffer.from(masterKey.privateKey).toString('hex')
        : '';

      // Encode with bech32m
      const words = bech32m.toWords(xCoord);
      const bech32mEncoded = bech32m.encode('id', words);

      // Store all generated values including the master key
      setGeneratedValues({
        seed,
        privateKey,
        publicKey,
        xCoord,
        bech32mEncoded,
        masterKey
      });

      setState('complete');
      setPasswordState('input');
    } catch (error) {
      console.error('Failed to generate key:', error);
      setState('password_entry');
      // Show error message
      setPasswordState('error');
    }
  };

  const handleProceedToConfirmation = () => {
    setState('confirmation');
    setPasswordState('input');
  };

  const handleConfirmation = async () => {
    if (confirmationSeed === seedPhrase && confirmationPassword === password) {
      // Show loading state
      setPasswordState('verifying');

      // Add artificial delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      try {
        if (!generatedValues) {
          throw new Error('No generated values found');
        }

        const path = settings.derivationPath;
        const derivedKey = generatedValues.masterKey.derivePath(path);
        const { identity: newIdentity, blob } = identityAndWalletBlobFromNode(
          derivedKey,
          path,
          confirmationPassword
        );

        // Add the new identity and make it current
        setIdentities(prev => {
          const updated = prev.map(id => ({ ...id, isCurrent: false }));
          return [newIdentity, ...updated];
        });
        setWalletCryptos(prev => ({ ...prev, [newIdentity.id]: blob }));

        // Clear all sensitive data before advancing
        setSeedPhrase(null);
        setPassword('');
        setConfirmationSeed('');
        setConfirmationPassword('');
        setGeneratedValues(null);

        // Finally advance to logged in state
        setState('logged_in');
        setPasswordState('input');
      } catch (error) {
        console.error('Failed to save identity:', error);
        setPasswordState('error');
      }
    } else {
      setPasswordState('error');
    }
  };

  const handleXpubLogin = async () => {
    try {
      setXpubState('validating');
      // Validate xpub format
      if (!validateXpub(xpub)) {
        setXpubState('error');
        return;
      }

      // TODO: implement bech32m encoded id here
      // Create new identity from xpub
      const newIdentity: Identity = {
        id: `id${xpub.slice(0, 8)}`,
        xpub,
        publicKeyHex: xpub,  // Add this line
        bech32: `id${xpub.slice(0, 8)}`, // Simple bech32-like format for display
        isCurrent: true,
        name: 'Xpub Identity',
        loadedAt: new Date().toISOString(),
        hasPrivateKey: false  // We don't have the private key for xpub-based identities
      };

      // Add the new identity and make it current
      setIdentities(prev => {
        const updated = prev.map(id => ({ ...id, isCurrent: false }));
        return [newIdentity, ...updated];
      });

      setState('logged_in');
      setXpubState('input');
      setXpub('');
    } catch (error) {
      console.error('Failed to validate xpub:', error);
      setXpubState('error');
    }
  };

  const handleLogout = async () => {
    try {
      setIsLoggingOut(true);
      // Show loading state
      setPasswordState('verifying');

      // Add artificial delay
      await new Promise(resolve => setTimeout(resolve, 1500));

      // Clear generated values including master key
      setGeneratedValues(null);

      // Clear all identities
      setIdentities([]);
      setWalletCryptos({});

      // Save empty state to storage
      const state: StorageState = {
        keys: [],
        identities: [],
        blobs: [],
        settings: DEFAULT_SETTINGS,
        walletCryptos: {}
      };

      // Try chrome.storage.local first, fall back to localStorage
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.set({ [STORAGE_KEY]: state });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      }

      // Reset all states
      setState('initial');
      setSeedPhrase(null);
      setXpub('');
      setXpubState('input');
      setPassword('');
      setPasswordState('input');
      setConfirmationSeed('');
      setConfirmationPassword('');
      setDerivationPassword('');
      setDerivationPasswordState('input');
      setShowLogoutConfirm(false);
      setShowAutoLockBanner(false);
    } catch (error) {
      console.error('Failed to logout:', error);
      // Even if storage fails, we should still clear the local state
      setIdentities([]);
      setState('initial');
      setShowAutoLockBanner(false);
    } finally {
      setIsLoggingOut(false);
    }
  };

  const openEraseConfirm = (mode: 'logout' | 'erase_all') => {
    setEraseConfirmMode(mode);
    setShowLogoutConfirm(true);
  };

  const handleCancelLogout = () => {
    setShowLogoutConfirm(false);
    setEraseConfirmMode('logout');
  };

  const handleEditIdentity = (identity: Identity) => {
    setEditingIdentity(identity);
    setNewIdentityName(identity.name || '');
  };

  const handleSaveIdentityName = () => {
    if (editingIdentity) {
      setIdentities(prev =>
        prev.map(id =>
          id.xpub === editingIdentity.xpub
            ? { ...id, name: newIdentityName }
            : id
        )
      );
      setEditingIdentity(null);
      setNewIdentityName('');
    }
  };

  const handleStartOver = () => {
    setState('initial');
    setSeedPhrase(null);
    setXpub('');
    setXpubState('input');
    setPassword('');
    setPasswordState('input');
    setConfirmationSeed('');
    setConfirmationPassword('');
    setDerivationPassword('');
    setDerivationPasswordState('input');
    setEditingIdentity(null);
    setNewIdentityName('');
  };

  const handleGoBack = () => {
    if (identities.length > 0) {
      setState('logged_in');
    } else {
      setState('initial');
    }
  };

  const handleGoBackWithReset = () => {
    if (identities.length > 0) {
      setState('logged_in');
    } else {
      setState('initial');
    }
    setXpubState('input');
    setXpub('');
  };

  const handleGoBackWithXpubReset = () => {
    if (identities.length > 0) {
      setState('logged_in');
    } else {
      setState('initial');
    }
    setXpubState('input');
    setXpub('');
  };

  const handleGoBackWithConfirmationReset = () => {
    setState('initial');
    setConfirmationSeed('');
    setConfirmationPassword('');
    setPasswordState('input');
  };

  const handleGoBackFromDerivationPassword = () => {
    setState('initial');
    setPasswordState('input');
    setPassword('');
  };

  const handleIdentityClick = (identity: Identity) => {
    setSelectedIdentity(identity);
    setState('identity_detail');
  };

  const handleBackFromDetail = () => {
    setSelectedIdentity(null);
    setShowSensitiveInfo(false);
    setState('logged_in');
  };

  const handleMakeCurrent = (identity: Identity) => {
    setIdentities(prev =>
      prev.map(id => ({
        ...id,
        isCurrent: id.id === identity.id
      }))
    );
    // Update the selected identity to reflect the current state
    setSelectedIdentity(prev => prev ? { ...prev, isCurrent: true } : null);
  };

  const handleUnlockSigning = () => {
    if (!selectedIdentity?.id) return;
    const blob = walletCryptos[selectedIdentity.id];
    if (!blob) {
      setSignUnlockError('No encrypted signing key on this device for this identity.');
      return;
    }
    try {
      const xprv = decryptAccountXprv(blob, signUnlockPassword);
      const node = bip32.fromBase58(xprv);
      if (!node.privateKey) {
        throw new Error('Missing private key');
      }
      const pk = Buffer.from(node.privateKey).toString('hex');
      const id = selectedIdentity.id;
      setIdentities(prev =>
        prev.map(row => (row.id === id && row.hasPrivateKey ? { ...row, privateKeyHex: pk } : row))
      );
      setSelectedIdentity(prev =>
        prev?.id === id && prev.hasPrivateKey ? { ...prev, privateKeyHex: pk } : prev
      );
      setSignUnlockError(null);
      setSignUnlockPassword('');
      setShowAutoLockBanner(false);
      bumpUserActivity();
    } catch (err: unknown) {
      void err;
      setSignUnlockError('Wrong password or unreadable wallet data.');
    }
  };

  const copyWithNotice = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(
      () => {
        setClipboardNotice(`${label} copied`);
        window.setTimeout(() => setClipboardNotice(null), 2000);
      },
      () => setClipboardNotice(null)
    );
  };

  const handleSignMessage = async () => {
    if (!selectedIdentity || !messageToSign.trim()) return;

    setVerificationResult(null);
    setSignature(null);
    setShowSignature(false);
    setIsSigning(true);

    try {
      if (!selectedIdentity.hasPrivateKey) {
        throw new Error('Cannot sign messages with an xpub-based identity. Please use an identity with a private key.');
      }

      const pkLocal = selectedIdentity.privateKeyHex;
      if (pkLocal) {
        const { signature, publicKeyHex } = signBitcoinMessageLocal(messageToSign, pkLocal);
        setSignature(signature);
        setPubkeyToVerify(publicKeyHex);
        setShowSignature(true);
        return;
      }

      try {
        const rpcNode = getActiveBitcoinNode(settings.bitcoinNodes);
        if (!rpcNode) {
          throw new Error('No active Bitcoin node. Open Settings and enable one under Bitcoin Nodes.');
        }
        const walletName = await ensureWalletLoaded(rpcNode);
        console.log('Using wallet:', walletName);

        const addressRaw = await makeRPCRequest(rpcNode, 'getnewaddress', ['message-signing', 'legacy']);
        if (typeof addressRaw !== 'string' || !addressRaw.trim()) {
          throw new Error('getnewaddress returned an unexpected response from the node.');
        }
        const address = addressRaw;

        try {
          await makeRPCRequest(rpcNode, 'dumpprivkey', [address]);
        } catch (error) {
          console.error('Failed to access private key:', error);
          throw new Error('Could not access private key for signing. Please ensure the wallet is unlocked and has private keys enabled.');
        }

        const signatureRaw = await makeRPCRequest(rpcNode, 'signmessage', [address, messageToSign]);
        if (typeof signatureRaw !== 'string') {
          throw new Error('signmessage returned an unexpected response from the node.');
        }
        setSignature(signatureRaw);
        setPubkeyToVerify(address);
        setShowSignature(true);
        return;
      } catch (rpcErr) {
        console.warn('Bitcoin RPC signing failed:', rpcErr);
      }

      if (walletCryptos[selectedIdentity.id]) {
        throw new Error('Unlock signing with your password below, then try again.');
      }
      throw new Error(
        'No signing key in memory. Unlock with your password, or configure an optional Bitcoin Core / Hub RPC node for wallet signing.'
      );
    } catch (error: unknown) {
      console.error('Failed to sign message:', error);
      setSignature(null);
      setPubkeyToVerify('');
      setShowSignature(false);
      setVerificationResult(error instanceof Error ? error.message : 'Failed to sign message');
    } finally {
      setIsSigning(false);
    }
  };

  // Modify handleVerifyMessage to handle wallet errors
  const handleVerifyMessage = async () => {
    if (!messageToVerify.trim() || !signatureToVerify.trim() || !pubkeyToVerify.trim()) return;

    setIsVerifying(true);
    try {
      if (looksLikeCompressedPubHex(pubkeyToVerify)) {
        const ok = verifyBitcoinMessageLocal(messageToVerify, signatureToVerify, pubkeyToVerify);
        setVerificationResult(ok ? 'Signature is valid (verified locally).' : 'Signature is invalid.');
        return;
      }

      if (mightBeBitcoinP2pkhOrP2wpkhAddress(pubkeyToVerify)) {
        const ok = verifyBitcoinMessageAddressAcrossNetworks(
          messageToVerify,
          signatureToVerify,
          pubkeyToVerify
        );
        setVerificationResult(
          ok
            ? 'Signature is valid (verified locally for address).'
            : 'Signature is invalid (local address check).'
        );
        return;
      }

      try {
        const rpcNode = getActiveBitcoinNode(settings.bitcoinNodes);
        if (!rpcNode) {
          setVerificationResult(
            'No active Bitcoin node. Enable one in Settings, or use a legacy/bc1 address or compressed pubkey for local verify.'
          );
          return;
        }
        await ensureWalletLoaded(rpcNode);
        const verifyRaw = await makeRPCRequest(rpcNode, 'verifymessage', [
          pubkeyToVerify,
          signatureToVerify,
          messageToVerify
        ]);
        const isValid = verifyRaw === true;
        setVerificationResult(isValid ? 'Signature is valid (via RPC).' : 'Signature is invalid (via RPC).');
      } catch (error) {
        console.error('Failed to verify message via RPC:', error);
        setVerificationResult('Verification failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
      }
    } catch (error) {
      console.error('Failed to verify message:', error);
      setVerificationResult('Verification failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsVerifying(false);
    }
  };

  const handleSettingsChange = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  const handleExportWallet = async () => {
    try {
      // Generate key pairs for backup if we have seed phrase and password
      const keyPairs: KeyPairStorage[] = [];
      if (seedPhrase && password) {
        const seed = mnemonicToSeedSync(seedPhrase, password);
        const masterKey = bip32.fromSeed(seed);

        // Store master key pair
        if (masterKey.privateKey && masterKey.publicKey) {
          keyPairs.push({
            private: Buffer.from(masterKey.privateKey).toString('hex'),
            public: Buffer.from(masterKey.publicKey).toString('hex')
          });
        }

        // Store key pairs for each identity
        identities.forEach((identity: Identity) => {
          if (identity.hasPrivateKey) {
            const derivedKey = masterKey.derivePath(settings.derivationPath);
            if (derivedKey.privateKey && derivedKey.publicKey) {
              keyPairs.push({
                private: Buffer.from(derivedKey.privateKey).toString('hex'),
                public: Buffer.from(derivedKey.publicKey).toString('hex')
              });
            }
          }
        });
      }

      // Create the export data with all identities, settings, and key pairs
      const exportData = {
        version: '1.0',
        timestamp: new Date().toISOString(),
        state: {
          keys: keyPairs,
          identities: stripPrivateKeyHexFromIdentities(identities),
          settings,
          walletCryptos
        }
      };

      // Convert to JSON and create blob
      const jsonString = JSON.stringify(exportData, null, 2);
      const blob = new Blob([jsonString], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      // Create download link and trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = `fabric-wallet-backup-${new Date().toISOString().split('T')[0]}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export wallet:', error);
    }
  };

  const handleRestoreWallet = async (event: Event) => {
    try {
      const input = event.target as HTMLInputElement;
      const file = input.files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async (e) => {
        try {
          const content = e.target?.result as string;
          const data = JSON.parse(content);

          // Validate the backup data
          if (!data.version || !data.state || !Array.isArray(data.state.identities)) {
            throw new Error('Invalid backup file format');
          }

          // Validate key pairs if present
          if (data.state.keys && Array.isArray(data.state.keys)) {
            const validKeyPairs = data.state.keys.every(isKeyPairStorage);

            if (!validKeyPairs) {
              throw new Error('Invalid key pair format in backup');
            }
          }

          const importedIdentities = stripPrivateKeyHexFromIdentities(data.state.identities);
          const restoredParsed: StorageState = {
            keys: data.state.keys || [],
            identities: importedIdentities,
            blobs: [],
            settings: normalizeSettings(data.state.settings),
            walletCryptos: (data.state as StorageState).walletCryptos,
            walletCrypto: (data.state as StorageState).walletCrypto
          };
          const importedCryptos = coerceWalletCryptosFromStorage(restoredParsed);

          // Set the new state
          setIdentities(importedIdentities);
          setSettings(normalizeSettings(data.state.settings));
          setWalletCryptos(importedCryptos);

          // Save to storage
          const state: StorageState = {
            keys: data.state.keys || [],
            identities: importedIdentities,
            blobs: [],
            settings: data.state.settings,
            walletCryptos: importedCryptos
          };

          if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
            await chrome.storage.local.set({ [STORAGE_KEY]: state });
          } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          }

          // Return to logged in state
          setState('logged_in');
        } catch (error) {
          console.error('Failed to restore wallet:', error);
        }
      };
      reader.readAsText(file);
    } catch (error) {
      console.error('Failed to read file:', error);
    }
  };

  const renderSignMessageState = () => {
    const signNeedsUnlock =
      !!selectedIdentity?.hasPrivateKey &&
      !selectedIdentity?.privateKeyHex &&
      !!selectedIdentity?.id &&
      !!walletCryptos[selectedIdentity.id];

    return (
      <Message className="fade-in">
        <Message.Header>Sign Message</Message.Header>
        <Message.Content>
          <p style={{ marginBottom: '1em', color: 'rgba(255,255,255,0.85)' }}>
            Signs locally when your key is unlocked (no Bitcoin node required). Optionally uses RPC if there is no local key — point the node URL at Bitcoin Core or at the Hub path <code style={{ fontSize: '0.85em' }}>/services/bitcoin</code> for JSON-RPC passthrough.
          </p>
          {clipboardNotice && (
            <Message size="tiny" positive onDismiss={() => setClipboardNotice(null)}>
              {clipboardNotice}
            </Message>
          )}
          {signNeedsUnlock && (
            <Segment>
              <Form.Field>
                <label>Password (unlock encrypted key on this device)</label>
                <Input
                  type="password"
                  placeholder="Password from wallet creation or seed login"
                  value={signUnlockPassword}
                  onChange={(e) => {
                    setSignUnlockPassword(e.target.value);
                    setSignUnlockError(null);
                  }}
                  autoComplete="off"
                />
              </Form.Field>
              {signUnlockError && (
                <Message negative size="small">
                  <p>{signUnlockError}</p>
                </Message>
              )}
              <Button type="button" color="blue" content="Unlock signing" onClick={handleUnlockSigning} />
            </Segment>
          )}
          <Form>
            <Form.Field>
              <label>Message to sign</label>
              <TextArea
                placeholder="Enter the exact message to sign"
                value={messageToSign}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessageToSign(e.target.value)}
                rows={4}
                style={{ fontFamily: 'monospace', fontSize: '0.9em' }}
              />
              {!messageToSign.trim() && (
                <Message size="tiny" color="yellow">
                  Enter a message, then sign.
                </Message>
              )}
            </Form.Field>
            {verificationResult && !signature && (
              <Message negative size="small">
                <Message.Header>Could not sign</Message.Header>
                <p>{verificationResult}</p>
              </Message>
            )}
            {signature && showSignature && (
              <>
                <Message positive size="small">
                  <Message.Header>Message signed</Message.Header>
                  <p>Copy the public key and signature for verification (local verify uses the compressed public key).</p>
                </Message>
                <Form.Field>
                  <label>Compressed public key (hex)</label>
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5em',
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                    fontSize: '0.85em'
                  }}>
                    <span style={{ flex: 1 }}>{pubkeyToVerify}</span>
                    <Icon
                      name="copy"
                      link
                      aria-label="Copy public key"
                      onClick={() => copyWithNotice(pubkeyToVerify, 'Public key')}
                      style={{ cursor: 'pointer', flexShrink: 0 }}
                    />
                  </div>
                </Form.Field>
                <Form.Field>
                  <label>Signature (base64)</label>
                  <div style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '0.5em',
                    fontFamily: 'monospace',
                    wordBreak: 'break-all',
                    fontSize: '0.85em'
                  }}>
                    <span style={{ flex: 1 }}>{signature}</span>
                    <Icon
                      name="copy"
                      link
                      aria-label="Copy signature"
                      onClick={() => copyWithNotice(signature || '', 'Signature')}
                      style={{ cursor: 'pointer', flexShrink: 0 }}
                    />
                  </div>
                </Form.Field>
                <Button
                  type="button"
                  basic
                  content="Copy message + key + signature"
                  icon="copy outline"
                  onClick={() => {
                    const block = `Message:\n${messageToSign}\n\nPublic key (hex):\n${pubkeyToVerify}\n\nSignature (base64):\n${signature || ''}`;
                    copyWithNotice(block, 'Sign bundle');
                  }}
                />
              </>
            )}
            <Button.Group vertical fluid style={{ marginTop: '1em' }}>
              <Button
                primary
                content="Sign message"
                onClick={handleSignMessage}
                disabled={!messageToSign.trim() || isSigning}
                loading={isSigning}
              />
              <Button
                content="Go back"
                onClick={() => {
                  setMessageToSign('');
                  setSignature(null);
                  setPubkeyToVerify('');
                  setVerificationResult(null);
                  setShowSignature(false);
                  setSignUnlockPassword('');
                  setSignUnlockError(null);
                  setClipboardNotice(null);
                  setState('logged_in');
                }}
              />
            </Button.Group>
          </Form>
        </Message.Content>
      </Message>
    );
  };

  const renderVerifyMessageState = () => {
    const vr = verificationResult || '';
    const verifyPositive = /\bvalid\b/i.test(vr) && !/\binvalid\b/i.test(vr) && !/^Verification failed/i.test(vr);
    const verifyNegative = vr.length > 0 && !verifyPositive;

    return (
      <Message className="fade-in">
        <Message.Header>Verify message signature</Message.Header>
        <Message.Content>
          <p style={{ marginBottom: '1em', color: 'rgba(255,255,255,0.85)' }}>
            Paste the exact message, legacy or bc1 address, or compressed public key (02…/03…), and base64 signature. Address and pubkey checks run locally; RPC is only used for unusual verifier inputs.
          </p>
          <Form>
            <Form.Field>
              <label>Message</label>
              <TextArea
                placeholder="Exact signed message"
                value={messageToVerify}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setMessageToVerify(e.target.value)}
                rows={4}
                style={{ fontFamily: 'monospace', fontSize: '0.9em' }}
              />
            </Form.Field>
            <Form.Field>
              <label>Bitcoin address (Core) or compressed public key (hex)</label>
              <Input
                type="text"
                placeholder="Legacy address for verifymessage, or 02/03… for local verify"
                value={pubkeyToVerify}
                onChange={(e) => setPubkeyToVerify(e.target.value)}
              />
            </Form.Field>
            <Form.Field>
              <label>Signature (base64)</label>
              <Input
                type="text"
                placeholder="Base64 signature from signer"
                value={signatureToVerify}
                onChange={(e) => setSignatureToVerify(e.target.value)}
              />
            </Form.Field>
            {verificationResult && (
              <Message positive={verifyPositive} negative={verifyNegative}>
                <Message.Header>{verifyPositive ? 'Verified' : 'Not verified'}</Message.Header>
                <p>{verificationResult}</p>
              </Message>
            )}
            <Button.Group vertical fluid style={{ marginTop: '1em' }}>
              <Button
                primary
                content="Verify signature"
                onClick={handleVerifyMessage}
                disabled={
                  !messageToVerify.trim() ||
                  !signatureToVerify.trim() ||
                  !pubkeyToVerify.trim() ||
                  isVerifying
                }
                loading={isVerifying}
              />
              <Button
                content="Go back"
                onClick={() => {
                  setMessageToVerify('');
                  setSignatureToVerify('');
                  setPubkeyToVerify('');
                  setVerificationResult(null);
                  setState('logged_in');
                }}
              />
            </Button.Group>
          </Form>
        </Message.Content>
      </Message>
    );
  };

  // Reusable form components
  const renderDerivationPasswordForm = (
    onSubmit: (e: React.FormEvent) => void,
    password: string,
    setPassword: (value: string) => void,
    passwordState: PasswordState,
    label: string,
    placeholder: string,
    isOptional: boolean = false,
    onBack?: () => void
  ) => (
    <Form onSubmit={onSubmit}>
      <Form.Field>
        <label>{label}</label>
        <Input
          type="password"
          placeholder={placeholder}
          value={password}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPassword(e.target.value)}
          error={passwordState === 'error'}
        />
      </Form.Field>
      {passwordState === 'error' && (
        <Message negative>
          <Message.Header>Error</Message.Header>
          <p>Failed to generate key. Please try again.</p>
        </Message>
      )}
      <Button.Group vertical fluid style={{ marginTop: '1em' }}>
        <Button
          color={!password.trim() && isOptional ? 'green' : 'green'}
          content={!password.trim() && isOptional ? 'Skip' : 'Generate Identity'}
          onClick={onSubmit}
          loading={passwordState === 'verifying'}
          disabled={!password.trim() && !isOptional}
        />
        {onBack && (
          <Button
            color='black'
            content='Start Over'
            onClick={onBack}
          />
        )}
      </Button.Group>
    </Form>
  );

  const renderInitialState = () => (
    <div className="fade-in" style={{ textAlign: 'center', width: '100%' }}>
      <h3 style={{ color: 'white', fontSize: '1.2em' }}><code>@fabric/passport</code></h3>
      <p style={{ color: 'white', marginBottom: '1em' }}>You don't have an identity yet.</p>
      <Button.Group vertical fluid>
        <Button
          color='green'
          content='Create New &raquo;'
          onClick={() => setState('warning')}
        />
        <Button
          primary
          content='Use Existing &raquo;'
          onClick={() => setState('login_selection')}
        />
      </Button.Group>
    </div>
  );

  const renderIntroductionState = () => (
    <Message warning className="fade-in">
      <Message.Header>Important Security Information</Message.Header>
      <Message.Content>
        <p>A <strong>seed phrase</strong> and <strong>password</strong> can be used to recover your identity, including its funds.</p>
        <p>We will generate a new identity for you, but you are responsible for storing it securely.</p>
        <p><strong>Your seed phrase and password:</strong></p>
        <ul>
          <li>should never be shared with anyone</li>
          <li>must be stored securely (not on this device)</li>
          <li>should be tested regularly for the ability to restore from nothing</li>
        </ul>
        <p><strong>Your seed phrase will never be displayed again.</strong></p>
        <p>Are you ready to continue?</p>
        <Button.Group fluid style={{ marginTop: '1em' }}>
          <Button
            color='black'
            content='&laquo; Go Back'
            onClick={handleGoBack}
          />
          <Button
            color='green'
            content="Let's Go &raquo;"
            onClick={() => setState('derivation_password_entry')}
          />
        </Button.Group>
      </Message.Content>
    </Message>
  );

  const renderGeneratingState = () => (
    <Segment basic textAlign='center' className="fade-in">
      <Loader active inline='centered' size='large' />
      <p style={{ color: 'white', marginTop: '1em' }}>Generating your secure identity...</p>
      <p style={{ color: 'white', fontSize: '0.9em', opacity: 0.7 }}>This may take a few moments</p>
    </Segment>
  );

  const renderCompleteState = () => (
    <Message success className="fade-in">
      <Message.Header>Identity Generated Successfully</Message.Header>
      <Message.Content>
        <p>Your seed phrase is:</p>
        <Segment style={{ wordBreak: 'break-word', fontFamily: 'monospace' }}>
          {seedPhrase}
        </Segment>
        <p>Your derivation password is:</p>
        <Segment style={{
          wordBreak: 'break-word',
          fontFamily: 'monospace',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between'
        }}>
          <span>{showPassword ? password : '••••••••'}</span>
          <Button
            icon={showPassword ? 'eye slash' : 'eye'}
            onClick={() => setShowPassword(!showPassword)}
            size="mini"
            style={{ marginLeft: '1em' }}
          />
        </Segment>
        <p style={{ color: 'red' }}>IMPORTANT: Save both your seed phrase and password in a secure location!</p>
        <p>These will be used to derive your master keys and cannot be recovered if lost.</p>
        <Button.Group fluid style={{ marginTop: '1em' }}>
          <Button
            color='black'
            content='Start Over'
            onClick={() => {
              setState(identities.length > 0 ? 'logged_in' : 'initial');
              setPassword('');
              setPasswordState('input');
              setSeedPhrase(null);
            }}
          />
          <Button
            color='green'
            content="I've stored these securely"
            onClick={handleProceedToConfirmation}
          />
        </Button.Group>
      </Message.Content>
    </Message>
  );

  const renderXpubLoginState = () => (
    <Message className="fade-in" style={{ width: '100%' }}>
      <Message.Header>Login with Extended Public Key</Message.Header>
      <Message.Content>
        <Form onSubmit={(e) => { e.preventDefault(); handleXpubLogin(); }}>
          <Form.Field>
            <label>Enter your xpub:</label>
            <Input
              placeholder='xpub...'
              value={xpub}
              onChange={(e) => setXpub(e.target.value)}
              error={xpubState === 'error'}
              style={{
                fontFamily: 'monospace',
                width: '100%',
                fontSize: '0.9em'
              }}
            />
          </Form.Field>
          {xpubState === 'error' && (
            <Message negative>
              <Message.Header>Invalid xpub</Message.Header>
              <p>Please enter a valid extended public key</p>
            </Message>
          )}
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              color='green'
              content='Login'
              onClick={handleXpubLogin}
              disabled={!xpub.trim() || xpubState === 'validating'}
              loading={xpubState === 'validating'}
            />
            <Button
              color='black'
              content='Go Back'
              onClick={handleGoBackWithReset}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderDerivationPasswordWarningState = () => (
    <Message warning className="fade-in">
      <Message.Header>Important Security Information</Message.Header>
      <Message.Content>
        <p>You have chosen not to use a derivation password. This means:</p>
        <ul>
          <li>Only your seed phrase will be needed to access your accounts</li>
          <li>Anyone with access to your seed phrase can control your funds</li>
          <li>You will not have the additional security of a password</li>
        </ul>
        <p><strong>Are you sure you want to proceed without a password?</strong></p>
        <Button.Group vertical fluid style={{ marginTop: '1em' }}>
          <Button
            color='black'
            content='Go Back'
            onClick={() => setState('derivation_password_entry')}
          />
          <Button
            color='green'
            content='Yes, Generate Identity'
            onClick={() => {
              setState('generating');
              handleGenerateKey();
            }}
          />
        </Button.Group>
      </Message.Content>
    </Message>
  );

  const renderDerivationPasswordEntry = () => (
    <Message className="fade-in">
      <Message.Header>Set Derivation Password</Message.Header>
      <Message.Content>
        <p>This password will be used with your <strong>seed phrase</strong> to derive your <strong>master keys</strong>.</p>
        <p><strong>Important:</strong> You must store this password along with your seed phrase to recover your identity.</p>
        <Form>
          <Form.Field>
            <label>Create a derivation password:</label>
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                // Clear error state when user starts typing
                if (passwordState === 'error') {
                  setPasswordState('input');
                  setVerificationResult(null);
                }
              }}
              error={passwordState === 'error'}
            />
            {passwordState === 'error' && verificationResult && (
              <Message negative>
                <Message.Header>Password Error</Message.Header>
                <p>{verificationResult}</p>
              </Message>
            )}
          </Form.Field>
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              color='green'
              content='Generate Identity'
              onClick={handleDerivationPasswordEntry}
              loading={passwordState === 'verifying'}
            />
            <Button
              color='black'
              content='Start Over'
              onClick={() => {
                setState(identities.length > 0 ? 'logged_in' : 'initial');
                setPassword('');
                setPasswordState('input');
                setVerificationResult(null);
              }}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderSeedPhraseEntry = () => (
    <Message className="fade-in">
      <Message.Header>Enter Your Seed Phrase</Message.Header>
      <Message.Content>
        <p>Please enter your 12 or 24-word seed phrase and derivation password. Each word must be from the BIP39 wordlist.</p>
        <Form>
          <Form.Field>
            <label>Seed Phrase</label>
            <Input
              type="text"
              placeholder="Enter your 12 or 24 word seed phrase"
              value={seedPhrase || ''}
              onChange={(e) => {
                const phrase = e.target.value.trim();
                setSeedPhrase(phrase);
                // Validate the phrase
                const words = phrase.split(/\s+/);
                const isValidLength = words.length === 12 || words.length === 24;
                const allWordsValid = words.every(word => wordlist.includes(word.toLowerCase()));
                setIsValidPhrase(isValidLength && allWordsValid);
              }}
              error={!isValidPhrase && seedPhrase !== null}
              style={{ fontFamily: 'monospace' }}
            />
            {!isValidPhrase && seedPhrase !== null && (
              <Message negative>
                <Message.Header>Invalid Seed Phrase</Message.Header>
                <p>Please ensure all words are from the BIP39 wordlist and the phrase contains exactly 12 or 24 words.</p>
              </Message>
            )}
          </Form.Field>
          <Form.Field>
            <label>Derivation Password</label>
            <Input
              type="password"
              placeholder="Enter your derivation password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordState === 'error'}
              autoComplete="new-password"
            />
            {passwordState === 'error' && (
              <Message negative>
                <Message.Header>Error</Message.Header>
                <p>Failed to process seed phrase. Please check your input and try again.</p>
              </Message>
            )}
          </Form.Field>
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              content='Continue'
              onClick={async () => {
                try {
                  if (!seedPhrase) {
                    setIsValidPhrase(false);
                    return;
                  }
                  setPasswordState('verifying');

                  // Generate the seed from the mnemonic
                  const seed = mnemonicToSeedSync(seedPhrase, password);

                  // Derive the master key using BIP32
                  const masterKey = bip32.fromSeed(seed);

                  const path = settings.derivationPath;
                  const derivedKey = masterKey.derivePath(path);
                  const { identity: newIdentity, blob } = identityAndWalletBlobFromNode(derivedKey, path, password);

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });
                  setWalletCryptos(prev => ({ ...prev, [newIdentity.id]: blob }));

                  setState('logged_in');

                  // Clear sensitive data
                  setPassword('');
                  setSeedPhrase(null);
                } catch (error) {
                  console.error('Failed to process seed phrase:', error);
                  setPasswordState('error');
                }
              }}
              disabled={!isValidPhrase || !seedPhrase}
              loading={passwordState === 'verifying'}
            />
            <Button
              content='Go Back'
              onClick={() => setState('add_identity')}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderIdentityDetail = () => {
    if (!selectedIdentity) return null;

    // Start editing if the flag is set
    if (startEditingOnDetail) {
      setEditingIdentity(selectedIdentity);
      setNewIdentityName(selectedIdentity.name || '');
      setStartEditingOnDetail(false); // Reset the flag
    }

    return (
      <div className="fade-in" style={{ width: '100%' }}>
        <Message info>
          <Message.Header>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              {editingIdentity ? (
                <Input
                  value={newIdentityName}
                  onChange={(e) => setNewIdentityName(e.target.value)}
                  placeholder="Enter identity name"
                  style={{ width: '100%' }}
                  autoFocus
                />
              ) : (
                <span>{truncateMiddle(selectedIdentity.name || 'Unnamed Identity')}</span>
              )}
              <Button.Group>
                {editingIdentity ? (
                  <>
                    <Button
                      icon='check'
                      link
                      onClick={handleSaveIdentityName}
                      size='small'
                      color='green'
                    />
                    <Button
                      icon='close'
                      link
                      onClick={() => {
                        setEditingIdentity(null);
                        setNewIdentityName('');
                      }}
                      size='small'
                      color='red'
                    />
                  </>
                ) : (
                  <Button
                    icon='pencil'
                    link
                    onClick={() => {
                      setEditingIdentity(selectedIdentity);
                      setNewIdentityName(selectedIdentity.name || '');
                    }}
                    size='small'
                  />
                )}
              </Button.Group>
            </div>
          </Message.Header>
          <Message.Content style={{ marginTop: '1em' }}>
            <Segment style={{ padding: '1em' }}>
              <div style={{ marginBottom: '1em' }}>
                <h5 style={{ marginBottom: '0.5em' }}>Balance</h5>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all',
                  fontSize: '1.2em',
                  fontWeight: 'bold'
                }}>
                  <span>{selectedIdentity.balance || '0.00'} BTC</span>
                </div>
              </div>

              <div style={{ marginBottom: '1em' }}>
                <h5 style={{ marginBottom: '0.5em' }}>Identity</h5>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  <span>{showSensitiveInfo ? selectedIdentity.id : truncateMiddle(selectedIdentity.id)}</span>
                  <Icon
                    name={showSensitiveInfo ? 'eye slash' : 'eye'}
                    link
                    onClick={() => setShowSensitiveInfo(!showSensitiveInfo)}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </div>

              <div>
                <h5 style={{ marginBottom: '0.5em' }}>Public Key</h5>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  <span>{showSensitiveInfo ? selectedIdentity.publicKeyHex : truncateMiddle(selectedIdentity.publicKeyHex)}</span>
                  <Icon
                    name={showSensitiveInfo ? 'eye slash' : 'eye'}
                    link
                    onClick={() => setShowSensitiveInfo(!showSensitiveInfo)}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </div>

              <div>
                <h5 style={{ marginBottom: '0.5em' }}>xpub</h5>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  <span>{showSensitiveInfo ? selectedIdentity.xpub : truncateMiddle(selectedIdentity.xpub)}</span>
                  <Icon
                    name={showSensitiveInfo ? 'eye slash' : 'eye'}
                    link
                    onClick={() => setShowSensitiveInfo(!showSensitiveInfo)}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </div>
            </Segment>
            <Button.Group vertical fluid style={{ marginTop: '1em' }}>
              <Button
                icon='check circle'
                content='Make Current'
                onClick={() => handleMakeCurrent(selectedIdentity)}
                size='small'
                color={selectedIdentity.isCurrent ? 'green' : 'blue'}
                disabled={selectedIdentity.isCurrent}
              />
              <Button
                color='black'
                icon='arrow left'
                content='Back'
                onClick={handleBackFromDetail}
                size='small'
              />
            </Button.Group>
          </Message.Content>
        </Message>
      </div>
    );
  };

  const openWalletPage = (view: WalletSubView = null) => {
    setWalletView(view);
    setSendError(null);
    setFaucetMsg(null);
    if (view === 'receive') deriveCurrentReceiveAddr();
    if (view === 'history') void refreshWalletTxs();
    if (view === 'faucet') {
      const cur = identities.find(id => id.isCurrent);
      const net = btcStatus?.network || 'regtest';
      const a = cur?.xpub ? deriveReceiveAddress(cur.xpub, net, receiveAddrIdx) : null;
      setFaucetAddr(prev => (prev.trim() ? prev : (a || '')));
    }
    void refreshWalletBalance();
    setState('wallet');
  };

  /** Dark panels on the #1b1c1d shell — pairs with Semantic `inverted` + grey/blue buttons. */
  const darkPanelStyle: React.CSSProperties = {
    background: '#2a2b2d',
    border: '1px solid rgba(255,255,255,0.12)',
    color: 'rgba(255,255,255,0.92)'
  };

  /** Identity card stays a light Semantic Segment; icons must be dark, not inverted-white. */
  const cardActionBtnStyle: React.CSSProperties = {
    background: 'transparent',
    border: 'none',
    color: 'rgba(0, 0, 0, 0.58)',
    padding: '0.35em 0.45em',
    cursor: 'pointer',
    borderRadius: '4px'
  };

  const renderIdentityCardActionBar = () => {
    const pendingMultisig = arcNotifications.filter((r) => r.messageType === FEDERATION_CONTRACT_INVITE).length;
    const peerOk = !!(nodeSigninResult && nodeSigninResult.ok);
    const actions: Array<{
      key: string;
      icon: string;
      tip: string;
      onClick: () => void;
      badge?: number;
      color?: string;
    }> = [
      {
        key: 'receive',
        icon: 'qrcode',
        tip: 'Receive',
        onClick: () => openWalletPage('receive')
      },
      {
        key: 'send',
        icon: 'send',
        tip: 'Send',
        onClick: () => openWalletPage('send')
      },
      {
        key: 'history',
        icon: 'list',
        tip: 'Transaction history',
        onClick: () => openWalletPage('history')
      },
      {
        key: 'faucet',
        icon: 'tint',
        tip: 'Regtest faucet',
        onClick: () => openWalletPage('faucet')
      },
      {
        key: 'wallet',
        icon: 'bitcoin',
        tip: pendingMultisig
          ? `Wallet · ${pendingMultisig} multisig invite${pendingMultisig === 1 ? '' : 's'}`
          : 'Wallet (balance, multisig)',
        badge: pendingMultisig || undefined,
        color: '#f7931a',
        onClick: () => openWalletPage(null)
      },
      {
        key: 'peers',
        icon: 'sitemap',
        tip: peerOk ? 'Peers & node (connected)' : 'Peers & Fabric node',
        color: peerOk ? '#21ba45' : undefined,
        onClick: () => {
          void refreshArcNotifications();
          setState('peers');
        }
      },
      {
        key: 'refresh',
        icon: 'refresh',
        tip: 'Refresh balance',
        onClick: () => { void refreshWalletBalance(); void refreshWalletTxs(); }
      }
    ];
    return (
      <div
        role="toolbar"
        aria-label="Wallet and peer shortcuts"
        onClick={(e) => e.stopPropagation()}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: '0.15em',
          marginTop: '0.65em',
          paddingTop: '0.55em',
          borderTop: '1px solid rgba(0, 0, 0, 0.12)'
        }}
      >
        {actions.map((a) => (
          <Popup
            key={a.key}
            inverted
            size="mini"
            position="top center"
            content={a.tip}
            trigger={(
              <button
                type="button"
                aria-label={a.tip}
                style={cardActionBtnStyle}
                onClick={(e) => {
                  e.stopPropagation();
                  a.onClick();
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(0, 0, 0, 0.06)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'transparent';
                }}
              >
                <span style={{ position: 'relative', display: 'inline-block' }}>
                  <Icon
                    name={a.icon as 'bitcoin'}
                    style={{ margin: 0, color: a.color || undefined }}
                  />
                  {a.badge ? (
                    <span style={{
                      position: 'absolute',
                      top: '-6px',
                      right: '-8px',
                      background: '#db2828',
                      color: '#fff',
                      borderRadius: '8px',
                      fontSize: '0.65em',
                      lineHeight: '1.2',
                      padding: '0 4px',
                      minWidth: '14px',
                      textAlign: 'center'
                    }}
                    >
                      {a.badge > 9 ? '9+' : a.badge}
                    </span>
                  ) : null}
                </span>
              </button>
            )}
          />
        ))}
      </div>
    );
  };

  const renderWalletPage = () => {
    const activeNode = settings.fabricNodes.find(n => n.isActive);
    const hubBase = activeNode ? activeNode.hubAddress.replace(/\/+$/, '') : null;
    const currentId = identities.find(id => id.isCurrent);
    const inviterPubkey = currentId && PUBKEY_RE.test(currentId.publicKeyHex)
      ? currentId.publicKeyHex
      : null;
    const walletInvites = arcNotifications.filter((r) => r.messageType === FEDERATION_CONTRACT_INVITE);

    return (
      <div className="fade-in" style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75em' }}>
          <h3 style={{ margin: 0, color: 'white', fontSize: '1.05em' }}>
            <Icon name="bitcoin" style={{ color: '#f7931a', marginRight: '0.35em' }} />
            Wallet
          </h3>
          <Button
            size="mini"
            inverted
            color="grey"
            icon="refresh"
            loading={walletBalanceLoading}
            onClick={() => { void refreshWalletBalance(); void refreshWalletTxs(); }}
            title="Refresh balance and transactions"
          />
        </div>

        <Segment inverted style={darkPanelStyle}>
          {btcStatus && !btcStatus.available ? (
            <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.88em', margin: '0.25em 0' }}>
              Bitcoin service not available on the active Fabric node.
            </p>
          ) : walletBalance ? (
            <div style={{ marginBottom: '0.5em' }}>
              <div style={{ fontSize: '1.4em', fontFamily: 'monospace', fontWeight: 'bold', color: '#fff' }}>
                {formatSats(walletBalance.balanceSats)}
              </div>
              <div style={{ fontSize: '0.82em', color: 'rgba(255,255,255,0.65)', marginTop: '0.15em' }}>
                {walletBalance.confirmedSats !== walletBalance.balanceSats ? (
                  <span>confirmed {formatSats(walletBalance.confirmedSats)} · unconfirmed {formatSats(walletBalance.unconfirmedSats)}</span>
                ) : null}
                {walletBalance.network ? <span>{walletBalance.confirmedSats !== walletBalance.balanceSats ? ' · ' : ''}{walletBalance.network}</span> : null}
                {walletBalance.height != null ? <span> · block {walletBalance.height}</span> : null}
              </div>
            </div>
          ) : (
            <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.88em', margin: '0.25em 0' }}>
              Connect to a Fabric node to see your balance.
            </p>
          )}
          <Button.Group size="small" fluid style={{ marginTop: '0.5em' }}>
            <Button
              inverted
              color={walletView === 'receive' ? 'blue' : 'grey'}
              onClick={() => {
                if (walletView === 'receive') {
                  setWalletView(null);
                } else {
                  setWalletView('receive');
                  deriveCurrentReceiveAddr();
                }
              }}
            >
              <Icon name="qrcode" /> Receive
            </Button>
            <Button
              inverted
              color={walletView === 'history' ? 'blue' : 'grey'}
              onClick={() => {
                if (walletView === 'history') {
                  setWalletView(null);
                } else {
                  setWalletView('history');
                  void refreshWalletTxs();
                }
              }}
            >
              <Icon name="list" /> History
            </Button>
            <Button
              inverted
              color={walletView === 'send' ? 'blue' : 'grey'}
              onClick={() => { setWalletView(walletView === 'send' ? null : 'send'); setSendError(null); }}
            >
              <Icon name="send" /> Send
            </Button>
            <Button
              inverted
              color={walletView === 'faucet' ? 'blue' : 'grey'}
              onClick={() => {
                const next = walletView === 'faucet' ? null : 'faucet';
                if (next === 'faucet') {
                  setFaucetMsg(null);
                  const cur = identities.find(id => id.isCurrent);
                  const net = btcStatus?.network || 'regtest';
                  const a = cur?.xpub ? deriveReceiveAddress(cur.xpub, net, receiveAddrIdx) : null;
                  setFaucetAddr(prev => (prev.trim() ? prev : (a || '')));
                }
                setWalletView(next);
              }}
            >
              <Icon name="tint" /> Faucet
            </Button>
          </Button.Group>

          {walletView === 'receive' && (
            <div style={{ marginTop: '0.75em' }}>
              {receiveAddr ? (
                <>
                  <p style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85em', marginBottom: '0.35em' }}>
                    Receive address (BIP84, index {receiveAddrIdx}):
                  </p>
                  <Segment inverted style={{ ...darkPanelStyle, wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.88em', padding: '0.75em', background: '#1f2022' }}>
                    {receiveAddr}
                  </Segment>
                  <Button.Group size="mini" fluid>
                    <Button
                      inverted
                      color="grey"
                      onClick={() => {
                        try {
                          void navigator.clipboard.writeText(receiveAddr);
                        } catch (err: unknown) {
                          swallowNonFatal('identity-copy-receive-addr', err);
                        }
                      }}
                    >
                      <Icon name="copy" /> Copy
                    </Button>
                    <Button
                      inverted
                      color="grey"
                      onClick={() => { setReceiveAddrIdx(i => i + 1); }}
                    >
                      <Icon name="arrow right" /> Next address
                    </Button>
                  </Button.Group>
                </>
              ) : (
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.85em' }}>
                  Could not derive an address. Make sure your identity has an xpub and the network is known.
                </p>
              )}
            </div>
          )}

          {walletView === 'history' && (
            <div style={{ marginTop: '0.75em' }}>
              {walletTxsLoading ? (
                <div style={{ textAlign: 'center', padding: '1em' }}>
                  <Loader active inline="centered" size="small" />
                </div>
              ) : walletTxs.length === 0 ? (
                <p style={{ color: 'rgba(255,255,255,0.45)', fontSize: '0.85em' }}>No transactions yet.</p>
              ) : (
                <List divided inverted size="small" style={{ maxHeight: '14em', overflowY: 'auto' }}>
                  {walletTxs.map((tx, idx) => (
                    <List.Item key={`${tx.txid}-${idx}`}>
                      <List.Content>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <span style={{ color: tx.amount >= 0 ? '#21ba45' : '#db2828', fontFamily: 'monospace', fontWeight: 'bold' }}>
                            {tx.amount >= 0 ? '+' : ''}{formatSats(Math.round(tx.amount * 1e8))}
                          </span>
                          <span style={{ fontSize: '0.78em', color: 'rgba(255,255,255,0.45)' }}>
                            {tx.confirmations > 0 ? `${tx.confirmations} conf` : 'unconfirmed'}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.75em', color: 'rgba(255,255,255,0.4)', marginTop: '0.15em' }}>
                          <code>{tx.txid.slice(0, 12)}…{tx.txid.slice(-8)}</code>
                          {tx.time ? <span> · {new Date(tx.time * 1000).toLocaleString()}</span> : null}
                        </div>
                      </List.Content>
                    </List.Item>
                  ))}
                </List>
              )}
            </div>
          )}

          {walletView === 'send' && (
            <div style={{ marginTop: '0.75em' }}>
              <Form inverted>
                <Form.Field>
                  <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85em' }}>Recipient address</label>
                  <Input
                    placeholder="bc1q… or bcrt1…"
                    value={sendAddr}
                    onChange={e => setSendAddr(e.target.value)}
                    fluid
                    size="small"
                  />
                </Form.Field>
                <Form.Field>
                  <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85em' }}>Amount (sats)</label>
                  <Input
                    type="number"
                    min={1}
                    placeholder="1000"
                    value={sendAmountSats}
                    onChange={e => setSendAmountSats(e.target.value)}
                    fluid
                    size="small"
                  />
                </Form.Field>
                {sendError ? (
                  <Message negative size="small" onDismiss={() => setSendError(null)}>
                    <p style={{ margin: 0 }}>{sendError}</p>
                  </Message>
                ) : null}
                <p style={{ fontSize: '0.78em', color: 'rgba(255,255,255,0.45)', margin: '0.5em 0' }}>
                  Sends via the active Fabric node&apos;s Bitcoin service (Hub wallet). Transaction signing with local keys (PSBT) is planned.
                </p>
              </Form>
            </div>
          )}

          {walletView === 'faucet' && (
            <div style={{ marginTop: '0.75em' }}>
              <p style={{ color: 'rgba(255,255,255,0.65)', fontSize: '0.82em', marginBottom: '0.5em' }}>
                Request regtest coins from the Hub wallet on your active Fabric authority (
                <code style={{ wordBreak: 'break-all' }}>{getActiveFabricBase() || '—'}</code>
                ). Same contract as Fabric Hub:{' '}
                <code style={{ fontSize: '0.78em' }}>POST /services/bitcoin/faucet</code>.
              </p>
              {btcStatus?.network && btcStatus.network !== 'regtest' ? (
                <Message warning size="small" style={{ marginBottom: '0.5em' }}>
                  <p style={{ margin: 0 }}>
                    Faucet is only supported on <strong>regtest</strong>. This node reports <strong>{btcStatus.network}</strong> — requests may be rejected.
                  </p>
                </Message>
              ) : null}
              <p style={{ fontSize: '0.78em', color: 'rgba(255,255,255,0.45)', margin: '0 0 0.5em' }}>
                Public operator faucet (same playnet style):{' '}
                <a href="https://hub.faucet.pub/" target="_blank" rel="noopener noreferrer">hub.faucet.pub</a>
                {' · '}
                <a href="https://hub.fabric.pub/services/bitcoin/faucet" target="_blank" rel="noopener noreferrer">hub.fabric.pub</a>
              </p>
              <Form inverted>
                <Form.Field>
                  <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85em' }}>Regtest address</label>
                  <Input
                    placeholder="bcrt1…"
                    value={faucetAddr}
                    onChange={e => setFaucetAddr(e.target.value)}
                    fluid
                    size="small"
                  />
                </Form.Field>
                <Form.Field>
                  <label style={{ color: 'rgba(255,255,255,0.7)', fontSize: '0.85em' }}>Amount (sats, max 1,000,000)</label>
                  <Input
                    type="number"
                    min={1}
                    max={1_000_000}
                    value={faucetAmountSats}
                    onChange={e => setFaucetAmountSats(e.target.value)}
                    fluid
                    size="small"
                  />
                </Form.Field>
                <Button.Group size="small" fluid>
                  <Button
                    inverted
                    color="grey"
                    type="button"
                    disabled={!receiveAddr}
                    onClick={() => {
                      if (receiveAddr) setFaucetAddr(receiveAddr);
                    }}
                  >
                    Use receive address
                  </Button>
                  <Button
                    primary
                    type="button"
                    loading={faucetLoading}
                    disabled={!getActiveFabricBase() || !faucetAddr.trim()}
                    onClick={() => { void handleFaucetRequest(); }}
                  >
                    Request from hub faucet
                  </Button>
                </Button.Group>
              </Form>
              {faucetMsg ? (
                <Message
                  style={{ marginTop: '0.75em' }}
                  positive={faucetMsg.type === 'ok'}
                  negative={faucetMsg.type === 'err'}
                  size="small"
                  onDismiss={() => setFaucetMsg(null)}
                >
                  <Message.Header>{faucetMsg.type === 'ok' ? 'Faucet' : 'Faucet failed'}</Message.Header>
                  <p style={{ margin: '0.35em 0 0', wordBreak: 'break-word' }}>{faucetMsg.text}</p>
                  {faucetMsg.txid ? (
                    <p style={{ margin: '0.35em 0 0', fontFamily: 'monospace', fontSize: '0.82em' }}>
                      txid: {faucetMsg.txid}
                    </p>
                  ) : null}
                </Message>
              ) : null}
            </div>
          )}
        </Segment>

        {walletInvites.length > 0 ? (
          <Segment inverted style={{ marginTop: '1em', background: 'rgba(40,80,40,0.35)', border: '1px solid rgba(80,180,80,0.45)', color: 'rgba(255,255,255,0.92)' }}>
            <h4 style={{ margin: '0 0 0.5em', color: 'white', fontSize: '0.95em' }}>
              <Icon name='bitcoin' style={{ marginRight: '0.35em' }} />
              Multisig wallet invitations
            </h4>
            <List divided inverted relaxed size='small'>
              {walletInvites.map((row) => (
                <List.Item key={row.key}>
                  <List.Content floated='right'>
                    <Button
                      size='mini'
                      primary
                      onClick={() => {
                        const invite = parseFederationWalletInvite(row.payload || {});
                        if (!invite) return;
                        setWalletInviteReview({
                          invite,
                          replyPeerId: row.nodeAddress || invite.inviterHubId || null
                        });
                      }}
                    >
                      Review
                    </Button>
                  </List.Content>
                  <List.Content>
                    <List.Header style={{ color: 'rgba(255,255,255,0.95)', fontSize: '0.85em' }}>
                      {row.label}
                      {row.receivedAt ? (
                        <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: '0.5em', fontSize: '0.85em' }}>
                          {timeAgo(new Date(row.receivedAt).toISOString())}
                        </span>
                      ) : null}
                    </List.Header>
                    <List.Description style={{ color: 'rgba(255,255,255,0.6)', fontSize: '0.78em' }}>
                      {row.summary}
                    </List.Description>
                  </List.Content>
                </List.Item>
              ))}
            </List>
          </Segment>
        ) : null}

        <MultisigWalletInvitePanel
          hubBase={hubBase}
          inviterPubkey={inviterPubkey}
          inviterHubId={nodeSigninResult && nodeSigninResult.ok ? (nodeSigninResult.fabricPeerId || null) : null}
        />

        <FederationWalletInviteModal
          open={!!walletInviteReview}
          invite={walletInviteReview ? walletInviteReview.invite : null}
          hubBase={hubBase}
          responderPubkey={inviterPubkey}
          replyPeerId={walletInviteReview ? walletInviteReview.replyPeerId : null}
          onClose={() => setWalletInviteReview(null)}
          onResolved={() => void refreshArcNotifications()}
        />

        <Button.Group vertical fluid style={{ marginTop: '1em' }}>
          <Button
            inverted
            color="grey"
            content='Back'
            onClick={() => { setWalletView(null); setState('logged_in'); }}
          />
        </Button.Group>
      </div>
    );
  };

  const renderPeersPage = () => {
    const otherArc = arcNotifications.filter((r) => r.messageType !== FEDERATION_CONTRACT_INVITE);
    const pendingMultisig = arcNotifications.filter((r) => r.messageType === FEDERATION_CONTRACT_INVITE).length;

    return (
      <div className="fade-in" style={{ width: '100%' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75em' }}>
          <h3 style={{ margin: 0, color: 'white', fontSize: '1.05em' }}>
            <Icon name="sitemap" style={{ marginRight: '0.35em' }} />
            Peers
          </h3>
          <Button
            size="mini"
            inverted
            color="grey"
            loading={arcNotificationsBusy}
            disabled={arcNotificationsBusy}
            onClick={() => void refreshArcNotifications()}
          >
            Refresh
          </Button>
        </div>

        <Segment inverted style={darkPanelStyle}>
          <h4 style={{ margin: '0 0 0.5em', color: 'white', fontSize: '0.95em' }}>
            <Icon name="plug" style={{ marginRight: '0.35em' }} />
            Fabric node
          </h4>
          {nodeSigninResult && nodeSigninResult.ok ? (
            <Message positive size="small" style={{ marginBottom: '0.65em' }} onDismiss={() => setNodeSigninResult(null)}>
              <p style={{ margin: 0 }}>
                Connected.
                {nodeSigninResult.fabricPeerId ? (
                  <span> Peer: <code style={{ fontSize: '0.85em' }}>{nodeSigninResult.fabricPeerId.slice(0, 14)}…</code></span>
                ) : null}
                {nodeSigninResult.clock != null ? ` · clock ${nodeSigninResult.clock}` : ''}
              </p>
            </Message>
          ) : null}
          {nodeSigninResult && !nodeSigninResult.ok ? (
            <Message negative size="small" style={{ marginBottom: '0.65em' }} onDismiss={() => setNodeSigninResult(null)}>
              <p style={{ margin: 0 }}>{nodeSigninResult.error || 'Connection failed'}</p>
            </Message>
          ) : null}
          <Button
            fluid
            primary
            size="small"
            loading={nodeSigninBusy}
            disabled={nodeSigninBusy}
            onClick={() => void handleNodeSignin()}
          >
            <Icon name="sign-in" />
            Connect &amp; register
          </Button>
          <p style={{ fontSize: '0.8em', color: 'rgba(255,255,255,0.55)', marginTop: '0.5em', marginBottom: 0 }}>
            Connects to your active Fabric node, verifies its identity, and registers this wallet for notifications
            (multisig wallet invitations, group proposals, chat, delegation signatures).
            Manage hub URLs under Settings.
          </p>
        </Segment>

        {pendingMultisig > 0 ? (
          <Message info size="small" style={{ marginTop: '1em' }}>
            <p style={{ margin: 0 }}>
              {pendingMultisig} multisig wallet invitation{pendingMultisig === 1 ? '' : 's'} waiting —{' '}
              <a
                href="#wallet"
                style={{ cursor: 'pointer' }}
                onClick={(e) => {
                  e.preventDefault();
                  openWalletPage(null);
                }}
              >
                open Wallet
              </a>
              {' '}to review.
            </p>
          </Message>
        ) : null}

        <Segment inverted style={{ marginTop: '1em', ...darkPanelStyle }}>
          <h4 style={{ margin: '0 0 0.5em', color: 'white', fontSize: '0.95em' }}>
            <Icon name='sitemap' style={{ marginRight: '0.35em' }} />
            Application contracts
          </h4>
          <p style={{ fontSize: '0.78em', color: 'rgba(255,255,255,0.5)', marginTop: 0 }}>
            ARC traffic from the mesh (group proposals, missions, chat-related notices). Multisig invites live on the Wallet page.
          </p>
          {otherArc.length === 0 ? (
            <p style={{ fontSize: '0.8em', color: 'rgba(255,255,255,0.4)', marginBottom: 0 }}>
              No contract notifications yet.
            </p>
          ) : (
            <List divided inverted relaxed size='small' style={{ marginTop: '0.35em' }}>
              {otherArc.map((row) => (
                <List.Item key={row.key}>
                  <List.Content>
                    <List.Header style={{ color: 'rgba(255,255,255,0.9)', fontSize: '0.85em' }}>
                      {row.label}
                      {row.receivedAt ? (
                        <span style={{ fontWeight: 400, color: 'rgba(255,255,255,0.45)', marginLeft: '0.5em', fontSize: '0.85em' }}>
                          {timeAgo(new Date(row.receivedAt).toISOString())}
                        </span>
                      ) : null}
                    </List.Header>
                    <List.Description style={{ color: 'rgba(255,255,255,0.55)', fontSize: '0.78em', wordBreak: 'break-word' }}>
                      {row.summary}
                    </List.Description>
                  </List.Content>
                </List.Item>
              ))}
            </List>
          )}
        </Segment>

        <Button.Group vertical fluid style={{ marginTop: '1em' }}>
          <Button
            inverted
            color="grey"
            content='Back'
            onClick={() => setState('logged_in')}
          />
        </Button.Group>
      </div>
    );
  };

  const renderLoggedInState = () => {
    const current = identities.find(id => id.isCurrent);
    const balanceLabel = walletBalance
      ? formatSats(walletBalance.balanceSats)
      : `${current?.balance || '0.00'} BTC`;

    return (
    <div className="fade-in" style={{ width: '100%' }}>
      {current && (
        <Segment
          style={{
            cursor: 'pointer',
            position: 'relative'
          }}
          onClick={() => {
            setStartEditingOnDetail(false);
            handleIdentityClick(current);
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between'
          }}>
            <div style={{ flex: 1 }}>
              <h4 style={{
                fontSize: '1.1em',
                marginBottom: '0.5em',
                display: 'flex',
                alignItems: 'center',
                gap: '0.5em'
              }}>
                {truncateMiddle(current.name || 'Unnamed Identity')}
                <Icon
                  name='pencil'
                  style={{
                    opacity: 0,
                    transition: 'opacity 0.2s',
                    cursor: 'pointer'
                  }}
                  className="edit-icon"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    setStartEditingOnDetail(true);
                    setSelectedIdentity(current);
                    setState('identity_detail');
                  }}
                />
              </h4>
            </div>
          </div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5em',
            fontFamily: 'monospace',
            fontSize: '1.2em',
            fontWeight: 'bold',
            marginBottom: '0.5em'
          }}>
            <span>{balanceLabel}</span>
          </div>
          <p style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.8em', marginBottom: 0 }}>
            {truncateMiddle(current.id || '')}
          </p>
          {renderIdentityCardActionBar()}
        </Segment>
      )}
      {(() => {
        const cur = identities.find(id => id.isCurrent);
        if (!cur?.hasPrivateKey || cur.privateKeyHex || !cur.id || !walletCryptos[cur.id]) return null;
        return (
          <>
            {showAutoLockBanner && (
              <Message
                warning
                size="small"
                style={{ marginTop: '0.75em' }}
                onDismiss={() => setShowAutoLockBanner(false)}
              >
                <p style={{ margin: 0 }}>
                  Session timed out
                  {settings.autoLockTimer > 0
                    ? ` after ${settings.autoLockTimer} minute${settings.autoLockTimer === 1 ? '' : 's'} without activity`
                    : ''}
                  . In-memory signing keys were cleared.
                </p>
              </Message>
            )}
            <Message info size="small" style={{ marginTop: showAutoLockBanner ? '0.5em' : '0.75em' }}>
              <p style={{ margin: 0 }}>
                Offline signing is locked. Open <strong>Sign Message</strong> and enter the password you used when creating or restoring this identity to use the encrypted key stored on this device.
              </p>
            </Message>
          </>
        );
      })()}

      <style>{`
        .ui.segment:hover .edit-icon {
          opacity: 0.5 !important;
        }
        .ui.segment .edit-icon:hover {
          opacity: 1 !important;
        }
      `}</style>

      <Message style={{ marginTop: '1em' }}>
        <Message.Header>Loaded Identities</Message.Header>
        <Message.Content style={{ marginTop: '1em' }}>
          <List divided relaxed size='small'>
            {identities.map((identity, index) => (
              <List.Item
                key={index}
                style={{ cursor: 'pointer' }}
                onClick={() => handleIdentityClick(identity)}
              >
                <List.Icon name={identity.isCurrent ? 'check circle' : 'circle outline'} color={identity.isCurrent ? 'green' : 'grey'} />
                <List.Content>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5em' }}>
                    <List.Header style={{ fontSize: '0.9em' }}>
                      {truncateMiddle(identity.name || 'Unnamed Identity')}
                    </List.Header>
                    <Icon
                      name='pencil'
                      link
                      style={{ opacity: 0.5, transition: 'opacity 0.2s' }}
                      onClick={(e: React.MouseEvent) => {
                        e.stopPropagation();
                        handleEditIdentity(identity);
                      }}
                    />
                    <Icon
                      name={identity.hasPrivateKey ? 'lock' : 'unlock'}
                      color={identity.hasPrivateKey ? 'green' : 'grey'}
                      title={identity.hasPrivateKey ? 'Has signing ability' : 'Read-only identity'}
                    />
                  </div>
                  <List.Description style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.7em' }}>
                    {truncateMiddle(identity.id)}
                  </List.Description>
                </List.Content>
              </List.Item>
            ))}
          </List>
        </Message.Content>
      </Message>

      <Button.Group vertical fluid style={{ marginTop: '1em' }}>
        <Button
          color='green'
          content='Add New Identity'
          onClick={() => setState('add_identity')}
        />
        <Button
          primary
          content='Sign Message'
          onClick={() => {
            const currentIdentity = identities.find(id => id.isCurrent);
            if (currentIdentity) {
              setSelectedIdentity(currentIdentity);
              setVerificationResult(null);
              setMessageToSign('');
              setSignature(null);
              setShowSignature(false);
              setSignUnlockPassword('');
              setSignUnlockError(null);
              setClipboardNotice(null);
              setState('sign_message');
            }
          }}
        />
        <Button
          primary
          content='Verify Message'
          onClick={() => {
            setVerificationResult(null);
            setMessageToVerify('');
            setSignatureToVerify('');
            setPubkeyToVerify('');
            setState('verify_message');
          }}
        />
      </Button.Group>
    </div>
    );
  };


  const renderAddIdentityState = () => (
    <div className="fade-in" style={{ width: '100%' }}>
      <Message info>
        <Message.Header>Add New Identity</Message.Header>
        <Message.Content>
          <p style={{ color: 'white' }}>Choose how you'd like to add a new identity:</p>
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              color='green'
              content='Create New'
              onClick={() => setState('warning')}
            />
            <Button
              primary
              content='Use Existing Seed Phrase'
              onClick={() => setState('seed_phrase_entry')}
            />
            <Button
              primary
              content='Use Existing xpub'
              onClick={() => {
                setXpubState('input');
                setXpub('');
                setState('xpub_login');
              }}
            />
            <Button
              color='black'
              content='Back to Dashboard'
              onClick={() => setState('logged_in')}
            />
          </Button.Group>
        </Message.Content>
      </Message>
    </div>
  );

  const renderDebugInfo = () => {
    if (process.env.NODE_ENV !== 'development') return null;

    const browserStorage = {
      identities: identities.map(id => ({
        name: id.name,
        xpub: id.xpub,
        bech32: id.bech32,
        isCurrent: id.isCurrent
      })),
      keys: [], // This would be populated with actual keys if available
      blobs: [], // This would be populated with actual blobs if available
      settings: settings
    };

    return (
      <Message size="small" className="fade-in" style={{ marginBottom: '1em' }}>
        <Message.Header>
          Debug Info
          <Button
            size="mini"
            floated="right"
            icon={showDebug ? 'eye slash' : 'eye'}
            onClick={() => setShowDebug(!showDebug)}
            style={{ marginLeft: '1em' }}
          />
        </Message.Header>
        {showDebug && (
          <Message.Content>
            <p>Browser Storage:</p>
            <pre style={{
              fontSize: '0.8em',
              wordBreak: 'break-all',
              whiteSpace: 'pre-wrap',
              fontFamily: 'monospace',
              color: '#666'
            }}>
              {JSON.stringify(browserStorage, null, 2)}
            </pre>
          </Message.Content>
        )}
      </Message>
    );
  };

  const renderConfirmationState = () => (
    <Message className="fade-in">
      <Message.Header>Confirm Your Identity</Message.Header>
      <Message.Content>
        <p>Please enter your seed phrase and password to confirm you have saved them correctly.</p>
        <Message info>
          <Message.Header>Important Note</Message.Header>
          <p>If you are not using a derivation password and understand the risks, leave the password field blank.</p>
          <p>Remember: Without a password, anyone with access to your seed phrase can control your funds.</p>
        </Message>
        <Form>
          <Form.Field>
            <label>Enter your seed phrase:</label>
            <Input
              type="text"
              placeholder="Seed phrase"
              value={confirmationSeed}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmationSeed(e.target.value)}
              error={passwordState === 'error'}
              disabled={passwordState === 'verifying'}
              autoComplete={false}
            />
          </Form.Field>
          <Form.Field>
            <label>Enter the derivation password:</label>
            <Input
              autoComplete="new-password"
              type="password"
              placeholder="Password (leave blank if not using one)"
              value={confirmationPassword}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setConfirmationPassword(e.target.value)}
              error={passwordState === 'error'}
              disabled={passwordState === 'verifying'}
            />
          </Form.Field>
          {passwordState === 'error' && (
            <Message negative>
              <Message.Header>Verification Failed</Message.Header>
              <p>Please check your seed phrase and password and try again.</p>
            </Message>
          )}
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              color='black'
              content='Go Back'
              onClick={handleGoBackWithConfirmationReset}
              disabled={passwordState === 'verifying'}
            />
            <Button
              color='green'
              content='Verify'
              onClick={handleConfirmation}
              disabled={!confirmationSeed.trim() || passwordState === 'verifying'}
              loading={passwordState === 'verifying'}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderLoginSelection = () => (
    <Message className="fade-in">
      <Message.Header>Choose Login Method</Message.Header>
      <Message.Content>
        <p>Select how you would like to log in:</p>
        <Button.Group vertical fluid style={{ marginTop: '1em' }}>
          <Button
            color='green'
            content='Use Seed Phrase'
            onClick={() => setState('seed_phrase_login')}
          />
          <Button
            basic
            disabled
            title='Extended private key import is not available in this build.'
            content='Use Extended Private Key (xprv) — coming soon'
          />
          <Button
            primary
            content='Use Extended Public Key (xpub)'
            onClick={() => {
              setXpubState('input');
              setXpub('');
              setState('xpub_login');
            }}
          />
          <Button
            content='Go Back'
            onClick={handleGoBack}
          />
        </Button.Group>
      </Message.Content>
    </Message>
  );

  const renderSeedPhraseLogin = () => (
    <Message className="fade-in">
      <Message.Header>Login with Seed Phrase</Message.Header>
      <Message.Content>
        <p>Enter your seed phrase and derivation password to log in.</p>
        <Form>
          <Form.Field>
            <label>Seed Phrase</label>
            <Input
              type="text"
              placeholder="Enter your 12 or 24 word seed phrase"
              value={seedPhrase || ''}
              onChange={(e) => {
                const phrase = e.target.value.trim();
                setSeedPhrase(phrase);
                // Validate the phrase
                const words = phrase.split(/\s+/);
                const isValidLength = words.length === 12 || words.length === 24;
                const allWordsValid = words.every(word => wordlist.includes(word.toLowerCase()));
                setIsValidPhrase(isValidLength && allWordsValid);
              }}
              error={!isValidPhrase && seedPhrase !== null}
              style={{ fontFamily: 'monospace' }}
            />
            {!isValidPhrase && seedPhrase !== null && (
              <Message negative>
                <Message.Header>Invalid Seed Phrase</Message.Header>
                <p>Please ensure all words are from the BIP39 wordlist and the phrase contains exactly 12 or 24 words.</p>
              </Message>
            )}
          </Form.Field>
          <Form.Field>
            <label>Derivation Password</label>
            <Input
              type="password"
              placeholder="Enter your derivation password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordState === 'error'}
              autoComplete="current-password"
            />
            {passwordState === 'error' && (
              <Message negative>
                <Message.Header>Error</Message.Header>
                <p>Failed to restore identity. Please check your seed phrase and password.</p>
              </Message>
            )}
          </Form.Field>
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              color='green'
              content='Login'
              onClick={async () => {
                try {
                  if (!seedPhrase) {
                    setIsValidPhrase(false);
                    return;
                  }

                  // Generate the seed from the mnemonic
                  const seed = mnemonicToSeedSync(seedPhrase, password);

                  // Derive the master key using BIP32
                  const masterKey = bip32.fromSeed(seed);

                  const path = settings.derivationPath;
                  const derivedKey = masterKey.derivePath(path);
                  const { identity: newIdentity, blob } = identityAndWalletBlobFromNode(derivedKey, path, password);

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });
                  setWalletCryptos(prev => ({ ...prev, [newIdentity.id]: blob }));

                  setState('logged_in');

                  // Clear sensitive data
                  setPassword('');
                  setSeedPhrase(null);
                } catch (error) {
                  console.error('Failed to login with seed phrase:', error);
                  // Show error message
                  setPasswordState('error');
                }
              }}
              disabled={!isValidPhrase || !seedPhrase}
            />
            <Button
              color='black'
              content='Go Back'
              onClick={() => setState('login_selection')}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderRestoreIdentity = () => (
    <Message className="fade-in">
      <Message.Header>Restore Identity</Message.Header>
      <Message.Content>
        <p>Please enter your seed phrase and derivation password to restore your identity.</p>
        <Form>
          <Form.Field>
            <label>Seed Phrase</label>
            <Input
              type="text"
              placeholder="Enter your 12 or 24 word seed phrase"
              value={seedPhrase || ''}
              onChange={(e) => {
                const phrase = e.target.value.trim();
                setSeedPhrase(phrase);
                // Validate the phrase
                const words = phrase.split(/\s+/);
                const isValidLength = words.length === 12 || words.length === 24;
                const allWordsValid = words.every(word => wordlist.includes(word.toLowerCase()));
                setIsValidPhrase(isValidLength && allWordsValid);
              }}
              error={!isValidPhrase && seedPhrase !== null}
              style={{ fontFamily: 'monospace' }}
            />
            {!isValidPhrase && seedPhrase !== null && (
              <Message negative>
                <Message.Header>Invalid Seed Phrase</Message.Header>
                <p>Please ensure all words are from the BIP39 wordlist and the phrase contains exactly 12 or 24 words.</p>
              </Message>
            )}
          </Form.Field>
          <Form.Field>
            <label>Derivation Password</label>
            <Input
              type="password"
              placeholder="Enter your derivation password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={passwordState === 'error'}
              autoComplete="current-password"
            />
            {passwordState === 'error' && (
              <Message negative>
                <Message.Header>Error</Message.Header>
                <p>Failed to restore identity. Please check your seed phrase and password.</p>
              </Message>
            )}
          </Form.Field>
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              content='Restore Identity'
              onClick={async () => {
                try {
                  if (!seedPhrase) {
                    setIsValidPhrase(false);
                    return;
                  }
                  setPasswordState('verifying');

                  // Generate the seed from the mnemonic
                  const seed = mnemonicToSeedSync(seedPhrase, password);

                  // Derive the master key using BIP32
                  const masterKey = bip32.fromSeed(seed);

                  const path = settings.derivationPath;
                  const derivedKey = masterKey.derivePath(path);
                  const { identity: newIdentity, blob } = identityAndWalletBlobFromNode(derivedKey, path, password);

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });
                  setWalletCryptos(prev => ({ ...prev, [newIdentity.id]: blob }));

                  setState('logged_in');

                  // Clear sensitive data
                  setPassword('');
                  setSeedPhrase(null);
                } catch (error) {
                  console.error('Failed to restore identity:', error);
                  setPasswordState('error');
                }
              }}
              disabled={!isValidPhrase || !seedPhrase || !password.trim()}
              loading={passwordState === 'verifying'}
            />
            <Button
              content='Go Back'
              onClick={() => setState('add_identity')}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderNodeList = () => (
    <List divided relaxed>
      {settings.bitcoinNodes.map(node => (
        <List.Item key={node.id}>
          <List.Content>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1em' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <List.Header style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>
                  {node.id}
                </List.Header>
                <List.Description style={{
                  fontFamily: 'monospace',
                  fontSize: '0.8em'
                }}>
                  <Popup
                    content={node.connectionString}
                    trigger={<span style={{ cursor: 'pointer' }}>{truncateMiddle(node.connectionString, 20, 10)}</span>}
                    position='top left'
                    style={{ maxWidth: '500px', wordBreak: 'break-all' }}
                  />
                </List.Description>
              </div>
              <div style={{ flexShrink: 0 }}>
                <Button.Group size='mini'>
                  <Button
                    icon='plug'
                    color='blue'
                    onClick={() => handleTestNode(node)}
                    title='Test connection'
                  />
                  <Button
                    icon={node.isActive ? 'pause' : 'play'}
                    color={node.isActive ? 'orange' : 'green'}
                    onClick={() => handleToggleNode(node.id)}
                    title={node.isActive ? 'Deactivate (RPC signing uses the active node)' : 'Set active for RPC'}
                  />
                  <Button
                    icon='trash'
                    color='red'
                    onClick={() => handleRemoveNode(node.id)}
                    title='Remove node'
                  />
                </Button.Group>
              </div>
            </div>
          </List.Content>
        </List.Item>
      ))}
      <List.Item>
        <List.Content>
          <Form>
            <Form.Field>
              <label>Bitcoin Host</label>
              <Input
                placeholder="https://hub.fabric.pub/services/bitcoin or http://user:pass@host:port"
                value={newNodeConnection}
                onChange={(e) => setNewNodeConnection(e.target.value)}
              />
              <Button.Group size='mini' style={{ marginTop: '0.5em', flexWrap: 'wrap' }}>
                {BITCOIN_HOST_PRESETS.map(p => (
                  <Button
                    key={p.id}
                    type='button'
                    content={p.label}
                    onClick={() => setNewNodeConnection(p.connectionString)}
                  />
                ))}
              </Button.Group>
            </Form.Field>
            <Button
              primary
              content='Add Node'
              onClick={handleAddNode}
              disabled={!newNodeConnection.trim()}
            />
          </Form>
        </List.Content>
      </List.Item>
    </List>
  );

  const renderFabricNodeList = () => (
    <List divided relaxed>
      {settings.fabricNodes.map(node => (
        <List.Item key={node.id}>
          <List.Content>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1em' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <List.Header style={{ fontFamily: 'monospace', fontSize: '0.8em' }}>
                  {node.id}
                </List.Header>
                <List.Description style={{
                  fontFamily: 'monospace',
                  fontSize: '0.8em'
                }}>
                  <Popup
                    content={node.hubAddress}
                    trigger={<span style={{ cursor: 'pointer' }}>{truncateMiddle(node.hubAddress, 22, 10)}</span>}
                    position='top left'
                    style={{ maxWidth: '500px', wordBreak: 'break-all' }}
                  />
                </List.Description>
              </div>
              <div style={{ flexShrink: 0 }}>
                <Button.Group size='mini'>
                  <Button
                    icon='plug'
                    color='blue'
                    onClick={() => handleTestFabricNode(node)}
                    title='Test WebSocket signaling'
                  />
                  <Button
                    icon={node.isActive ? 'pause' : 'play'}
                    color={node.isActive ? 'orange' : 'green'}
                    onClick={() => handleToggleFabricNode(node.id)}
                    title={node.isActive ? 'Deactivate (background mesh uses the active hub)' : 'Set active for mesh'}
                  />
                  <Button
                    icon='trash'
                    color='red'
                    onClick={() => handleRemoveFabricNode(node.id)}
                    title='Remove Fabric node'
                  />
                </Button.Group>
              </div>
            </div>
          </List.Content>
        </List.Item>
      ))}
      <List.Item>
        <List.Content>
          <Form>
            <Form.Field>
              <label>Fabric Hub (signaling)</label>
              <Input
                placeholder="https://hub.fabric.pub or http://127.0.0.1:3003"
                value={newFabricHubAddress}
                onChange={(e) => setNewFabricHubAddress(e.target.value)}
              />
              <Button.Group size='mini' style={{ marginTop: '0.5em', flexWrap: 'wrap' }}>
                {FABRIC_HUB_PRESETS.map(p => (
                  <Button
                    key={p.id}
                    type='button'
                    content={p.label}
                    onClick={() => setNewFabricHubAddress(p.hubAddress)}
                  />
                ))}
              </Button.Group>
            </Form.Field>
            <Button
              primary
              content='Add Fabric Node'
              onClick={handleAddFabricNode}
              disabled={!newFabricHubAddress.trim()}
            />
          </Form>
        </List.Content>
      </List.Item>
    </List>
  );

  const renderFabricTestModal = () => (
    <Modal
      open={isFabricTestModalOpen}
      onClose={() => setIsFabricTestModalOpen(false)}
      size='small'
    >
      <Modal.Header>
        Test Fabric signaling (WebSocket)
        {testingFabricNode && (
          <div style={{ fontSize: '0.8em', marginTop: '0.5em', fontFamily: 'monospace' }}>
            {testingFabricNode.id}
          </div>
        )}
      </Modal.Header>
      <Modal.Content>
        {testingFabricNode && (
          <div>
            {fabricTestError ? (
              <Message negative>
                <Message.Header>Connection Failed</Message.Header>
                <p>{fabricTestError}</p>
              </Message>
            ) : !fabricTestOk ? (
              <div style={{ textAlign: 'center', padding: '2em' }}>
                <Loader active inline='centered' />
                <p style={{ marginTop: '1em' }}>Opening WebSocket…</p>
              </div>
            ) : (
              <Message positive>
                <Message.Header>Signaling endpoint reachable</Message.Header>
                <p style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.85em' }}>
                  {fabricTestOk.url}
                </p>
                <p style={{ marginTop: '0.5em' }}>
                  Subprotocol: <code>{fabricTestOk.subprotocol}</code>
                </p>
              </Message>
            )}
          </div>
        )}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => setIsFabricTestModalOpen(false)}>
          Close
        </Button>
      </Modal.Actions>
    </Modal>
  );

  const renderTestNodeModal = () => (
    <Modal
      open={isTestModalOpen}
      onClose={() => setIsTestModalOpen(false)}
      size='small'
    >
      <Modal.Header>
        Test Node Connection
        {testingNode && (
          <div style={{ fontSize: '0.8em', marginTop: '0.5em', fontFamily: 'monospace' }}>
            {testingNode.id}
          </div>
        )}
      </Modal.Header>
      <Modal.Content>
        {testingNode && (
          <div>
            {testError ? (
              <Message negative>
                <Message.Header>Connection Failed</Message.Header>
                <p>{testError}</p>
              </Message>
            ) : !testResult ? (
              <div style={{ textAlign: 'center', padding: '2em' }}>
                <Loader active inline='centered' />
                <p style={{ marginTop: '1em' }}>Testing connection...</p>
              </div>
            ) : (
              <div>
                <Message positive>
                  <Message.Header>Connection Successful</Message.Header>
                  <p>Node is online and responding</p>
                </Message>
                <Table definition>
                  <Table.Body>
                    <Table.Row>
                      <Table.Cell>Chain</Table.Cell>
                      <Table.Cell>{testResult.chain}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Blocks</Table.Cell>
                      <Table.Cell>{testResult.blocks}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Headers</Table.Cell>
                      <Table.Cell>{testResult.headers}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Best Block</Table.Cell>
                      <Table.Cell style={{
                        fontFamily: 'monospace',
                        fontSize: '0.8em',
                        wordBreak: 'break-all'
                      }}>
                        {testResult.bestblockhash}
                      </Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Difficulty</Table.Cell>
                      <Table.Cell>{testResult.difficulty}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Chain Work</Table.Cell>
                      <Table.Cell style={{ fontFamily: 'monospace' }}>{testResult.chainwork}</Table.Cell>
                    </Table.Row>
                    <Table.Row>
                      <Table.Cell>Median Time</Table.Cell>
                      <Table.Cell>{new Date(testResult.mediantime * 1000).toLocaleString()}</Table.Cell>
                    </Table.Row>
                  </Table.Body>
                </Table>
              </div>
            )}
          </div>
        )}
      </Modal.Content>
      <Modal.Actions>
        <Button onClick={() => setIsTestModalOpen(false)}>
          Close
        </Button>
      </Modal.Actions>
    </Modal>
  );

  const renderSettings = () => (
    <Message className="fade-in">
      <Message.Header>Settings</Message.Header>
      <Message.Content>
        <Segment basic>
          <h4>Identity Management</h4>
          <List divided relaxed>
            <List.Item>
              <List.Content>
                <List.Header>Auto-Lock Timer</List.Header>
                <List.Description>
                  <Form.Field>
                    <label>Lock wallet after inactivity (minutes, 0 = off):</label>
                    <Input
                      type="number"
                      min={0}
                      max={720}
                      value={settings.autoLockTimer}
                      onChange={(e) => {
                        const v = parseInt(e.target.value, 10);
                        const n = Number.isNaN(v) ? DEFAULT_SETTINGS.autoLockTimer : Math.max(0, Math.min(720, v));
                        handleSettingsChange('autoLockTimer', n);
                      }}
                      fluid
                    />
                    <p style={{ marginTop: '0.5em', fontSize: '0.85em', color: 'rgba(255,255,255,0.65)' }}>
                      After this many minutes without keyboard or pointer activity in the popup, session signing keys and any seed phrase in memory are cleared. The timer uses the same clock when you close and reopen the popup.
                    </p>
                  </Form.Field>
                </List.Description>
              </List.Content>
            </List.Item>
            <List.Item>
              <List.Content>
                <List.Header>Default Derivation Path</List.Header>
                <List.Description>
                  <p style={{ marginBottom: '0.75em' }}>
                    Seed-based identities are derived at this path. The matching extended private key (xprv) is encrypted on this device with the password you set at creation or seed login so you can sign after restart.
                  </p>
                  <Form.Field>
                    <label>BIP32 derivation path:</label>
                    <Input
                      value={settings.derivationPath}
                      onChange={(e) => handleSettingsChange('derivationPath', e.target.value)}
                      placeholder={FABRIC_KEY_DERIVATION_PATH}
                      fluid
                      disabled
                      title={settings.derivationPath}
                    />
                    {settings.derivationPath.trim() !== FABRIC_KEY_DERIVATION_PATH && (
                      <p style={{ marginTop: '0.5em', fontSize: '0.85em', color: 'rgba(255,200,120,0.95)' }}>
                        Differs from the current Fabric default ({FABRIC_KEY_DERIVATION_PATH}). Keep this only if your identities were created with this path.
                      </p>
                    )}
                  </Form.Field>
                </List.Description>
              </List.Content>
            </List.Item>
          </List>

          <h4 style={{ marginTop: '2em' }}>Bitcoin Nodes</h4>
          {renderNodeList()}
          {renderTestNodeModal()}
          <Form.Field style={{ marginTop: '1em', maxWidth: '32rem' }}>
            <label style={{ color: 'rgba(255,255,255,0.9)' }}>Hub xpub query token (optional)</label>
            <Input
              type="password"
              autoComplete="off"
              placeholder="Matches FABRIC_BITCOIN_XPUB_QUERY_TOKEN when the hub requires it"
              value={settings.xpubQueryToken}
              onChange={(e) => handleSettingsChange('xpubQueryToken', e.target.value)}
              fluid
            />
            <p style={{ marginTop: '0.5em', fontSize: '0.85em', color: 'rgba(255,255,255,0.65)' }}>
              When the Hub gates watch-only <code style={{ fontSize: '0.85em' }}>GET /services/bitcoin/xpub</code> (balance and transaction scans), paste the same shared secret here. Leave empty for hubs that allow anonymous xpub queries.
            </p>
          </Form.Field>

          <h4 style={{ marginTop: '2em' }}>Fabric Nodes</h4>
          <p style={{ marginBottom: '0.75em', color: 'rgba(255,255,255,0.85)' }}>
            WebRTC data channels use the Hub WebSocket for signaling (same as hub.fabric.pub Bridge). Test opens <code style={{ fontSize: '0.85em' }}>wss://…/</code> then closes. Offscreen mesh registers via <code>RegisterWebRTCPeer</code>, discovers peers, completes offer/answer, and relays binary AMP (<code>CONTRACT_MESSAGE</code> / fabric-message) through <code>RelayFromWebRTC</code> — no HTTP for mesh traffic.
          </p>
          <FabricBackgroundMeshActions fabricNodes={settings.fabricNodes} />
          {renderFabricNodeList()}
          {renderFabricTestModal()}

          <h4 style={{ marginTop: '2em' }}>Security</h4>
          <List divided relaxed>
            <List.Item>
              <List.Content>
                <List.Header>Backup & Restore</List.Header>
                <List.Description>
                  <p>Export or restore your wallet data.</p>
                  <Button.Group>
                    <Button
                      primary
                      content='Export Wallet'
                      onClick={handleExportWallet}
                    />
                  </Button.Group>
                </List.Description>
              </List.Content>
            </List.Item>
            <List.Item>
              <List.Content>
                <List.Header>Clear All Data</List.Header>
                <List.Description>
                  <p>Remove all identities and settings from this device.</p>
                  <Button
                    negative
                    content='Clear Data'
                    onClick={() => openEraseConfirm('erase_all')}
                  />
                </List.Description>
              </List.Content>
            </List.Item>
          </List>

          <h4 style={{ marginTop: '2em' }}>About</h4>
          <List divided relaxed>
            <List.Item>
              <List.Content>
                <List.Header>Version</List.Header>
                <List.Description>{PASSPORT_EXTENSION_VERSION}</List.Description>
              </List.Content>
            </List.Item>
          </List>
        </Segment>

        <Button.Group vertical fluid style={{ marginTop: '2em' }}>
          <Button
            color='black'
            content='Back'
            onClick={() => setState('logged_in')}
          />
        </Button.Group>
      </Message.Content>
    </Message>
  );

  const renderView = () => {
    switch (state) {
      case 'initial':
        return renderInitialState();
      case 'warning':
        return renderIntroductionState();
      case 'generating':
        return renderGeneratingState();
      case 'complete':
        return renderCompleteState();
      case 'confirmation':
        return renderConfirmationState();
      case 'xpub_login':
        return renderXpubLoginState();
      case 'logged_in':
        return renderLoggedInState();
      case 'wallet':
        return renderWalletPage();
      case 'peers':
        return renderPeersPage();
      case 'add_identity':
        return renderAddIdentityState();
      case 'derivation_password_warning':
        return renderDerivationPasswordWarningState();
      case 'derivation_password_entry':
        return renderDerivationPasswordEntry();
      case 'seed_phrase_entry':
        return renderSeedPhraseEntry();
      case 'identity_detail':
        return renderIdentityDetail();
      case 'login_selection':
        return renderLoginSelection();
      case 'seed_phrase_login':
        return renderSeedPhraseLogin();
      case 'sign_message':
        return renderSignMessageState();
      case 'restore_identity':
        return renderRestoreIdentity();
      case 'settings':
        return renderSettings();
      case 'verify_message':
        return renderVerifyMessageState();
      default:
        return null;
    }
  };

  const getActiveFabricBase = useCallback((): string | null => {
    const active = settings.fabricNodes.find(n => n.isActive);
    return active ? active.hubAddress.replace(/\/+$/, '') : null;
  }, [settings.fabricNodes]);

  const refreshWalletBalance = useCallback(async () => {
    const base = getActiveFabricBase();
    const cur = identities.find(id => id.isCurrent);
    if (!base || !cur) return;
    setWalletBalanceLoading(true);
    try {
      const status = await fetchBitcoinStatus(base);
      setBtcStatus(status);
      if (!status.available) {
        setWalletBalance(null);
        return;
      }
      const bal = await fetchWalletBalance(base, cur.xpub, status.network || 'regtest', {
        xpubQueryToken: settings.xpubQueryToken
      });
      setWalletBalance(bal);
      if (bal.balanceSats != null) {
        setIdentities(prev => prev.map(id =>
          id.isCurrent ? { ...id, balance: formatBtc(bal.balanceSats) } : id
        ));
      }
    } catch (err: unknown) {
      swallowNonFatal('identity-wallet-balance-refresh', err);
    } finally {
      setWalletBalanceLoading(false);
    }
  }, [getActiveFabricBase, identities, settings.xpubQueryToken]);

  const refreshWalletTxs = useCallback(async () => {
    const base = getActiveFabricBase();
    const cur = identities.find(id => id.isCurrent);
    if (!base || !cur?.xpub) {
      setWalletTxs([]);
      return;
    }
    setWalletTxsLoading(true);
    try {
      const net = btcStatus?.network || 'regtest';
      const txs = await fetchTransactionHistory(base, cur.xpub, net, 25, {
        xpubQueryToken: settings.xpubQueryToken
      });
      setWalletTxs(txs);
    } catch (err: unknown) {
      swallowNonFatal('identity-wallet-tx-refresh', err);
      setWalletTxs([]);
    } finally {
      setWalletTxsLoading(false);
    }
  }, [getActiveFabricBase, identities, btcStatus, settings.xpubQueryToken]);

  const handleFaucetRequest = useCallback(async () => {
    const base = getActiveFabricBase();
    if (!base) {
      setFaucetMsg({
        type: 'err',
        text: 'No active Fabric node. Open Settings → Fabric Nodes and activate your remote authority (Hub URL).'
      });
      return;
    }
    const address = faucetAddr.trim();
    if (!address) {
      setFaucetMsg({ type: 'err', text: 'Enter a regtest receive address (e.g. bcrt1…).' });
      return;
    }
    const raw = parseInt(faucetAmountSats, 10);
    const amountSats = Math.max(1, Math.min(1_000_000, Number.isFinite(raw) ? raw : 10_000));
    setFaucetLoading(true);
    setFaucetMsg(null);
    try {
      const r = await requestHubRegtestFaucet(base, { address, amountSats });
      if (!r.ok) {
        setFaucetMsg({ type: 'err', text: r.error });
      } else {
        setFaucetMsg({
          type: 'ok',
          text: `Hub accepted faucet send of ${r.faucet.amountSats.toLocaleString()} sats.`,
          txid: r.faucet.txid
        });
        void refreshWalletBalance();
      }
    } catch (err: unknown) {
      setFaucetMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setFaucetLoading(false);
    }
  }, [getActiveFabricBase, faucetAddr, faucetAmountSats, refreshWalletBalance]);

  const deriveCurrentReceiveAddr = useCallback(() => {
    const cur = identities.find(id => id.isCurrent);
    if (!cur?.xpub) { setReceiveAddr(null); return; }
    const net = btcStatus?.network || 'regtest';
    const addr = deriveReceiveAddress(cur.xpub, net, receiveAddrIdx);
    setReceiveAddr(addr);
  }, [identities, btcStatus, receiveAddrIdx]);

  const refreshArcNotifications = useCallback(async () => {
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      setArcNotifications([]);
      return;
    }
    setArcNotificationsBusy(true);
    try {
      const res = await new Promise<{
        ok?: boolean;
        items?: Array<{
          key: string;
          messageType: string;
          label: string;
          arc: boolean;
          summary: string;
          receivedAt: number | null;
          payload?: Record<string, unknown> | null;
          nodeAddress?: string | null;
        }>;
      }>((resolve) => {
        chrome.runtime.sendMessage({ type: 'FABRIC_LIST_ARC_NOTIFICATIONS', limit: 20 }, (r) => {
          if (chrome.runtime.lastError) resolve({ ok: false, items: [] });
          else resolve(r || { ok: false, items: [] });
        });
      });
      const items = (res.items || []).filter((i) => i.arc === true);
      setArcNotifications(items.slice(0, 12));
    } catch (err: unknown) {
      swallowNonFatal('passport-arc-notifications', err);
      setArcNotifications([]);
    } finally {
      setArcNotificationsBusy(false);
    }
  }, []);

  useEffect(() => {
    if ((state === 'logged_in' || state === 'wallet' || state === 'peers') && identities.some(id => id.isCurrent)) {
      if (state === 'logged_in' || state === 'wallet') {
        refreshWalletBalance();
      }
      void refreshArcNotifications();
    }
  }, [state, refreshArcNotifications]);

  const currentIdentityId = identities.find(i => i.isCurrent)?.id ?? null;
  useEffect(() => {
    setWalletTxs([]);
  }, [currentIdentityId]);

  useEffect(() => {
    if (walletView === 'receive') deriveCurrentReceiveAddr();
  }, [receiveAddrIdx, deriveCurrentReceiveAddr, walletView]);

  const handleNodeSignin = async () => {
    const activeNode = settings.fabricNodes.find(n => n.isActive);
    if (!activeNode) {
      setNodeSigninResult({ ok: false, error: 'No active Fabric node configured. Open Settings → Fabric Nodes and activate one.' });
      return;
    }
    setNodeSigninBusy(true);
    setNodeSigninResult(null);
    try {
      const base = activeNode.hubAddress.replace(/\/+$/, '');
      const res = await fetch(`${base}/services/rpc`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'GetNetworkStatus', params: [] })
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(body.error.message || 'RPC error');
      const r = body.result;
      const currentIdentity = identities.find(id => id.isCurrent);
      setNodeSigninResult({
        ok: true,
        fabricPeerId: r?.fabricPeerId || null,
        clock: r?.clock ?? null,
        nodeAddress: base,
        error: undefined
      });
      try {
        const trustedOrigin = new URL(`${base}/`).origin;
        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
          void chrome.runtime.sendMessage({ type: 'FABRIC_TRUSTED_NODE_ORIGIN', origin: trustedOrigin });
        }
      } catch (err: unknown) {
        swallowNonFatal('identity-trusted-origin-message', err);
      }
      if (currentIdentity && currentIdentity.publicKeyHex) {
        await fetch(`${base}/services/rpc`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: Date.now(),
            method: 'RegisterWebRTCPeer',
            params: [{ peerId: `passport-${currentIdentity.id.slice(0, 12)}`, metadata: { fabricPeerId: currentIdentity.publicKeyHex, xpub: currentIdentity.xpub, source: 'passport' } }]
          })
        }).catch(() => {});
      }
    } catch (e) {
      setNodeSigninResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setNodeSigninBusy(false);
    }
  };

  const handleAddNode = () => {
    if (!newNodeConnection.trim()) return;

    const newNode: BitcoinNode = {
      id: passportNodeListId(newNodeConnection.trim()),
      connectionString: newNodeConnection.trim(),
      isActive: false
    };

    setSettings(prev => ({
      ...prev,
      bitcoinNodes: [...prev.bitcoinNodes, newNode]
    }));

    setNewNodeConnection('');
  };

  const handleRemoveNode = (id: string) => {
    setSettings(prev => ({
      ...prev,
      bitcoinNodes: prev.bitcoinNodes.filter(node => node.id !== id)
    }));
  };

  const handleToggleNode = (id: string) => {
    setSettings(prev => ({
      ...prev,
      bitcoinNodes: prev.bitcoinNodes.map(node => ({
        ...node,
        isActive: node.id === id ? !node.isActive : node.isActive
      }))
    }));
  };

  const handleTestNode = async (node: BitcoinNode) => {
    setTestingNode(node);
    setTestResult(null);
    setTestError(null);
    setIsTestModalOpen(true);

    try {
      const headers = buildBitcoinRpcHeaders(node.connectionString);
      const postUrl = getBitcoinRpcPostUrl(node.connectionString);

      const response = await fetch(postUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'test',
          method: 'getblockchaininfo',
          params: []
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      if (data.error) {
        throw new Error(data.error.message || 'RPC Error');
      }

      setTestResult(data.result);
    } catch (error) {
      setTestError(error instanceof Error ? error.message : 'Unknown error occurred');
    }
  };

  const handleAddFabricNode = () => {
    if (!newFabricHubAddress.trim()) return;
    const hubAddress = newFabricHubAddress.trim();
    const newNode: FabricNode = {
      id: passportNodeListId(`fabric:${hubAddress}`),
      hubAddress,
      isActive: false
    };
    setSettings(prev => ({
      ...prev,
      fabricNodes: [...prev.fabricNodes, newNode]
    }));
    setNewFabricHubAddress('');
  };

  const handleRemoveFabricNode = (id: string) => {
    setSettings(prev => ({
      ...prev,
      fabricNodes: prev.fabricNodes.filter(node => node.id !== id)
    }));
  };

  const handleToggleFabricNode = (id: string) => {
    setSettings(prev => ({
      ...prev,
      fabricNodes: prev.fabricNodes.map(node => ({
        ...node,
        isActive: node.id === id ? !node.isActive : node.isActive
      }))
    }));
  };

  const handleTestFabricNode = async (node: FabricNode) => {
    setTestingFabricNode(node);
    setFabricTestOk(null);
    setFabricTestError(null);
    setIsFabricTestModalOpen(true);
    try {
      const ok = await testFabricSignalingReachable(node.hubAddress, '/');
      setFabricTestOk(ok);
    } catch (error) {
      setFabricTestError(error instanceof Error ? error.message : 'Unknown error occurred');
    }
  };

  return (
    <div style={{
      width: '100%',
      minWidth: '400px',
      height: '100%'
    }}>
      <div style={{
        backgroundColor: '#1b1c1d',
        padding: '1em',
        minWidth: '400px',
        height: '100%'
      }}>
        {renderView()}
        <div style={{
          marginTop: '1em',
          paddingBottom: '1em',
          width: '100%'
        }}>
          {false && renderDebugInfo()}
          {state === 'logged_in' && (
            <Button.Group vertical fluid>
              <Button
                inverted
                color='grey'
                content='Settings'
                onClick={() => setState('settings')}
              />
              <Button
                inverted
                color='grey'
                content='Logout'
                onClick={() => openEraseConfirm('logout')}
                loading={isLoggingOut}
                disabled={isLoggingOut}
              />
            </Button.Group>
          )}
        </div>
      </div>

      <Modal
        open={showLogoutConfirm}
        onClose={handleCancelLogout}
        size='small'
      >
        <Modal.Header>
          {eraseConfirmMode === 'erase_all' ? 'Erase all extension data?' : 'Log out?'}
        </Modal.Header>
        <Modal.Content>
          <Message warning>
            <Message.Header>Important</Message.Header>
            {eraseConfirmMode === 'erase_all' ? (
              <>
                <p>This removes all identities, encrypted signing material, and stored settings (including Bitcoin and Fabric nodes) from this device.</p>
                <p><strong>Export a wallet backup first</strong> if you need to restore later.</p>
              </>
            ) : (
              <>
                <p>Logging out removes all identities from this device.</p>
                <p><strong>You will need your seed phrase and password to restore your identities.</strong></p>
                <p>If you have not securely backed up your seed phrase and password, you may permanently lose access to your funds.</p>
              </>
            )}
          </Message>
          <p>{eraseConfirmMode === 'erase_all' ? 'Erase everything on this device?' : 'Are you sure you want to log out?'}</p>
        </Modal.Content>
        <Modal.Actions>
          <Button onClick={handleCancelLogout}>
            Cancel
          </Button>
          <Button
            negative
            onClick={handleLogout}
            loading={isLoggingOut}
            disabled={isLoggingOut}
          >
            {eraseConfirmMode === 'erase_all' ? 'Erase everything' : 'Log out'}
          </Button>
        </Modal.Actions>
      </Modal>

      {editingIdentity && (
        <Modal open={true} onClose={() => setEditingIdentity(null)}>
          <Modal.Header>Edit Identity Name</Modal.Header>
          <Modal.Content>
            <Form>
              <Form.Field>
                <label>Identity Name</label>
                <Input
                  value={newIdentityName}
                  onChange={(e) => setNewIdentityName(e.target.value)}
                  placeholder="Enter a name for this identity"
                />
              </Form.Field>
            </Form>
          </Modal.Content>
          <Modal.Actions>
            <Button onClick={() => setEditingIdentity(null)}>Cancel</Button>
            <Button primary onClick={handleSaveIdentityName}>Save</Button>
          </Modal.Actions>
        </Modal>
      )}

      <SiteLoginPrompt
        privateKeyHex={selectedIdentity?.privateKeyHex || null}
        xpub={selectedIdentity?.xpub || null}
        needsUnlock={
          !!selectedIdentity?.hasPrivateKey &&
          !selectedIdentity?.privateKeyHex &&
          !!selectedIdentity?.id &&
          !!walletCryptos[selectedIdentity.id]
        }
      />
      <DeviceLinkPrompt
        privateKeyHex={selectedIdentity?.privateKeyHex || null}
        xpub={selectedIdentity?.xpub || null}
        needsUnlock={
          !!selectedIdentity?.hasPrivateKey &&
          !selectedIdentity?.privateKeyHex &&
          !!selectedIdentity?.id &&
          !!walletCryptos[selectedIdentity.id]
        }
      />
    </div>
  );
};

export default IdentityManager;
