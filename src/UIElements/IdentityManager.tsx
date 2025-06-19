'use strict';

import {
  INVALID_BECH32_TEST_VECTORS,
  INVALID_BIP32_TEST_VECTORS,
  VALID_BECH32_TEST_VECTORS,
  VALID_BIP32_TEST_VECTORS
} from '../crypto/vectors';

// Dependencies
import React, { useState, useEffect, useMemo } from 'react';
import { wordlists, mnemonicToSeedSync, generateMnemonic } from 'bip39';
import { ec as EC } from 'elliptic';
import { bech32m } from 'bech32';
import { BIP32Factory, TinySecp256k1Interface } from 'bip32';
import ecc from '@bitcoinerlab/secp256k1';
import crypto from 'crypto';

// Semantic UI
import { Button, Message, Loader, Segment, Form, Input, List, Icon, Modal, Popup, Table } from 'semantic-ui-react';

// Services
import { validateXpub } from '../utils/xpub';

// Create the elliptic curve instance
const ec = new EC('secp256k1');
const bip32 = BIP32Factory(ecc as unknown as TinySecp256k1Interface);

// Utility function to truncate string in the middle
const truncateMiddle = (str: string | undefined, frontLen: number = 5, backLen: number = 5): string => {
  if (!str) return '';
  if (str.length <= frontLen + backLen) return str;
  return `${str.slice(0, frontLen)}...${str.slice(-backLen)}`;
};

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
    } catch (error: any) {
      console.error(`Valid test vector failed: ${vector}`);
      console.error(`Error: ${error?.message || 'Unknown error'}`);
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
    } catch (error: any) {
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
        } catch (error: any) {
          console.error(`Failed to derive path ${chain.path}:`, error?.message || 'Unknown error');
          return false;
        }
      }
    } catch (error: any) {
      console.error(`Failed to process seed ${vector.seed}:`, error?.message || 'Unknown error');
      return false;
    }
  }

  // Test invalid vectors
  for (const vector of INVALID_BIP32_TEST_VECTORS) {
    try {
      bip32.fromBase58(vector);
      console.error(`Invalid test vector passed: ${vector}`);
      return false;
    } catch (error: any) {
      console.log(`✓ Invalid vector rejected as expected: ${vector}`);
    }
  }

  console.log('All BIP32 tests passed!');
  return true;
};

type KeyGenerationState = 'initial' | 'warning' | 'generating' | 'complete' | 'xpub_login' | 'xprv_login' | 'logged_in' | 'password_entry' | 'add_identity' | 'confirmation' | 'no_password_warning' | 'settings' | 'derivation_password_warning' | 'seed_phrase_entry' | 'identity_detail' | 'login_selection' | 'seed_phrase_login' | 'sign_message' | 'restore_identity' | 'verify_message' | 'derivation_password_entry';
type XpubLoginState = 'input' | 'validating' | 'error';
type PasswordState = 'input' | 'verifying' | 'error';

interface Identity {
  id: string;
  bech32: string;
  xpub: string;
  publicKeyHex: string;
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

interface BitcoinNode {
  id: string;
  connectionString: string;
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

// Move DEFAULT_SETTINGS before state declarations
const DEFAULT_SETTINGS = {
  autoLockTimer: 15,
  derivationPath: "m/7777'/0'/0'",
  bitcoinNodes: [
    {
      id: 'playnet-regtest',
      connectionString: 'http://ahp7iuGhae8mooBahFaYieyaixei6too:naiRe9wo5vieFayohje5aegheenoh4ee@127.0.0.1:20444',
      isActive: true
    }
  ] as BitcoinNode[]
};

interface Settings {
  autoLockTimer: number;
  derivationPath: string;
  bitcoinNodes: BitcoinNode[];
}

interface StorageState {
  keys: KeyPairStorage[];
  identities: Identity[];
  blobs: any[];
  settings: Settings;
}

const STORAGE_KEY = 'fabric_state';

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

// Add createActorId function
const createActorId = (content: string): string => {
  const hash = crypto.createHash('sha256');
  hash.update(content);
  return `node${hash.digest('hex').slice(0, 16)}`;
};

// Add function to make RPC requests
const makeRPCRequest = async (method: string, params: any[]): Promise<any> => {
  const node = DEFAULT_SETTINGS.bitcoinNodes.find((n: BitcoinNode) => n.isActive);
  if (!node) throw new Error('No active Bitcoin node');

  const url = new URL(node.connectionString);
  const auth = `${url.username}:${url.password}`;
  const headers = {
    'Authorization': `Basic ${btoa(auth)}`,
    'Content-Type': 'application/json'
  };

  try {
    const response = await fetch(url.origin, {
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
const ensureWalletLoaded = async (): Promise<string> => {
  try {
    // Try to load the default wallet first
    try {
      await makeRPCRequest('loadwallet', ['default']);
      return 'default';
    } catch (error) {
      // If wallet doesn't exist, create it
      if (error instanceof Error && error.message.includes('not found')) {
        try {
          // Create a new descriptor wallet (default in newer versions)
          await makeRPCRequest('createwallet', [
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
            await makeRPCRequest('unloadwallet', ['default']);
            await makeRPCRequest('loadwallet', ['default']);
            return 'default';
          }
          throw createError;
        }
      }
      
      // If default wallet can't be loaded/created, try listing available wallets
      const wallets = await makeRPCRequest('listwallets', []);
      if (wallets && wallets.length > 0) {
        return wallets[0]; // Use the first available wallet
      }

      // If no wallets available, create a new one with timestamp
      const timestamp = new Date().getTime();
      const walletName = `wallet_${timestamp}`;
      await makeRPCRequest('createwallet', [
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
  masterKey: any;  // Using any for now since bip32.BIP32Interface isn't available
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
  const [debugInfo, setDebugInfo] = useState<any>(null);
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

  const [settings, setSettings] = useState<Settings>({
    autoLockTimer: DEFAULT_SETTINGS.autoLockTimer,
    derivationPath: DEFAULT_SETTINGS.derivationPath,
    bitcoinNodes: DEFAULT_SETTINGS.bitcoinNodes
  });

  // Create a memoized version of the wordlist
  const wordlist = useMemo(() => bip39Wordlist, []);

  // Add state for whether we should start editing on detail view
  const [startEditingOnDetail, setStartEditingOnDetail] = useState<boolean>(false);

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
      }
    };
    initializeStorage();
  }, []);

  useEffect(() => {
    const saveState = async () => {
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
          identities,
          blobs: [],
          settings: settings
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
  }, [identities, settings]);

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

      // Generate the master key
      const masterKey = bip32.fromSeed(seed);

      // Create a key pair using elliptic
      const keyPair = ec.genKeyPair();
      const privateKey = keyPair.getPrivate().toString('hex');
      const publicKey = keyPair.getPublic().encode('hex', true);  // Convert to compressed hex format

      // Get the x-coordinate of the public key point
      const pubKeyPoint = keyPair.getPublic();
      if (!pubKeyPoint || !pubKeyPoint.getX) {
        throw new Error('Invalid public key point');
      }

      // Convert x-coordinate to buffer, ensuring it's 32 bytes
      const xCoord = pubKeyPoint.getX().toArrayLike(Buffer, 'be', 32);
      if (xCoord.length !== 32) {
        throw new Error('Invalid x-coordinate length');
      }

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

        // Create a new identity with the previously generated key
        const newIdentity: Identity = {
          id: generatedValues.bech32mEncoded,
          xpub: generatedValues.publicKey,
          publicKeyHex: generatedValues.publicKey,  // Add this line
          bech32: generatedValues.bech32mEncoded,
          isCurrent: true,
          name: generatedValues.bech32mEncoded,
          loadedAt: new Date().toISOString(),
          hasPrivateKey: true  // We have the private key for newly generated identities
        };

        // Add the new identity and make it current
        setIdentities(prev => {
          const updated = prev.map(id => ({ ...id, isCurrent: false }));
          return [newIdentity, ...updated];
        });

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

      // Save empty state to storage
      const state: StorageState = {
        keys: [],
        identities: [],
        blobs: [],
        settings: DEFAULT_SETTINGS
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
    } catch (error) {
      console.error('Failed to logout:', error);
      // Even if storage fails, we should still clear the local state
      setIdentities([]);
      setState('initial');
    } finally {
      setIsLoggingOut(false);
    }
  };

  const handleLogoutClick = () => {
    setShowLogoutConfirm(true);
  };

  const handleCancelLogout = () => {
    setShowLogoutConfirm(false);
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

  const handleSignMessage = async () => {
    if (!selectedIdentity || !messageToSign.trim()) return;

    try {
      if (!selectedIdentity.hasPrivateKey) {
        throw new Error('Cannot sign messages with an xpub-based identity. Please use an identity with a private key.');
      }

      let signature: string;
      let pubkey: string;

      try {
        // First try Bitcoin RPC signing
        const walletName = await ensureWalletLoaded();
        console.log('Using wallet:', walletName);

        // Get a new address and ensure we have its private key
        const address = await makeRPCRequest('getnewaddress', ['message-signing', 'legacy']);

        // Import the private key if needed
        try {
          await makeRPCRequest('dumpprivkey', [address]);
        } catch (error) {
          console.error('Failed to access private key:', error);
          throw new Error('Could not access private key for signing. Please ensure the wallet is unlocked and has private keys enabled.');
        }

        // Sign the message using Bitcoin Core
        signature = await makeRPCRequest('signmessage', [address, messageToSign]);
        pubkey = address;

        setSignature(signature);
        setPubkeyToVerify(pubkey);
        setShowSignature(true);
      } catch (error) {
        console.log('Bitcoin RPC signing failed, falling back to local key:', error);
        // TODO: Fall back to local key signing
      }

      setVerificationResult(null);
    } catch (error: unknown) {
      console.error('Failed to sign message:', error);
      setSignature(null);
      setPubkeyToVerify('');
      setVerificationResult(error instanceof Error ? error.message : 'Failed to sign message');
    }
  };

  // Modify handleVerifyMessage to handle wallet errors
  const handleVerifyMessage = async () => {
    if (!messageToVerify.trim() || !signatureToVerify.trim() || !pubkeyToVerify.trim()) return;

    try {
      // Ensure a wallet is loaded (some nodes require this even for verification)
      await ensureWalletLoaded();

      // Verify the message using Bitcoin Core
      const isValid = await makeRPCRequest('verifymessage', [
        pubkeyToVerify,
        signatureToVerify,
        messageToVerify
      ]);

      setVerificationResult(isValid ? 'Signature is valid' : 'Signature is invalid');
    } catch (error) {
      console.error('Failed to verify message:', error);
      setVerificationResult('Verification failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    }
  };

  const handleSettingsChange = (key: keyof typeof settings, value: any) => {
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
          identities,
          settings
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
            const validKeyPairs = data.state.keys.every((key: any) => 
              typeof key.public === 'string' && 
              typeof key.private === 'string' &&
              /^[0-9a-f]+$/i.test(key.public) &&
              /^[0-9a-f]+$/i.test(key.private)
            );
            
            if (!validKeyPairs) {
              throw new Error('Invalid key pair format in backup');
            }
          }

          // Set the new state
          setIdentities(data.state.identities);
          setSettings(data.state.settings);

          // Save to storage
          const state: StorageState = {
            keys: data.state.keys || [],
            identities: data.state.identities,
            blobs: [],
            settings: data.state.settings
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

  const renderSignMessageState = () => (
    <Message className="fade-in">
      <Message.Header>Sign Message</Message.Header>
      <Message.Content>
        <Form>
          <Form.Field>
            <label>Message to Sign</label>
            <Input
              type="text"
              placeholder="Enter message to sign"
              value={messageToSign}
              onChange={(e) => setMessageToSign(e.target.value)}
            />
            {!messageToSign.trim() && (
              <Message size="tiny" color="yellow">
                Please enter a message to sign
              </Message>
            )}
          </Form.Field>
          {signature && showSignature && (
            <>
              <Form.Field>
                <label>Public Key (hex)</label>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  <span>{pubkeyToVerify}</span>
                  <Icon
                    name="copy"
                    link
                    onClick={() => {
                      navigator.clipboard.writeText(pubkeyToVerify);
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </Form.Field>
              <Form.Field>
                <label>Signature</label>
                <div style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  gap: '0.5em',
                  fontFamily: 'monospace',
                  wordBreak: 'break-all'
                }}>
                  <span>{signature}</span>
                  <Icon
                    name="copy"
                    link
                    onClick={() => {
                      navigator.clipboard.writeText(signature);
                    }}
                    style={{ cursor: 'pointer' }}
                  />
                </div>
              </Form.Field>
            </>
          )}
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              content='Sign Message'
              onClick={handleSignMessage}
              disabled={!messageToSign.trim()}
            />
            <Button
              content='Go Back'
              onClick={() => {
                setMessageToSign('');
                setSignature(null);
                setPubkeyToVerify('');
                setState('logged_in');
              }}
            />
          </Button.Group>
        </Form>
      </Message.Content>
    </Message>
  );

  const renderVerifyMessageState = () => (
    <Message className="fade-in">
      <Message.Header>Verify Message Signature</Message.Header>
      <Message.Content>
        <Form>
          <Form.Field>
            <label>Message</label>
            <Input
              type="text"
              placeholder="Enter the message to verify"
              value={messageToVerify}
              onChange={(e) => setMessageToVerify(e.target.value)}
            />
          </Form.Field>
          <Form.Field>
            <label>Public Key (hex)</label>
            <Input
              type="text"
              placeholder="Enter the public key"
              value={pubkeyToVerify}
              onChange={(e) => setPubkeyToVerify(e.target.value)}
            />
          </Form.Field>
          <Form.Field>
            <label>Signature</label>
            <Input
              type="text"
              placeholder="Enter the signature"
              value={signatureToVerify}
              onChange={(e) => setSignatureToVerify(e.target.value)}
            />
          </Form.Field>
          {verificationResult && (
            <Message
              positive={verificationResult.includes('valid')}
              negative={!verificationResult.includes('valid')}
            >
              <Message.Header>Verification Result</Message.Header>
              <p>{verificationResult}</p>
            </Message>
          )}
          <Button.Group vertical fluid style={{ marginTop: '1em' }}>
            <Button
              primary
              content='Verify Signature'
              onClick={handleVerifyMessage}
              disabled={!messageToVerify.trim() || !signatureToVerify.trim() || !pubkeyToVerify.trim()}
            />
            <Button
              content='Go Back'
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

                  // Derive the xpub at the default path (m/44'/0'/0')
                  const derivedKey = masterKey.derivePath("m/44'/0'/0'");
                  const xpub = `${derivedKey.neutered().toBase58()}`;

                  // Get the x-coordinate of the public key point
                  const pubKeyPoint = derivedKey.publicKey;
                  if (!pubKeyPoint || pubKeyPoint.length !== 33) {
                    throw new Error('Invalid public key');
                  }
                  const publicKeyHex = Buffer.from(pubKeyPoint).toString('hex');  // Convert to hex string

                  // Use the x-coordinate (remove the prefix byte)
                  const xCoord = pubKeyPoint.slice(1, 33);

                  // Encode with bech32m
                  const words = bech32m.toWords(xCoord);
                  const bech32mEncoded = bech32m.encode('id', words);

                  // Create a new identity
                  const newIdentity: Identity = {
                    id: bech32mEncoded,
                    xpub,
                    publicKeyHex,
                    bech32: bech32mEncoded,
                    isCurrent: true,
                    name: bech32mEncoded,
                    loadedAt: new Date().toISOString(),
                    hasPrivateKey: true
                  };

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });

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

  const renderLoggedInState = () => (
    <div className="fade-in" style={{ width: '100%' }}>
      {identities.find(id => id.isCurrent) && (
        <Segment
          style={{ 
            cursor: 'pointer',
            position: 'relative'
          }}
          onClick={() => {
            setStartEditingOnDetail(false);
            handleIdentityClick(identities.find(id => id.isCurrent)!);
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
                {truncateMiddle(identities.find(id => id.isCurrent)?.name || 'Unnamed Identity')}
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
                    const currentIdentity = identities.find(id => id.isCurrent)!;
                    setStartEditingOnDetail(true);
                    setSelectedIdentity(currentIdentity);
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
            <span>{identities.find(id => id.isCurrent)?.balance || '0.00'} BTC</span>
          </div>
          <p style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.8em' }}>
            {truncateMiddle(identities.find(id => id.isCurrent)?.id || '')}
          </p>
        </Segment>
      )}

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
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '0.5em',
                    fontFamily: 'monospace',
                    fontSize: '0.9em',
                    fontWeight: 'bold',
                    marginTop: '0.25em'
                  }}>
                    <span>{identity.balance || '0.00'} BTC</span>
                  </div>
                  <List.Description style={{ wordBreak: 'break-all', fontFamily: 'monospace', fontSize: '0.7em' }}>
                    {truncateMiddle(identity.id)}
                  </List.Description>
                  <small style={{ color: '#666', marginTop: '0.25em' }}>
                    <abbr title={identity.loadedAt}>
                      Loaded {timeAgo(identity.loadedAt)}
                    </abbr>
                  </small>
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
              setState('sign_message');
            }
          }}
        />
        <Button
          primary
          content='Verify Message'
          onClick={() => setState('verify_message')}
        />
      </Button.Group>
    </div>
  );

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
              onClick={() => setState('xpub_login')}
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
        <p>Select how you would like to login:</p>
        <Button.Group vertical fluid style={{ marginTop: '1em' }}>
          <Button
            color='green'
            content='Use Seed Phrase'
            onClick={() => setState('seed_phrase_login')}
          />
          <Button
            primary
            content='Use Extended Private Key (xprv)'
            onClick={() => setState('xprv_login')}
            disabled={true}
          />
          <Button
            primary
            content='Use Extended Public Key (xpub)'
            onClick={() => setState('xpub_login')}
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
        <p>Enter your seed phrase and derivation password to login.</p>
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
                  
                  // Derive the xpub at the default path (m/44'/0'/0')
                  const derivedKey = masterKey.derivePath("m/44'/0'/0'");
                  const xpub = `${derivedKey.neutered().toBase58()}`;

                  // Get the x-coordinate of the public key point
                  const pubKeyPoint = derivedKey.publicKey;
                  if (!pubKeyPoint || pubKeyPoint.length !== 33) {
                    throw new Error('Invalid public key');
                  }
                  const publicKeyHex = Buffer.from(pubKeyPoint).toString('hex');  // Convert to hex string

                  // Use the x-coordinate (remove the prefix byte)
                  const xCoord = pubKeyPoint.slice(1, 33);

                  // Encode with bech32m
                  const words = bech32m.toWords(xCoord);
                  const bech32mEncoded = bech32m.encode('id', words);

                  // Create a new identity
                  const newIdentity: Identity = {
                    id: bech32mEncoded,
                    xpub,
                    publicKeyHex,
                    bech32: bech32mEncoded,
                    isCurrent: true,
                    name: bech32mEncoded,
                    loadedAt: new Date().toISOString(),
                    hasPrivateKey: true
                  };

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });

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

                  // Derive the xpub at the default path (m/44'/0'/0')
                  const derivedKey = masterKey.derivePath("m/44'/0'/0'");
                  const xpub = `${derivedKey.neutered().toBase58()}`;

                  // Get the x-coordinate of the public key point
                  const pubKeyPoint = derivedKey.publicKey;
                  if (!pubKeyPoint || pubKeyPoint.length !== 33) {
                    throw new Error('Invalid public key');
                  }
                  const publicKeyHex = Buffer.from(pubKeyPoint).toString('hex');  // Convert to hex string

                  // Use the x-coordinate (remove the prefix byte)
                  const xCoord = pubKeyPoint.slice(1, 33);

                  // Encode with bech32m
                  const words = bech32m.toWords(xCoord);
                  const bech32mEncoded = bech32m.encode('id', words);

                  // Create a new identity
                  const newIdentity: Identity = {
                    id: bech32mEncoded,
                    xpub,
                    publicKeyHex,
                    bech32: bech32mEncoded,
                    isCurrent: true,
                    name: bech32mEncoded,
                    loadedAt: new Date().toISOString(),
                    hasPrivateKey: true
                  };

                  // Add the new identity and make it current
                  setIdentities(prev => {
                    const updated = prev.map(id => ({ ...id, isCurrent: false }));
                    return [newIdentity, ...updated];
                  });

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
                  />
                  <Button
                    icon='trash'
                    color='red'
                    onClick={() => handleRemoveNode(node.id)}
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
              <label>Connection String</label>
              <Input
                placeholder="http://username:password@host:port"
                value={newNodeConnection}
                onChange={(e) => setNewNodeConnection(e.target.value)}
              />
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
                    <label>Lock wallet after inactivity (minutes):</label>
                    <Input
                      type="number"
                      min="1"
                      max="60"
                      value={settings.autoLockTimer}
                      onChange={(e) => handleSettingsChange('autoLockTimer', parseInt(e.target.value) || DEFAULT_SETTINGS.autoLockTimer)}
                      fluid
                    />
                  </Form.Field>
                </List.Description>
              </List.Content>
            </List.Item>
            <List.Item>
              <List.Content>
                <List.Header>Default Derivation Path</List.Header>
                <List.Description>
                  <Form.Field>
                    <label>BIP32 derivation path:</label>
                    <Input
                      value={settings.derivationPath}
                      onChange={(e) => handleSettingsChange('derivationPath', e.target.value)}
                      placeholder="m/44'/0'/0'"
                      fluid
                      disabled
                    />
                  </Form.Field>
                </List.Description>
              </List.Content>
            </List.Item>
          </List>

          <h4 style={{ marginTop: '2em' }}>Bitcoin Nodes</h4>
          {renderNodeList()}
          {renderTestNodeModal()}

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
                    onClick={handleLogoutClick}
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
                <List.Description>0.0.1</List.Description>
              </List.Content>
            </List.Item>
          </List>
        </Segment>

        <Button.Group vertical fluid style={{ marginTop: '2em' }}>
          <Button
            color='black'
            content='Back to Dashboard'
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

  const handleAddNode = () => {
    if (!newNodeConnection.trim()) return;

    const newNode: BitcoinNode = {
      id: createActorId(newNodeConnection.trim()),
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
      // Parse connection string to get components
      const url = new URL(node.connectionString);
      const auth = `${url.username}:${url.password}`;
      const headers = {
        'Authorization': `Basic ${btoa(auth)}`,
        'Content-Type': 'application/json'
      };

      // Make RPC request
      const response = await fetch(url.origin, {
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
                color='black'
                content='Settings'
                onClick={() => setState('settings')}
              />
              <Button
                color='black'
                content='Logout'
                onClick={handleLogoutClick}
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
        <Modal.Header>Confirm Logout</Modal.Header>
        <Modal.Content>
          <Message warning>
            <Message.Header>Important Warning</Message.Header>
            <p>Logging out will remove all identities from this device.</p>
            <p><strong>You will need your seed phrase and password to restore your identities.</strong></p>
            <p>If you have not securely backed up your seed phrase and password, you may permanently lose access to your funds.</p>
          </Message>
          <p>Are you sure you want to proceed with logout?</p>
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
            Yes, Logout
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
    </div>
  );
};

export default IdentityManager;
