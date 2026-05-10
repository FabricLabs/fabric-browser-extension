'use strict';

/**
 * Single sequential journey: seed login → wallet strip → verify/sign sub-screens → settings →
 * identity detail → logout modal dismiss. Complements split specs by catching ordering/regression issues.
 * Requires extension context (same as other UI tests); does not replace static `popup.html` smoke.
 */

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport operator journey (chained)', () => {
  test.describe.configure({ timeout: 180000 });

  test('logged-in dashboard: wallet, verify, sign, settings, identity detail, logout cancel', async ({
    context,
    extensionId
  }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await expect(page.getByText('Loaded Identities')).toBeVisible();

      await page.getByRole('button', { name: /Receive/i }).click();
      await expect(page.getByText(/Receive address \(BIP84|Could not derive an address/i)).toBeVisible({
        timeout: 15000
      });
      await page.getByRole('button', { name: /Receive/i }).click();

      await page.getByRole('button', { name: /Verify Message/i }).click();
      await expect(page.getByText('Verify message signature')).toBeVisible();
      await page.getByRole('button', { name: /^Go back$/i }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();

      await page.getByRole('button', { name: /Sign Message/i }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Sign Message$/ })).toBeVisible();
      await page.getByRole('button', { name: /^Go back$/i }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();

      await page.getByRole('button', { name: /^Settings$/ }).click();
      await expect(page.getByRole('heading', { name: /Fabric Nodes/i })).toBeVisible();
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();

      await page.locator('.message').filter({ hasText: 'Loaded Identities' }).locator('.content .item').first().click();
      await expect(page.getByRole('heading', { name: /Balance/i })).toBeVisible();
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();

      await page.getByRole('button', { name: /^Logout$/ }).click();
      await expect(page.getByText('Log out?', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
