declare module 'elliptic' {
  export class EC {
    constructor(curve: string);
    keyFromPrivate(priv: Buffer): any;
    keyFromPublic(pub: Buffer): any;
  }
} 