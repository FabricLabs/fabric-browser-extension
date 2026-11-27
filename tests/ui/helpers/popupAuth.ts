'use strict';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TEST_LOCK_PASSWORD, TEST_MNEMONIC_ABANDON } from '../constants';

export async function openExtensionPopup (page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
}

/**
 * Import the test seed into a fresh profile, sealed under a test lock password.
 */
export async function loginWithTestMnemonic (
  page: Page,
  extensionId: string,
  opts: { mnemonic?: string; passphrase?: string; lockPassword?: string } = {}
): Promise<void> {
  const mnemonic = opts.mnemonic ?? TEST_MNEMONIC_ABANDON;
  const passphrase = opts.passphrase ?? '';
  const lockPassword = opts.lockPassword ?? TEST_LOCK_PASSWORD;

  await openExtensionPopup(page, extensionId);
  await expect(page.getByText('@fabric/passport')).toBeVisible({ timeout: 20000 });
  try {
    await page.getByText('Accounts', { exact: true }).waitFor({ state: 'visible', timeout: 3000 });
    return;
  } catch (err: unknown) {
    void err;
  }
  await expect(page.getByText(/don't have an identity yet/i)).toBeVisible();
  await page.getByRole('button', { name: /Use Existing/i }).click();
  await expect(page.getByText('Use an Existing Key')).toBeVisible();
  await page.getByRole('button', { name: /^Seed Phrase$/ }).click();
  await expect(page.getByText('Import a Seed Phrase')).toBeVisible();
  await page.locator('input[placeholder*="12 or 24 word"]').fill(mnemonic);
  const secrets = page.locator('input[type="password"]');
  await secrets.nth(0).fill(passphrase);
  await secrets.nth(1).fill(lockPassword);
  await secrets.nth(2).fill(lockPassword);
  await page.getByRole('button', { name: /^Import$/ }).click();
  await expect(page.getByRole('button', { name: /^Add Account$/ })).toBeVisible({ timeout: 45000 });
}
