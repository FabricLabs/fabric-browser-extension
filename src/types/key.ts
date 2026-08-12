'use strict';

import { IIdentity } from './identity';
import { ec as EC } from 'elliptic';
import type { EllipticSecp256k1KeyPair } from 'elliptic';
import { BIP32Factory, TinySecp256k1Interface } from 'bip32';
import ecc from '@bitcoinerlab/secp256k1';
import { mnemonicToSeedSync } from 'bip39';
import { Buffer } from 'buffer';

const ec = new EC('secp256k1');
const bip32 = BIP32Factory(ecc as unknown as TinySecp256k1Interface);

export class Key {
  private keypair: EllipticSecp256k1KeyPair | null = null;
  private xpub: string | null = null;
  private xprv: string | null = null;
  private publicKey: string | null = null;
  private privateKey: string | null = null;

  constructor(settings: { xpub?: string; xprv?: string; seed?: string; passphrase?: string } = {}) {
    if (settings.xpub) {
      const node = bip32.fromBase58(settings.xpub);
      this.keypair = ec.keyFromPublic(node.publicKey);
      this.xpub = settings.xpub;
      this.publicKey = this.keypair.getPublic(true, 'hex');
    } else if (settings.xprv) {
      const node = bip32.fromBase58(settings.xprv);
      this.keypair = ec.keyFromPrivate(Buffer.from(node.privateKey!));
      this.xprv = settings.xprv;
      this.xpub = node.neutered().toBase58();
      this.publicKey = this.keypair.getPublic(true, 'hex');
      this.privateKey = this.keypair.getPrivate('hex');
    } else if (settings.seed) {
      const seed = mnemonicToSeedSync(settings.seed, settings.passphrase);
      const node = bip32.fromSeed(Buffer.from(seed));
      this.keypair = ec.keyFromPrivate(Buffer.from(node.privateKey!));
      this.xprv = node.toBase58();
      this.xpub = node.neutered().toBase58();
      this.publicKey = this.keypair.getPublic(true, 'hex');
      this.privateKey = this.keypair.getPrivate('hex');
    }
  }

  get pubkey(): string {
    return this.publicKey || '';
  }

  toBech32(): string {
    if (!this.publicKey) return '';
    // TODO: Implement proper bech32 encoding
    return `id${this.publicKey.slice(0, 8)}`;
  }
}

export interface IKey {
  privateKey: string,
  privateExtendedKey: string,
  identity: Array<IIdentity>,
  selectedIdentityId: number,
  selectedChainId: number
}
