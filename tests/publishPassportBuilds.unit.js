'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  mimeForFilename,
  listBuildArtifacts,
  pickPrimaryZip,
  hubBase,
  isLoopbackHub,
  loadAdminToken,
  DEFAULT_HUB,
  PRODUCTION_HUB,
  ZIP_NAME_RE
} = require('../scripts/lib/publishPassportBuilds.cjs');

describe('publishPassportBuilds', function () {
  it('maps zip mime and hub defaults', function () {
    assert.strictEqual(mimeForFilename('fabric-passport-v0.1.0.zip'), 'application/zip');
    assert.strictEqual(mimeForFilename('readme.txt'), 'application/octet-stream');
    assert.ok(ZIP_NAME_RE.test('fabric-passport-v0.1.0.zip'));
    assert.ok(!ZIP_NAME_RE.test('notes.zip'));
    assert.strictEqual(hubBase({}), DEFAULT_HUB);
    assert.strictEqual(hubBase({ production: true }), PRODUCTION_HUB);
    assert.strictEqual(hubBase({ host: 'http://127.0.0.1:9999/' }), 'http://127.0.0.1:9999');
  });

  it('treats only loopback hosts as local Hubs', function () {
    assert.ok(isLoopbackHub(DEFAULT_HUB));
    assert.ok(isLoopbackHub('http://localhost:8080'));
    assert.ok(isLoopbackHub('http://[::1]:8080'));
    assert.ok(!isLoopbackHub(PRODUCTION_HUB));
    assert.ok(!isLoopbackHub('http://127.0.0.1.example.com'));
    assert.ok(!isLoopbackHub('not a url'));
  });

  it('reads the local admin-token file only when allowed', function () {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-home-'));
    const saved = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      FABRIC_HUB_ADMIN_TOKEN: process.env.FABRIC_HUB_ADMIN_TOKEN,
      FABRIC_ADMIN_TOKEN: process.env.FABRIC_ADMIN_TOKEN
    };
    try {
      fs.mkdirSync(path.join(home, '.fabric'));
      fs.writeFileSync(path.join(home, '.fabric', 'hub-admin-token'), 'local-token\n');
      process.env.HOME = home;
      delete process.env.USERPROFILE;
      delete process.env.FABRIC_HUB_ADMIN_TOKEN;
      delete process.env.FABRIC_ADMIN_TOKEN;
      assert.strictEqual(loadAdminToken({}), 'local-token');
      assert.strictEqual(loadAdminToken({ allowFile: false }), '');
      process.env.FABRIC_HUB_ADMIN_TOKEN = 'explicit';
      assert.strictEqual(loadAdminToken({ allowFile: false }), 'explicit');
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('lists and picks the newest fabric-passport zip', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'passport-builds-'));
    try {
      const zipDir = path.join(root, 'zip');
      fs.mkdirSync(zipDir, { recursive: true });
      const older = path.join(zipDir, 'fabric-passport-v0.0.9.zip');
      const newer = path.join(zipDir, 'fabric-passport-v0.1.0.zip');
      fs.writeFileSync(older, 'old');
      const past = Date.now() - 60_000;
      fs.utimesSync(older, past / 1000, past / 1000);
      fs.writeFileSync(newer, 'new');
      fs.writeFileSync(path.join(zipDir, 'ignore-me.zip'), 'nope');

      const rows = listBuildArtifacts(root);
      assert.strictEqual(rows.length, 2);
      assert.ok(rows.every((r) => r.kind === 'zip' && r.mime === 'application/zip'));
      const primary = pickPrimaryZip(rows);
      assert.ok(primary);
      assert.strictEqual(primary.name, 'fabric-passport-v0.1.0.zip');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
