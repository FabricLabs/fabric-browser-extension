'use strict';

/**
 * Settings menu: each section opens on its own, Security can start Clear Data
 * and cancel, About shows the version, and Back returns to the dashboard.
 */

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport Settings (deep)', () => {
  test.describe.configure({ timeout: 120000 });

  test('menu opens each section, About shows the version, Clear Data → Cancel', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Settings$/ }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();
      await expect(page.getByRole('navigation', { name: 'Settings sections' })).toBeVisible();
      for (const section of ['Lock', 'Security', 'Bitcoin', 'Fabric', 'Pages', 'Budget', 'About']) {
        await expect(page.getByRole('button', { name: section, exact: true })).toBeVisible();
      }
      await expect(page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003')).toHaveCount(0);

      await page.getByRole('button', { name: 'Lock', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Lock$/i, level: 4 })).toBeVisible();
      await expect(page.getByText('Auto-Lock Timer', { exact: true })).toBeVisible();
      await expect(page.getByText(/Lock wallet after inactivity/i)).toBeVisible();
      await expect(page.getByText('Lock now', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Lock Passport$/ })).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Bitcoin', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Bitcoin Nodes$/i, level: 4 })).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Fabric', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Fabric Nodes$/i, level: 4 })).toBeVisible();
      await expect(page.getByText(/WebRTC data channels use the Hub WebSocket/i)).toBeVisible();
      await expect(page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003')).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Pages', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Page index$/i, level: 4 })).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Budget', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Budget agent$/i, level: 4 })).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^Security & privacy$/i, level: 4 }).first()).toBeVisible();
      await expect(page.getByText('Backup & Restore', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Export Backup$/ })).toBeVisible();
      await expect(page.getByText('Clear All Data', { exact: true })).toBeVisible();

      await page.getByRole('button', { name: /^All settings$/ }).click();
      await page.getByRole('button', { name: 'About', exact: true }).click();
      await expect(page.getByRole('heading', { name: /^About$/i, level: 4 })).toBeVisible();
      const aboutList = page.locator('h4').filter({ hasText: /^About$/ }).locator('xpath=following-sibling::div[contains(@class,"list")][1]');
      await expect(aboutList.getByText(/\d+\.\d+\.\d+/)).toBeVisible();
      await page.getByRole('button', { name: /^All settings$/ }).click();

      await page.getByRole('button', { name: 'Security', exact: true }).click();
      await page.getByRole('button', { name: /^Clear Data$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).toBeVisible();
      await expect(
        page.getByText(/This removes your Passport \(the sealed master key and every account\)/i)
      ).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Erase all extension data?', { exact: true })).not.toBeVisible();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Security & privacy$/i, level: 4 })).toBeVisible();

      await page.getByRole('button', { name: /^All settings$/ }).click();
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
