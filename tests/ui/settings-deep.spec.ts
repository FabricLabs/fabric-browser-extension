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
      await expect(page.getByText('Default Derivation Path', { exact: true })).toBeVisible();
      await expect(page.locator('label').filter({ hasText: /BIP32 derivation path/i })).toBeVisible();
      const bip32Field = page.locator('.field').filter({ hasText: 'BIP32 derivation path' });
      await expect(bip32Field.locator('input').first()).toBeDisabled();

      await expect(page.getByRole('heading', { name: /^Bitcoin Nodes$/i, level: 4 })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Fabric Nodes$/i, level: 4 })).toBeVisible();
      await expect(page.getByText(/WebRTC data channels use the Hub WebSocket/i)).toBeVisible();

      await expect(page.getByRole('heading', { name: /^Security$/i, level: 4 })).toBeVisible();
      await expect(page.getByText('Backup & Restore', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Export Wallet$/ })).toBeVisible();
      await expect(page.getByText('Clear All Data', { exact: true })).toBeVisible();

      await expect(page.getByRole('heading', { name: /^About$/i, level: 4 })).toBeVisible();
      const aboutList = page.locator('h4').filter({ hasText: /^About$/ }).locator('xpath=following-sibling::div[contains(@class,"list")][1]');
      await expect(aboutList.getByText(/\d+\.\d+\.\d+/)).toBeVisible();

      await page.getByRole('button', { name: /^Clear Data$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/This removes all identities, encrypted signing material, and stored settings/i)
      ).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).not.toBeVisible();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();

      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
