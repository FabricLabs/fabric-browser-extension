'use strict';

/**
 * `hub-mesh-bridge.html` (served with the test harness) mirrors the `postMessage` contract
 * a Hub UI page uses to register long-lived mesh signaling. Integration coverage asserts the
 * extension service worker persists registration in `chrome.storage.local`.
 */

import { test, expect } from './extension.fixtures';
import { clearMeshHubRegistration, readMeshHubRegistration } from './helpers/extensionStorage';

test.describe('@fabric/passport hub-mesh-bridge page', () => {
  test('harness serves bridge HTML with register controls', async ({ context, baseURL }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/hub-mesh-bridge.html`, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveTitle(/background mesh/i);
      await expect(page.getByRole('heading', { level: 1, name: /Hub background mesh/i })).toBeVisible();
      await expect(page.getByText(/@fabric\/passport/i).first()).toBeVisible();
      await expect(page.getByRole('button', { name: /Register background mesh/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Unregister$/ })).toBeVisible();
    } finally {
      await page.close();
    }
  });
});

test.describe('Extension ↔ Hub mesh registration (harness origin)', () => {
  test.beforeEach(async ({ context, extensionId }) => {
    await clearMeshHubRegistration(context, extensionId);
  });

  test('Register background mesh stores hub_page registration in extension storage', async ({ context, baseURL, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/hub-mesh-bridge.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.documentElement?.getAttribute('data-fabric-passport') != null,
        { timeout: 20000 }
      );
      await page.getByRole('button', { name: /Register background mesh/i }).click();
      const origin = new URL(baseURL as string).origin;
      const expectedHub = `${origin}/`;
      await expect
        .poll(
          async () => readMeshHubRegistration(context, extensionId),
          { timeout: 20000, intervals: [200, 500, 1000] }
        )
        .toMatchObject({
          hubAddress: expectedHub,
          pageOrigin: origin,
          source: 'hub_page'
        });
    } finally {
      await page.close();
    }
  });

  test('Unregister clears mesh registration for this page origin', async ({ context, baseURL, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`${baseURL}/hub-mesh-bridge.html`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => document.documentElement?.getAttribute('data-fabric-passport') != null,
        { timeout: 20000 }
      );
      await page.getByRole('button', { name: /Register background mesh/i }).click();
      await expect
        .poll(
          async () => readMeshHubRegistration(context, extensionId),
          { timeout: 20000, intervals: [200, 500, 1000] }
        )
        .toBeDefined();
      await page.getByRole('button', { name: /^Unregister$/ }).click();
      await expect
        .poll(
          async () => readMeshHubRegistration(context, extensionId),
          { timeout: 15000, intervals: [200, 500, 1000] }
        )
        .toBeUndefined();
    } finally {
      await page.close();
    }
  });

});
