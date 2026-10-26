'use strict';

/**
 * Browser `buffer` (feross/buffer 6) with Node's `base64url` encoding added.
 * `@fabric/core` writes and reads `fabric:` frames as base64url; without it
 * signing throws "Unknown encoding: base64url" in the extension.
 */

// Not `buffer` or `buffer/`: webpack aliases both back to this file.
const buffer = require('buffer/index.js');
const { Buffer } = buffer;

function isBase64Url (encoding) {
  return typeof encoding === 'string' && encoding.toLowerCase() === 'base64url';
}

function toBase64 (text) {
  return String(text).replace(/-/g, '+').replace(/_/g, '/');
}

if (!Buffer.isEncoding('base64url')) {
  const from = Buffer.from;
  const isEncoding = Buffer.isEncoding;
  const byteLength = Buffer.byteLength;
  const toString = Buffer.prototype.toString;

  Buffer.from = function (value, encodingOrOffset, length) {
    if (typeof value === 'string' && isBase64Url(encodingOrOffset)) return from.call(Buffer, toBase64(value), 'base64');
    return from.call(Buffer, value, encodingOrOffset, length);
  };

  Buffer.isEncoding = function (encoding) {
    return isBase64Url(encoding) || isEncoding.call(Buffer, encoding);
  };

  Buffer.byteLength = function (string, encoding) {
    if (typeof string === 'string' && isBase64Url(encoding)) return byteLength.call(Buffer, toBase64(string), 'base64');
    return byteLength.call(Buffer, string, encoding);
  };

  Buffer.prototype.toString = function (encoding, start, end) {
    if (!isBase64Url(encoding)) return toString.apply(this, arguments);
    return toString.call(this, 'base64', start, end).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
}

module.exports = buffer;
