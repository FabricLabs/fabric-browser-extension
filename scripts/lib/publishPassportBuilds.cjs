'use strict';

/**
 * Discover Fabric Passport build artifacts and publish them to a Hub
 * Documents catalog (playnet) via CreateDocument + PublishDocument.
 *
 * Static Hub `/downloads/extension/` sync lives in the sibling hub.fabric.pub
 * tree (`syncPassportExtensionDownloads`); this helper only talks JSON-RPC.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_HUB = 'http://127.0.0.1:8080';
const PRODUCTION_HUB = 'https://hub.fabric.pub';
const ZIP_NAME_RE = /^fabric-passport-v.+\.zip$/i;

/**
 * @param {string} [name]
 * @returns {string}
 */
function mimeForFilename (name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.zip') return 'application/zip';
  return 'application/octet-stream';
}

/**
 * @param {string} repoRoot
 * @param {Object} [opts]
 * @param {boolean} [opts.zip=true]
 * @returns {Array<{ kind: string, path: string, name: string, mime: string, size: number }>}
 */
function listBuildArtifacts (repoRoot, opts = {}) {
  const root = path.resolve(repoRoot);
  const out = [];
  const seen = new Set();

  function add (kind, abs, name) {
    const resolved = path.resolve(abs);
    if (seen.has(resolved)) return;
    let st;
    try {
      st = fs.statSync(resolved);
    } catch (_) {
      return;
    }
    if (!st.isFile()) return;
    seen.add(resolved);
    out.push({
      kind,
      path: resolved,
      name: name || path.basename(resolved),
      mime: mimeForFilename(name || resolved),
      size: st.size
    });
  }

  if (opts.zip !== false) {
    const zipDir = path.join(root, 'zip');
    if (fs.existsSync(zipDir)) {
      const names = fs.readdirSync(zipDir).filter((n) => ZIP_NAME_RE.test(n)).sort();
      for (const name of names) {
        add('zip', path.join(zipDir, name), name);
      }
    }
  }

  return out;
}

/**
 * Prefer the newest matching zip (mtime), else highest semver-ish name.
 * @param {Array<{ path: string, name: string }>} artifacts
 * @returns {object|null}
 */
function pickPrimaryZip (artifacts) {
  const zips = (artifacts || []).filter((a) => a && a.kind === 'zip');
  if (!zips.length) return null;
  zips.sort((a, b) => {
    let ma = 0;
    let mb = 0;
    try { ma = fs.statSync(a.path).mtimeMs; } catch (_) {}
    try { mb = fs.statSync(b.path).mtimeMs; } catch (_) {}
    if (mb !== ma) return mb - ma;
    return String(b.name).localeCompare(String(a.name));
  });
  return zips[0];
}

function hubBase (opts = {}) {
  if (opts.host) return String(opts.host).replace(/\/+$/, '') || DEFAULT_HUB;
  if (opts.production || process.env.FABRIC_PLAYNET_PRODUCTION === '1') {
    return String(process.env.FABRIC_HUB_RPC_URL || process.env.FABRIC_HUB_URL || PRODUCTION_HUB)
      .trim()
      .replace(/\/+$/, '') || PRODUCTION_HUB;
  }
  return String(process.env.FABRIC_HUB_RPC_URL || process.env.FABRIC_HUB_URL || DEFAULT_HUB)
    .trim()
    .replace(/\/+$/, '') || DEFAULT_HUB;
}

function loadAdminToken (opts = {}) {
  if (opts.adminToken) return String(opts.adminToken).trim();
  const fromEnv = String(process.env.FABRIC_HUB_ADMIN_TOKEN || process.env.FABRIC_ADMIN_TOKEN || '').trim();
  if (fromEnv) return fromEnv;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (!home) return '';
  try {
    return String(fs.readFileSync(path.join(home, '.fabric', 'hub-admin-token'), 'utf8') || '').trim();
  } catch (_) {
    return '';
  }
}

/**
 * @param {string} baseUrl
 * @param {string} method
 * @param {Array} [params]
 * @param {Object} [opts]
 * @returns {Promise<*>}
 */
function hubRpc (baseUrl, method, params, opts = {}) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const u = new URL(`${base}/services/rpc`);
  const lib = u.protocol === 'https:' ? https : http;
  const bodyObj = {
    jsonrpc: '2.0',
    id: opts.id != null ? opts.id : 1,
    method,
    params: Array.isArray(params) ? params : (params != null ? [params] : [])
  };
  const body = JSON.stringify(bodyObj);
  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Accept: 'application/json'
  };
  const token = opts.adminToken ? String(opts.adminToken).trim() : '';
  if (token) headers.Authorization = `Bearer ${token}`;
  const timeoutMs = Number(opts.timeoutMs || process.env.FABRIC_HUB_RPC_TIMEOUT_MS || 120000);

  return new Promise((resolve, reject) => {
    const req = lib.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (_) {
          reject(new Error(`RPC parse failed (${res.statusCode}): ${raw.slice(0, 400)}`));
          return;
        }
        if (parsed && parsed.error) {
          reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
          return;
        }
        resolve(parsed && parsed.result !== undefined ? parsed.result : parsed);
      });
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`RPC timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Create + publish one artifact on Hub Documents.
 * Uses `filePath` + adminToken for local ingest (small JSON-RPC body). Does **not**
 * fall back to multi-MiB contentBase64 — that hits Hub's body-parser limit (413).
 * @param {object} artifact
 * @param {Object} [opts]
 * @returns {Promise<object>}
 */
async function publishArtifact (artifact, opts = {}) {
  const host = hubBase(opts);
  const st = fs.statSync(artifact.path);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(artifact.path)).digest('hex');
  const adminToken = loadAdminToken(opts);
  const size = st.size;
  // Keep tiny fixtures on contentBase64; real Passport zips always use filePath.
  const BASE64_OK_MAX = 256 * 1024;
  const preferFilePath = opts.forceBase64 !== true && (!!adminToken || size > BASE64_OK_MAX);

  if (preferFilePath && !adminToken) {
    const err = new Error(
      'FABRIC_HUB_ADMIN_TOKEN (or ~/.fabric/hub-admin-token) required to publish files over ' +
      BASE64_OK_MAX + ' bytes via CreateDocument filePath ingest'
    );
    err.status = 401;
    throw err;
  }

  const createPayload = {
    name: artifact.name,
    mime: artifact.mime || mimeForFilename(artifact.name),
    size,
    sha256
  };
  let via = 'contentBase64';
  if (preferFilePath) {
    createPayload.filePath = artifact.path;
    createPayload.adminToken = adminToken;
    via = 'filePath';
  } else {
    createPayload.contentBase64 = fs.readFileSync(artifact.path).toString('base64');
  }

  let created;
  try {
    created = await hubRpc(host, 'CreateDocument', [createPayload], {
      adminToken,
      timeoutMs: opts.timeoutMs
    });
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    if (/413|too large|PayloadTooLarge/i.test(msg)) {
      throw new Error(
        'Hub rejected the JSON body (413). Restart Hub after linking @fabric/http ' +
        '(npm run link:fabric) so JSON limit is 12mb, or publish with admin token ' +
        'filePath ingest: ' + msg
      );
    }
    throw e;
  }

  if (created && created.status === 'error') {
    const msg = String(created.message || 'CreateDocument failed');
    if (via === 'filePath' && /contentBase64 required/i.test(msg)) {
      throw new Error(
        'Hub does not support CreateDocument filePath yet — restart the Hub process ' +
        'to load services/hub.js with filePath ingest. (' + msg + ')'
      );
    }
    if (via === 'filePath' && /adminToken/i.test(msg)) {
      throw new Error(
        'CreateDocument filePath ingest rejected adminToken — check FABRIC_HUB_ADMIN_TOKEN ' +
        'matches this Hub. (' + msg + ')'
      );
    }
    const err = new Error(msg);
    err.response = created;
    throw err;
  }

  const doc = (created && created.document) || created;
  const id = doc && (doc.id || doc.sha256 || sha256);
  if (!id) {
    throw new Error('CreateDocument: missing document id');
  }

  const publishParams = { id };
  if (opts.purchasePriceSats != null && Number.isFinite(Number(opts.purchasePriceSats))) {
    publishParams.purchasePriceSats = Math.max(0, Math.floor(Number(opts.purchasePriceSats)));
  }

  const published = await hubRpc(host, 'PublishDocument', [publishParams], {
    adminToken,
    timeoutMs: opts.timeoutMs
  });

  if (published && published.status === 'error') {
    const err = new Error(published.message || 'PublishDocument failed');
    err.response = published;
    throw err;
  }

  return {
    id,
    sha256,
    name: artifact.name,
    mime: artifact.mime,
    size,
    host,
    via,
    document: (published && published.document) || doc
  };
}

module.exports = {
  DEFAULT_HUB,
  PRODUCTION_HUB,
  ZIP_NAME_RE,
  mimeForFilename,
  listBuildArtifacts,
  pickPrimaryZip,
  hubBase,
  loadAdminToken,
  hubRpc,
  publishArtifact
};
