'use strict';

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport wallet & identity detail', () => {
  test.describe.configure({ timeout: 120000 });

  test('Wallet: Receive, History, and Send panels show expected copy', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await expect(page.getByRole('heading', { name: /^Wallet$/i })).toBeVisible();

      await page.getByRole('button', { name: /Receive/i }).click();
      await expect(
        page.getByText(/Receive address \(BIP84|Could not derive an address/i)
      ).toBeVisible({ timeout: 15000 });

      await page.getByRole('button', { name: /History/i }).click();
      await expect(page.getByText('No transactions yet.')).toBeVisible({ timeout: 20000 });

      await page.getByRole('button', { name: /Send/i }).click();
      await expect(page.getByPlaceholder(/bc1q… or bcrt1…/i)).toBeVisible();
      await expect(page.getByText(/Hub wallet/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Identity detail shows Balance / keys and Back returns to dashboard', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.locator('.message').filter({ hasText: 'Loaded Identities' }).locator('.content .item').first().click();
      await expect(page.getByRole('heading', { name: /Balance/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Identity$/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Public Key$/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^xpub$/i })).toBeVisible();
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Add New Identity → Create New → security copy → Go Back returns to dashboard', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /Add New Identity/i }).click();
      await page.getByRole('button', { name: /^Create New$/ }).click();
      await expect(page.getByText('Important Security Information')).toBeVisible();
      await page.getByRole('button', { name: /Go Back/i }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
