'use strict';

import { test, expect } from './extension.fixtures';

test.describe('@fabric/passport UI smoke', () => {
  test('test.html shows the harness heading', async ({ context, baseURL }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/test.html`, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('h1')).toContainText('Fabric Extension Test Page');
    } finally {
      await page.close();
    }
  });

  test('popup document loads React root', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(/fabric|passport/i);
      await expect(page.locator('#fabric-root')).toBeVisible({ timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  test('content script sets shared DOM marker on test page', async ({ context, baseURL, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/test.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.documentElement?.getAttribute('data-fabric-passport') != null,
        { timeout: 20000 }
      );
      const v = await page.evaluate(() => document.documentElement?.getAttribute('data-fabric-passport'));
      expect(v).toBe(extensionId);
    } finally {
      await page.close();
    }
  });
});
