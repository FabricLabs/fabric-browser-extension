'use strict';

/**
 * Settings screen: section headings, read-only derivation path, Security actions,
 * About version, and destructive Clear Data modal dismissed with Cancel.
 */

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport Settings (deep)', () => {
  test.describe.configure({ timeout: 120000 });

  test('sections, version, derivation path read-only, Clear Data → Cancel', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Settings$/ }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();

      await expect(page.getByRole('heading', { name: /^Identity Management$/i, level: 4 })).toBeVisible();
      await expect(page.getByText('Auto-Lock Timer', { exact: true })).toBeVisible();
      await expect(page.getByText(/Lock wallet after inactivity/i)).toBeVisible();
      await expect(page.getByText('Lock now', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Lock Passport$/ })).toBeVisible();

      await expect(page.getByRole('heading', { name: /^Bitcoin Nodes$/i, level: 4 })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Fabric Nodes$/i, level: 4 })).toBeVisible();
      await expect(page.getByText(/WebRTC data channels use the Hub WebSocket/i)).toBeVisible();

      await expect(page.getByRole('heading', { name: /^Security & privacy$/i, level: 4 }).first()).toBeVisible();
      await expect(page.getByText('Backup & Restore', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Export Backup$/ })).toBeVisible();
      await expect(page.getByText('Clear All Data', { exact: true })).toBeVisible();

      await expect(page.getByRole('heading', { name: /^About$/i, level: 4 })).toBeVisible();
      const aboutList = page.locator('h4').filter({ hasText: /^About$/ }).locator('xpath=following-sibling::div[contains(@class,"list")][1]');
      await expect(aboutList.getByText(/\d+\.\d+\.\d+/)).toBeVisible();

      await page.getByRole('button', { name: /^Clear Data$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/This removes your Passport \(the sealed master key and every account\)/i)
      ).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).not.toBeVisible();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();

      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
