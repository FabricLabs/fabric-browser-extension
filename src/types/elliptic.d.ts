declare module 'elliptic' {
  /** Minimal surface used by `src/types/key.ts` (secp256k1). */
  export interface EllipticSecp256k1KeyPair {
    getPublic(compact: boolean, enc: 'hex'): string;
    getPrivate(enc: 'hex'): string;
  }

  export class EC {
    constructor(curve: string);
    keyFromPrivate(priv: Buffer): EllipticSecp256k1KeyPair;
    keyFromPublic(pub: Buffer): EllipticSecp256k1KeyPair;
  }
} 