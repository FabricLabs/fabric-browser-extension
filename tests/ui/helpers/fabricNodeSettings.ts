'use strict';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/**
 * Settings → Fabric Nodes: ensure the Playwright `baseURL` harness (port 3044) exists and is active for mesh.
 * Safe to call repeatedly; skips add when a 3044 row already exists.
 */
export async function ensureHarnessFabricNodeActive (page: Page, baseURL?: string): Promise<void> {
  const url = baseURL ?? 'http://localhost:3044';
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();
  const rows3044 = page.getByRole('listitem').filter({ hasText: /3044/ });
  if ((await rows3044.count()) === 0) {
    await page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003').fill(url);
    await page.getByRole('button', { name: /^Add Fabric Node$/ }).click();
  }
  const row = page.getByRole('listitem').filter({ hasText: /3044/ }).last();
  await expect(row).toBeVisible({ timeout: 15000 });
  const setMeshActive = row.locator('button[title="Set active for mesh"]');
  if (await setMeshActive.count()) await setMeshActive.click();
  await page.getByRole('button', { name: /^Back$/ }).click();
}
