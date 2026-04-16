declare module '@fabric/core/constants' {
  export const FABRIC_KEY_DERIVATION_PATH: string;
}

declare module '@fabric/core/types/key' {
  export class Key {
    static Mnemonic(seed?: Buffer): Key;
    seed: string;
    private: string;
    public: string;
    chainCode: string;
    depth: number;
    index: number;
    parentFingerprint: string;
    fingerprint: string;
    keypair: any;
  }
}
