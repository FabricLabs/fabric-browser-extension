'use strict';

/**
 * Browser stub for @fabric/core/functions/fabricNativeAccel.
 * The real module uses require(addonPath) for fabric.node; webpack cannot parse that.
 * Native acceleration is Node-only; the extension always uses @noble/hashes.
 */

const { sha256 } = require('@noble/hashes/sha2.js');

const SUPPORTED_ADDON_EXPORTS = Object.freeze([
  'doubleSha256',
  'bech32Encode',
  'bech32Decode',
  'segwitAddrEncode',
  'segwitAddrDecode'
]);

function status () {
  return {
    available: false,
    methods: [],
    nativeDoubleSha256OptIn: false,
    nativeBech32OptIn: false,
    path: null,
    error: undefined
  };
}

function nativeBech32Enabled () {
  return false;
}

function isNativeBech32Callable () {
  return false;
}

function doubleSha256Buffer (buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('doubleSha256Buffer expects Buffer');
  const first = sha256(new Uint8Array(buf));
  const second = sha256(first);
  return Buffer.from(second);
}

function doubleSha256Hex (buf) {
  return doubleSha256Buffer(buf).toString('hex');
}

function bech32Encode () {
  return null;
}

function bech32Decode () {
  return null;
}

function segwitAddrEncode () {
  return null;
}

function segwitAddrDecode () {
  return null;
}

module.exports = {
  SUPPORTED_ADDON_EXPORTS,
  status,
  nativeBech32Enabled,
  isNativeBech32Callable,
  doubleSha256Buffer,
  doubleSha256Hex,
  bech32Encode,
  bech32Decode,
  segwitAddrEncode,
  segwitAddrDecode
};
