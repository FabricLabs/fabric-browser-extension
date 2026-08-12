/// <reference types="chrome"/>
'use strict';

import { chromium, type BrowserContext } from 'playwright';
import * as assert from 'assert';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { ensureLocalTestServer, type LocalTestServerHandle } from './harness/localTestServer';

/** Absolute path so Chrome / Chromium both load the unpacked extension reliably. */
const EXTENSION_PATH = path.resolve(__dirname, '..', 'assets');

/** Options for `chromium.launchPersistentContext` (Playwright does not export this type name). */
type LaunchPersistentContextOptions = NonNullable<Parameters<typeof chromium.launchPersistentContext>[1]>;

/**
 * Playwright browser distribution tokens to try, in order.
 * Use `null` for Playwright’s bundled Chromium (no `channel` — most reliable for MV3).
 * Override with `FABRIC_PLAYWRIGHT_CHANNEL=chrome` (or comma-list) for a system browser.
 * Default is bundled-only: system Chrome still writes Crashpad under the real ~/Library
 * (HOME is ignored for that path on macOS), which fails in restricted agent sandboxes.
 */
function extensionTestPlaywrightChannels (): Array<string | null> {
  const raw = process.env.FABRIC_PLAYWRIGHT_CHANNEL || process.env.PLAYWRIGHT_CHANNEL;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => (s === 'bundled' || s === 'default' ? null : s));
  }
  return [null];
}

/**
 * Isolate writable dirs for Chromium where the host honors HOME/XDG.
 * Note: macOS Chrome/Chromium Crashpad still uses the real user Library path.
 */
function chromiumIsolatedEnv (userDataDir: string): { [key: string]: string } {
  const home = userDataDir;
  const env: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  return env;
}

async function launchExtensionContext (userDataDir: string): Promise<BrowserContext> {
  fs.mkdirSync(userDataDir, { recursive: true });
  const crashDir = path.join(userDataDir, 'Crashpad');
  fs.mkdirSync(crashDir, { recursive: true });
  // Best-effort stubs if a build honors HOME for Application Support.
  for (const product of ['Chromium', 'Google/Chrome']) {
    fs.mkdirSync(path.join(userDataDir, 'Library', 'Application Support', product, 'Crashpad'), {
      recursive: true
    });
  }

  const headless = !!process.env.CI;
  const base: LaunchPersistentContextOptions = {
    headless,
    env: chromiumIsolatedEnv(userDataDir),
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-web-security',
      '--allow-insecure-localhost',
      '--disable-features=BlockInsecurePrivateNetworkRequests',
      '--disable-breakpad',
      '--disable-crash-reporter',
      `--crash-dumps-dir=${crashDir}`
    ],
    // Playwright defaults include `--disable-extensions`, which fights `--load-extension`.
    ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
    viewport: { width: 1280, height: 720 }
  };
  const channels = extensionTestPlaywrightChannels();
  const errors: string[] = [];
  for (const ch of channels) {
    try {
      const opts: LaunchPersistentContextOptions = { ...base };
      if (ch) opts.channel = ch as 'chrome' | 'msedge' | 'chromium';
      return await chromium.launchPersistentContext(userDataDir, opts);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      errors.push(`[${ch || 'bundled'}] ${err.message}`);
    }
  }
  const joined = errors.join('\n---\n');
  const hint = /Operation not permitted|xattr|Crashpad/i.test(joined)
    ? ' Host denied Chromium Crashpad/xattr under ~/Library (macOS Crashpad ignores HOME). Re-run outside a restricted sandbox.'
    : '';
  throw new Error(
    `Playwright could not launch a browser (tried: ${channels.map((c) => c || 'bundled').join(', ')}). ` +
      'Install Playwright’s Chromium: npx playwright install chromium (or npm run playwright:install). ' +
      'The extension test script runs that before mocha. ' +
      `Errors:\n${joined || 'unknown'}.${hint}`
  );
}

async function waitForExtensionId (context: BrowserContext, serverBase: string): Promise<string> {
  const readId = () => {
    for (const sw of context.serviceWorkers()) {
      const u = sw.url();
      if (u.startsWith('chrome-extension://')) {
        return new URL(u).hostname;
      }
    }
    return null;
  };

  const page = await context.newPage();
  try {
    await page.goto(`${serverBase}/test.html`, { waitUntil: 'domcontentloaded' });
  } finally {
    await page.close();
  }

  const direct = readId();
  if (direct) return direct;

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const found = readId();
    if (found) return found;
    try {
      await context.waitForEvent('serviceworker', { timeout: 400 });
    } catch (err: unknown) {
      void err;
    }
  }
  throw new Error(
    'Could not find chrome-extension:// service worker (MV3 background). ' +
      'Use Playwright’s Chromium (npm run playwright:install) unless you know your channel supports extension SW discovery.'
  );
}

let context: BrowserContext;
let server: LocalTestServerHandle;
let extensionId: string;

describe('Browser extension (Playwright + Mocha)', function () {
  this.timeout(120000);

  before(async function () {
    server = await ensureLocalTestServer(3044);
    const userDataDir = path.join(
      os.tmpdir(),
      `fabric-passport-mocha-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );

    context = await launchExtensionContext(userDataDir);

    extensionId = await waitForExtensionId(context, server.baseUrl);
    await new Promise((r) => setTimeout(r, 500));
  });

  after(async function () {
    if (context) await context.close();
    if (server) await server.stop();
  });

  it('serves the content-script test page', async function () {
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/test.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('h1', { timeout: 15000 });
      const title = await page.locator('h1').first().textContent();
      assert.ok(title && title.includes('Fabric Extension Test Page'), `unexpected title text: ${title}`);
    } finally {
      await page.close();
    }
  });

  /** Run before opening `chrome-extension://` pages so MV3 startup order does not flake content-script injection. */
  it('injects the content script (shared DOM marker; isolated from page JS)', async function () {
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/test.html`, { waitUntil: 'load', timeout: 30000 });
      let lastErr: Error | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await page.waitForFunction(
            () => document.documentElement?.getAttribute('data-fabric-passport') != null,
            { timeout: 20000 }
          );
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e instanceof Error ? e : new Error(String(e));
          await page.reload({ waitUntil: 'load', timeout: 30000 });
        }
      }
      if (lastErr) throw lastErr;
      const attr = await page.evaluate(() => document.documentElement?.getAttribute('data-fabric-passport'));
      assert.strictEqual(attr, extensionId);
    } finally {
      await page.close();
    }
  });

  it('loads the extension popup with expected document title', async function () {
    const popupPage = await context.newPage();
    try {
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 20000
      });
      const title = await popupPage.title();
      assert.ok(/fabric|passport/i.test(title), `unexpected popup title: ${title}`);
    } finally {
      await popupPage.close();
    }
  });

  it('serves the dev harness API used by FABRIC_ACTION (Node check; SW async reply is not asserted here)', async function () {
    const u = new URL('/api/endpoint', server.nodeBaseUrl).href;
    const body: unknown = await new Promise((resolve, reject) => {
      http.get(u, (res) => {
        let data = '';
        res.on('data', (c: Buffer) => { data += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(e);
          }
        });
      }).on('error', reject);
    });
    assert.ok(body && typeof body === 'object');
    assert.strictEqual((body as { success?: boolean }).success, true);
    assert.strictEqual((body as { source?: string }).source, 'local-test-server');
  });

  /**
   * Exercise extension storage from the popup origin (same API the UI uses).
   * Note: `chrome.runtime.sendMessage` to the MV3 service worker is flaky under Playwright’s
   * Chromium + unpacked extensions (“Receiving end does not exist”); background handlers are
   * covered indirectly once the SW receives messages in real Chrome.
   */
  it('reads and writes chrome.storage.local from the extension popup', async function () {
    const settings = { theme: 'dark', enabled: true };
    const extPage = await context.newPage();
    try {
      await extPage.goto(`chrome-extension://${extensionId}/popup.html`, {
        waitUntil: 'domcontentloaded',
        timeout: 25000
      });
      const stored = await extPage.evaluate((s) => {
        return new Promise<Record<string, unknown>>((resolve, reject) => {
          chrome.storage.local.set(s, () => {
            const err = chrome.runtime.lastError;
            if (err) {
              reject(new Error(err.message));
              return;
            }
            chrome.storage.local.get(['theme', 'enabled'], (data) => {
              const err2 = chrome.runtime.lastError;
              if (err2) reject(new Error(err2.message));
              else resolve(data as Record<string, unknown>);
            });
          });
        });
      }, settings);
      assert.strictEqual(stored.theme, settings.theme);
      assert.strictEqual(stored.enabled, settings.enabled);
    } finally {
      await extPage.close();
    }
  });
});
