'use strict';

/**
 * Proves a single extension profile (one seed) shows the *same* xpub on identity detail
 * before vs after visiting two different *origins* (localhost vs 127.0.0.1, same port).
 * Identity lives in extension storage; pages only need `content_scripts` match (see manifest).
 */

import { test, expect } from './extension.fixtures';
import { loginWithTestMnemonic, openExtensionPopup } from './helpers/popupAuth';
import { openFirstIdentityInList, readDisplayedXpubLine } from './helpers/identityXpubLine';

test.describe('Shared identity across two site origins (same seed)', () => {
  test.describe.configure({ timeout: 120000 });

  test('xpub (same seed) matches after visiting localhost and 127.0.0.1 harness pages', async ({ context, baseURL, extensionId }) => {
    expect(baseURL, 'playwright use.baseURL').toBeTruthy();
    const b = new URL(baseURL as string);
    const port = b.port || (b.protocol === 'https:' ? '443' : '80');
    const originLoopback = `${b.protocol}//127.0.0.1:${port}`;

    const popup = await context.newPage();
    try {
      await loginWithTestMnemonic(popup, extensionId);
      await openFirstIdentityInList(popup);
      const xpubBefore = await readDisplayedXpubLine(popup);
      await popup.getByRole('button', { name: /^Back$/ }).click();
      await expect(popup.getByText('Loaded Identities')).toBeVisible({ timeout: 15000 });

      const pLocal = await context.newPage();
      const pLo = await context.newPage();
      try {
        await pLocal.goto(`${baseURL as string}/test.html`, { waitUntil: 'domcontentloaded' });
        await pLocal.waitForFunction(
          () => document.documentElement?.getAttribute('data-fabric-passport') != null,
          { timeout: 20000 }
        );
        await pLo.goto(`${originLoopback}/test.html`, { waitUntil: 'domcontentloaded' });
        await pLo.waitForFunction(
          () => document.documentElement?.getAttribute('data-fabric-passport') != null,
          { timeout: 20000 }
        );
        expect(
          pLocal.url().split('/').slice(0, 3).join('/'),
          'first tab origin is not 127.0.0.1 (different host for cross-origin check)'
        ).not.toBe(originLoopback);
      } finally {
        await pLocal.close();
        await pLo.close();
      }

      await openExtensionPopup(popup, extensionId);
      await expect(popup.getByText('Loaded Identities').first()).toBeVisible({ timeout: 20000 });
      await openFirstIdentityInList(popup);
      const xpubAfter = await readDisplayedXpubLine(popup);

      expect(xpubAfter, 'identity xpub is identical regardless of which http origins were open').toBe(xpubBefore);
    } finally {
      await popup.close();
    }
  });
});
