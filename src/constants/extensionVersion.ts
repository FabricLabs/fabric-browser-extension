/** Injected by webpack from package.json at build time. */
declare const __PASSPORT_EXTENSION_VERSION__: string | undefined;

export const PASSPORT_EXTENSION_VERSION: string =
  typeof __PASSPORT_EXTENSION_VERSION__ !== 'undefined' && __PASSPORT_EXTENSION_VERSION__
    ? __PASSPORT_EXTENSION_VERSION__
    : '0.0.0';
