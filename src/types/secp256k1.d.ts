declare module '@bitcoinerlab/secp256k1' {
  export const ecc: {
    signSchnorr: (msg: Buffer | Uint8Array, d: Buffer | Uint8Array, auxRand?: Buffer | Uint8Array) => Buffer | null;
    verifySchnorr: (msg: Buffer | Uint8Array, pubkey: Buffer | Uint8Array, sig: Buffer | Uint8Array) => boolean;
  };
} 