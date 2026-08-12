'use strict';

/**
 * Optional integration: same mesh `postMessage` + storage checks as `hub-mesh-bridge.spec.ts`, but
 * the page is served from a **remote** origin (default workflow: `npm run sample:hub` in `@fabric/http`
 * on 8080, or a full Hub you already run locally).
 *
 * Run (extension repo, after `playwright:install`):
 *   FABRIC_HUB_BASE_URL=http://127.0.0.1:8080 npm run test:ui:mesh-remote
 * Optional path override: FABRIC_HUB_MESH_PATH=hub-mesh-bridge.html
 *
 * The Playwright `webServer` (3044) still runs so `extensionId` from `extension.fixtures` works.
 */

import { test, expect } from './extension.fixtures';
import { clearMeshHubRegistration, readMeshHubRegistration } from './helpers/extensionStorage';
import { getHubMeshPageUrl } from './helpers/remoteHubUrl';

const meshUrl = getHubMeshPageUrl();
const run = Boolean(meshUrl);

if (run) {
  test.describe('Extension ↔ Hub mesh (remote origin)', () => {
    test.beforeEach(async ({ context, extensionId }) => {
      await clearMeshHubRegistration(context, extensionId);
    });

    test('Register background mesh persists hub_page on remote origin', async ({ context, extensionId }) => {
      const page = await context.newPage();
      const url = meshUrl as string;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => document.documentElement?.getAttribute('data-fabric-passport') != null,
          { timeout: 25000 }
        );
        await page.getByRole('button', { name: /Register background mesh/i }).click();
        const origin = new URL(url).origin;
        const expectedHub = `${origin}/`;
        await expect
          .poll(
            async () => readMeshHubRegistration(context, extensionId),
            { timeout: 25000, intervals: [200, 500, 1000] }
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

    test('Unregister clears remote hub_page registration', async ({ context, extensionId }) => {
      const page = await context.newPage();
      const url = meshUrl as string;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(
          () => document.documentElement?.getAttribute('data-fabric-passport') != null,
          { timeout: 25000 }
        );
        await page.getByRole('button', { name: /Register background mesh/i }).click();
        await expect
          .poll(
            async () => readMeshHubRegistration(context, extensionId),
            { timeout: 25000, intervals: [200, 500, 1000] }
          )
          .toBeDefined();
        await page.getByRole('button', { name: /^Unregister$/ }).click();
        await expect
          .poll(
            async () => readMeshHubRegistration(context, extensionId),
            { timeout: 20000, intervals: [200, 500, 1000] }
          )
          .toBeUndefined();
      } finally {
        await page.close();
      }
    });
  });
} else {
  test.describe.skip('Extension ↔ Hub mesh (remote origin)', () => {
    test('Set FABRIC_HUB_BASE_URL (e.g. http://127.0.0.1:8080) — see npm run test:ui:mesh-remote', async () => {});
  });
}
