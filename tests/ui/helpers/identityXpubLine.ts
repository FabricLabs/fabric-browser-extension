'use strict';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

export async function openFirstIdentityInList (page: Page): Promise<void> {
  await page.locator('.message').filter({ hasText: 'Loaded Identities' }).locator('.content .item').first().click();
  await expect(page.getByRole('heading', { name: /^xpub$/i })).toBeVisible({ timeout: 20000 });
}

/**
 * Truncated xpub line as shown on identity detail (stable fingerprint for a seed, no RPC).
 */
export async function readDisplayedXpubLine (page: Page): Promise<string> {
  const h = page.getByRole('heading', { name: /^xpub$/i });
  await h.waitFor({ state: 'visible' });
  return (await h.locator('..').locator('div').first().locator('span').first().innerText()).trim();
}
