'use strict';

import { test as base, chromium, type BrowserContext } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const pathToExtension = path.join(__dirname, '..', '..', 'assets');

/** Unpacked MV3 id is stable for a given `assets/` path; avoids flaky SW polling every test. */
let resolvedExtensionId: string | null = null;

export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-pw-ext-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: !!process.env.CI,
      args: [
        `--disable-extensions-except=${pathToExtension}`,
        `--load-extension=${pathToExtension}`,
        '--no-sandbox',
        '--disable-web-security',
        '--allow-insecure-localhost'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      viewport: { width: 1280, height: 720 }
    });
    await use(context);
    await context.close();
  },

  extensionId: async ({ context, baseURL }, use) => {
    if (resolvedExtensionId) {
      await use(resolvedExtensionId);
      return;
    }
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/test.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } finally {
      await page.close();
    }
    const deadline = Date.now() + 90000;
    let id = '';
    while (Date.now() < deadline) {
      for (const sw of context.serviceWorkers()) {
        const u = sw.url();
        if (u.startsWith('chrome-extension://')) {
          id = new URL(u).hostname;
          break;
        }
      }
      if (id) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!id) throw new Error('Could not resolve chrome-extension:// id from service workers');
    resolvedExtensionId = id;
    await use(id);
  }
});

export const expect = test.expect;
