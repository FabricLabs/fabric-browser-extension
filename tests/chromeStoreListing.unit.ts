'use strict';

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = process.cwd();

function pngSize (file: string): { width: number, height: number } {
  const buf = fs.readFileSync(file);
  assert.ok(buf.length >= 24, `${file} is not a PNG`);
  assert.strictEqual(buf.toString('ascii', 1, 4), 'PNG');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20)
  };
}

describe('Chrome Web Store listing pack', function () {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'src', 'manifest.json'), 'utf8')
  ) as {
    name: string;
    short_name?: string;
    description: string;
    homepage_url?: string;
    minimum_chrome_version?: string;
    icons?: Record<string, string>;
    permissions: string[];
    host_permissions: string[];
    content_scripts?: Array<{ matches?: string[] }>;
    web_accessible_resources?: Array<{ matches?: string[] }>;
  };

  it('manifest uses a store-safe name, description, icons, and homepage', function () {
    assert.strictEqual(manifest.name, 'Fabric Passport');
    assert.ok((manifest.short_name || '').length > 0);
    assert.ok((manifest.short_name || '').length <= 12, 'short_name should be ≤12 characters');
    assert.ok(manifest.description.length <= 132, `description is ${manifest.description.length} chars`);
    assert.strictEqual(manifest.homepage_url, 'https://hub.fabric.pub');
    assert.ok(manifest.minimum_chrome_version);
    assert.ok(manifest.icons && manifest.icons['16'] && manifest.icons['48'] && manifest.icons['128']);
  });

  it('does not declare unused scripting / activeTab permissions', function () {
    assert.ok(!manifest.permissions.includes('scripting'));
    assert.ok(!manifest.permissions.includes('activeTab'));
  });

  it('does not request Bitcoin RPC or Ollama loopback hosts', function () {
    const joined = manifest.host_permissions.join('\n');
    assert.ok(!joined.includes(':8332'));
    assert.ok(!joined.includes(':18443'));
    assert.ok(!joined.includes(':11434'));
    assert.ok(manifest.host_permissions.includes('https://*/*'));
  });

  it('no match pattern carries an explicit port', function () {
    // Chrome match patterns cannot contain a port; the Web Store validator
    // rejects the upload even though Chrome is lenient at load time. The
    // port-less loopback twins already match every port.
    const patterns = ([] as string[]).concat(
      manifest.host_permissions,
      ...(manifest.content_scripts || []).map((c) => c.matches || []),
      ...(manifest.web_accessible_resources || []).map((r) => r.matches || [])
    );
    const ported = patterns.filter((p) => /^[a-z]+:\/\/[^/]*:(\d+|\*)/.test(p));
    assert.deepStrictEqual(ported, [], `match patterns must not specify a port: ${ported.join(', ')}`);
    for (const loopback of ['http://localhost/*', 'http://127.0.0.1/*']) {
      assert.ok(manifest.host_permissions.includes(loopback), `missing ${loopback}`);
      assert.ok(
        (manifest.content_scripts || []).some((c) => (c.matches || []).includes(loopback)),
        `content_scripts missing ${loopback}`
      );
    }
  });

  it('ships privacy policy and copy-paste listing doc', function () {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'CHROME_WEB_STORE.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'docs', 'privacy-policy.md')));
    assert.ok(fs.existsSync(path.join(ROOT, 'store', 'privacy.html')));
    const html = fs.readFileSync(path.join(ROOT, 'store', 'privacy.html'), 'utf8');
    assert.ok(html.includes('Limited Use'));
    assert.ok(html.includes('security@fabric.pub'));
  });

  it('store listing PNGs exist at required sizes', function () {
    const files: Array<[string, number, number]> = [
      ['store/icons/icon-128.png', 128, 128],
      ['store/icons/icon-512.png', 512, 512],
      ['store/promo/small-440x280.png', 440, 280],
      ['store/promo/marquee-1400x560.png', 1400, 560],
      ['store/screenshots/01-welcome-1280x800.png', 1280, 800],
      ['store/screenshots/02-security-1280x800.png', 1280, 800],
      ['store/screenshots/03-site-login-1280x800.png', 1280, 800],
      ['store/screenshots/04-device-link-1280x800.png', 1280, 800],
      ['store/screenshots/05-hub-connect-1280x800.png', 1280, 800]
    ];
    for (const [rel, w, h] of files) {
      const abs = path.join(ROOT, rel);
      assert.ok(fs.existsSync(abs), `missing ${rel} — run npm run store:assets`);
      const size = pngSize(abs);
      assert.deepStrictEqual(size, { width: w, height: h }, rel);
    }
  });
});
