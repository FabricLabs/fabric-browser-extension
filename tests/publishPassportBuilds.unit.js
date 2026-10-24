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
