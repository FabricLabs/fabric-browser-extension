'use strict';

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport wallet & identity detail', () => {
  test.describe.configure({ timeout: 120000 });

  test('Wallet: Receive, History, and Send panels show expected copy', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Wallet/ }).click();
      await expect(page.getByRole('heading', { name: /^Wallet$/i })).toBeVisible();

      await page.getByRole('button', { name: /Receive/i }).click();
      await expect(
        page.getByText(/Receive address \(SegWit, BIP84|Could not derive an address/i)
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
      await page.locator('.message').filter({ has: page.locator('.header', { hasText: /^Accounts$/ }) }).locator('.content .item').first().click();
      await expect(page.getByRole('heading', { name: /Balance/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Identity$/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Public key$/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Escrow key \(cosigner\)$/i })).toBeVisible();
      await expect(page.getByRole('heading', { name: /^Wallet xpub \(SegWit/i })).toBeVisible();
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Add Account opens another account from the same seed', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Add Account$/ }).click();
      await page.locator('.field').filter({ hasText: 'Account number' }).locator('input').fill('1');
      await page.getByRole('button', { name: /^Open Account$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
      await expect(page.getByText(/#1 · mainnet/).first()).toBeVisible();
      await expect(page.getByText(/#0 · mainnet/).first()).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
