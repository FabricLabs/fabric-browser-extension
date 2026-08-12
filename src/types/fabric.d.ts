declare module '@fabric/core/constants' {
  export const FABRIC_KEY_DERIVATION_PATH: string;
  export const MAGIC_BYTES: number;
  export const HEADER_SIZE: number;
  export const GENERIC_MESSAGE_TYPE: number;
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
    /** Opaque elliptic curve key material from Fabric core; not used by this extension. */
    keypair: unknown;
  }
}

declare module '@fabric/core/types/message' {
  export class Message {
    type: string;
    body: string;
    raw: { data?: Buffer };
    static fromBuffer (buf: Buffer): Message;
    static fromVector (vector: [string, string | Buffer]): Message;
    signWithKey (key: unknown): Message;
    toBuffer (): Buffer;
  }
  export default Message;
}
