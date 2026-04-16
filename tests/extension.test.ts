/// <reference types="chrome"/>
'use strict';

import { chromium, type BrowserContext } from 'playwright';
import * as assert from 'assert';
import * as http from 'http';
import * as path from 'path';
import { ensureLocalTestServer, type LocalTestServerHandle } from './harness/localTestServer';

const EXTENSION_PATH = path.join(__dirname, '..', 'assets');

async function waitForExtensionId (context: BrowserContext, serverBase: string): Promise<string> {
  const page = await context.newPage();
  try {
    await page.goto(`${serverBase}/test.html`, { waitUntil: 'domcontentloaded' });
  } finally {
    await page.close();
  }
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    for (const sw of context.serviceWorkers()) {
      const u = sw.url();
      if (u.startsWith('chrome-extension://')) {
        return new URL(u).hostname;
      }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Could not find chrome-extension:// service worker');
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

    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !!process.env.CI,
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
    });

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

  it('injects the content script (shared DOM marker; isolated from page JS)', async function () {
    const page = await context.newPage();
    try {
      await page.goto(`${server.baseUrl}/test.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.documentElement?.getAttribute('data-fabric-passport') != null,
        { timeout: 20000 }
      );
      const attr = await page.evaluate(() => document.documentElement?.getAttribute('data-fabric-passport'));
      assert.strictEqual(attr, extensionId);
    } finally {
      await page.close();
    }
  });

  /** `chrome.runtime` is only available in extension contexts (e.g. popup), not on ordinary https pages. */
  async function sendFromExtensionPage<T> (msg: Record<string, unknown>): Promise<T> {
    const extPage = await context.newPage();
    try {
      await extPage.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      return await extPage.evaluate((m) => {
        return new Promise<T>((resolve, reject) => {
          chrome.runtime.sendMessage(m as never, (res) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(res as T);
          });
        });
      }, msg);
    } finally {
      await extPage.close();
    }
  }

  it('serves the dev harness API used by FABRIC_ACTION (Node check; SW async reply is not asserted here)', async function () {
    const u = new URL('/api/endpoint', server.baseUrl).href;
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

  it('persists settings via STORE_SETTINGS / GET_SETTINGS', async function () {
    const settings = { theme: 'dark', enabled: true };
    await sendFromExtensionPage({ type: 'STORE_SETTINGS', data: settings });
    const stored = await sendFromExtensionPage<Record<string, unknown>>({ type: 'GET_SETTINGS' });
    assert.strictEqual(stored.theme, settings.theme);
    assert.strictEqual(stored.enabled, settings.enabled);
  });
});
