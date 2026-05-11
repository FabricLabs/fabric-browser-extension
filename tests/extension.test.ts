/// <reference types="chrome"/>
'use strict';

import { chromium, type BrowserContext } from 'playwright';
import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { ensureLocalTestServer, type LocalTestServerHandle } from './harness/localTestServer';

/** Absolute path so Chrome / Chromium both load the unpacked extension reliably. */
const EXTENSION_PATH = path.resolve(__dirname, '..', 'assets');

/**
 * Playwright browser `channel` values to try, in order.
 * Default is Playwright’s bundled Chromium only (required for reliable MV3 service-worker discovery).
 * Override with `FABRIC_PLAYWRIGHT_CHANNEL=chrome` if you use a system browser (may be flaky for extensions).
 */
function extensionTestPlaywrightChannels (): string[] {
  const raw = process.env.FABRIC_PLAYWRIGHT_CHANNEL || process.env.PLAYWRIGHT_CHANNEL;
  if (raw && String(raw).trim()) {
    return String(raw)
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ['chromium'];
}

async function launchExtensionContext (userDataDir: string): Promise<BrowserContext> {
  const headless = !!process.env.CI;
  const base = {
    headless,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-web-security',
      '--allow-insecure-localhost',
      '--disable-features=BlockInsecurePrivateNetworkRequests'
    ],
    ignoreDefaultArgs: ['--enable-automation'],
    viewport: { width: 1280, height: 720 }
  };
  const channels = extensionTestPlaywrightChannels();
  let lastErr: Error | null = null;
  for (const ch of channels) {
    try {
      return await chromium.launchPersistentContext(userDataDir, {
        ...base,
        channel: ch as 'chromium' | 'chrome' | 'msedge'
      });
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw new Error(
    `Playwright could not launch a browser (tried: ${channels.join(', ')}). ` +
      'Install Playwright’s Chromium: npx playwright install chromium (or npm run playwright:install). ' +
      'The extension test script runs that before mocha. ' +
      `Last error: ${lastErr ? lastErr.message : 'unknown'}`
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
      require('os').tmpdir(),
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
