declare module 'bn.js' {
  class BN {
    constructor(number: number | string | number[] | Buffer, base?: number | 'hex', endian?: 'le' | 'be');
    add(b: BN): BN;
    sub(b: BN): BN;
    mul(b: BN): BN;
    mod(b: BN): BN;
    shrn(bits: number): BN;
    toArray(endian?: 'le' | 'be', length?: number): number[];
    isOdd(): boolean;
    gt(b: BN): boolean;
    lt(b: BN): boolean;
  }
  export default BN;
}

declare module 'elliptic' {
  interface Point {
    x: BN;
    y: BN;
    encode(encoding: string, compressed: boolean): string;
    getX(): BN;
    getY(): BN;
    isInfinity(): boolean;
    add(p: Point): Point;
    mul(k: BN): Point;
    eq(p: Point): boolean;
  }

  interface Curve {
    pointFromX(x: BN, odd: boolean): Point;
    p: BN;
  }

  interface KeyPair {
    getPublic(): Point;
    getPrivate(): BN;
  }

  interface EC {
    new (curve: string): EC;
    curve: Curve;
    g: Point;
    n: BN;
    keyFromPrivate(priv: Buffer): KeyPair;
    validate(point: Point): boolean;
    genKeyPair(): KeyPair;
  }

  export const ec: EC;
}
