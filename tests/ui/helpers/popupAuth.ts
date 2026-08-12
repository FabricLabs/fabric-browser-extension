'use strict';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { TEST_MNEMONIC_ABANDON } from '../constants';

export async function openExtensionPopup (page: Page, extensionId: string): Promise<void> {
  await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
}

/**
 * Full seed login against a fresh profile (no prior identities).
 */
export async function loginWithTestMnemonic (
  page: Page,
  extensionId: string,
  opts: { mnemonic?: string; derivationPassword?: string } = {}
): Promise<void> {
  const mnemonic = opts.mnemonic ?? TEST_MNEMONIC_ABANDON;
  const derivationPassword = opts.derivationPassword ?? '';

  await openExtensionPopup(page, extensionId);
  await expect(page.getByText('@fabric/passport')).toBeVisible({ timeout: 20000 });
  try {
    await page.getByText('Loaded Identities').waitFor({ state: 'visible', timeout: 3000 });
    return;
  } catch (err: unknown) {
    void err;
  }
  await expect(page.getByText(/don't have an identity yet/i)).toBeVisible();
  await page.getByRole('button', { name: /Use Existing/i }).click();
  await expect(page.getByText('Choose Login Method')).toBeVisible();
  await page.getByRole('button', { name: /Use Seed Phrase/i }).click();
  await expect(page.getByText('Login with Seed Phrase')).toBeVisible();
  await page.locator('input[placeholder*="12 or 24 word"]').fill(mnemonic);
  await page.locator('input[type="password"]').first().fill(derivationPassword);
  await page.getByRole('button', { name: /^Login$/ }).click();
  await expect(page.getByText('Fabric node', { exact: true })).toBeVisible({ timeout: 45000 });
}
