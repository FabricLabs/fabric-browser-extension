'use strict';

/**
 * Logged-in flow: Add New Identity → Use Existing xpub → xpub login screen → Go Back to dashboard.
 */

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport Add identity (xpub path)', () => {
  test.describe.configure({ timeout: 120000 });

  test('Add New Identity → Use Existing xpub → Login with Extended Public Key → Go Back', async ({
    context,
    extensionId
  }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /Add New Identity/i }).click();
      await expect(page.getByText('Add New Identity', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Use Existing xpub$/ }).click();
      await expect(page.getByText('Login with Extended Public Key', { exact: true })).toBeVisible();
      await expect(page.getByPlaceholder(/xpub/i)).toBeVisible();
      await page.getByRole('button', { name: /^Go Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
