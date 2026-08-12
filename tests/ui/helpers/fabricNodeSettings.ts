'use strict';

import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

/** Match Fabric node list row text for a harness base URL (host:port). */
export function fabricNodeListRowRe (harnessUrl: string): RegExp {
  const u = new URL(harnessUrl);
  const host = u.hostname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const port = u.port || (u.protocol === 'https:' ? '443' : '80');
  return new RegExp(`${host}:${port}`);
}

/**
 * Settings → Fabric Nodes: ensure the Playwright `baseURL` harness node exists and is active for mesh.
 * Safe to call repeatedly; skips add when a matching row already exists.
 */
export async function ensureHarnessFabricNodeActive (page: Page, baseURL?: string): Promise<void> {
  const url = baseURL ?? 'http://localhost:3044';
  const rowMatch = fabricNodeListRowRe(url);
  await page.getByRole('button', { name: /^Settings$/ }).click();
  await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();
  const rows = page.getByRole('listitem').filter({ hasText: rowMatch });
  if ((await rows.count()) === 0) {
    await page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003').fill(url);
    await page.getByRole('button', { name: /^Add Fabric Node$/ }).click();
  }
  const row = page.getByRole('listitem').filter({ hasText: rowMatch }).last();
  await expect(row).toBeVisible({ timeout: 15000 });
  const setMeshActive = row.locator('button[title="Set active for mesh"]');
  if (await setMeshActive.count()) {
    await setMeshActive.click();
    await expect(setMeshActive).toHaveCount(0);
  }
  await page.getByRole('button', { name: /^Back$/ }).click();
}
