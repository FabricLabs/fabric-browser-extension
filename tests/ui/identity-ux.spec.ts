'use strict';

import { test, expect } from './extension.fixtures';
import { ensureHarnessFabricNodeActive, fabricNodeListRowRe } from './helpers/fabricNodeSettings';
import { TEST_LOCK_PASSWORD } from './constants';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport logged-in UX', () => {
  test.describe.configure({ timeout: 120000 });
  test('seed login reaches dashboard with account shortcuts and footer actions', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Wallet/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Peers & / })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Settings$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Logout$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Add Account$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Sign Message/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Verify Message/i })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Verify Message screen and return to dashboard', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /Verify Message/i }).click();
      await expect(page.getByText('Verify message signature')).toBeVisible();
      await expect(page.getByPlaceholder(/Exact signed message/i)).toBeVisible();
      await page.getByRole('button', { name: /^Go back$/i }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Sign Message screen shows unlock or message field', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /Sign Message/i }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Sign Message$/ })).toBeVisible();
      const unlock = page.getByRole('button', { name: /Unlock signing/i });
      const messageBox = page.getByPlaceholder(/Enter the exact message/i);
      await expect(unlock.or(messageBox)).toBeVisible({ timeout: 15000 });
    } finally {
      await page.close();
    }
  });

  test('Settings: Fabric nodes, add local harness URL, activate, mesh register, back', async ({ context, extensionId, baseURL }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Settings$/ }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Settings$/ })).toBeVisible();
      await expect(page.getByRole('heading', { name: /Fabric Nodes/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Register background mesh/i })).toBeVisible();
      const harness = baseURL ?? 'http://localhost:3044';
      const hubInput = page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003');
      await hubInput.fill(harness);
      await page.getByRole('button', { name: /^Add Fabric Node$/ }).click();
      const fabricRow = page.getByRole('listitem').filter({ hasText: fabricNodeListRowRe(harness) }).last();
      await expect(fabricRow).toBeVisible({ timeout: 15000 });
      await fabricRow.locator('button[title="Set active for mesh"]').click();
      await page.getByRole('button', { name: /Register background mesh/i }).click();
      await expect(page.getByText(/Background mesh registered/i)).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Connect & register shows RPC outcome when active node is local harness', async ({ context, extensionId, baseURL }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await ensureHarnessFabricNodeActive(page, baseURL);
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
      await page.getByRole('button', { name: /^Peers & / }).click();
      await page.getByRole('button', { name: /Connect & register/i }).click();
      await expect(page.getByText(/Connected\.|HTTP \d+|Unexpected token|JSON|Failed to fetch/i)).toBeVisible({
        timeout: 20000
      });
    } finally {
      await page.close();
    }
  });

  test('Logout confirm can be dismissed and dashboard remains', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Logout$/ }).click();
      await expect(page.getByText('Log out?', { exact: true })).toBeVisible();
      await expect(page.getByText(/Logging out removes your Passport/i)).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Add Account shows the account form and returns to dashboard', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Add Account$/ }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Add Account$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Open Account$/ })).toBeVisible();
      await page.getByRole('button', { name: /Back to Dashboard/i }).click();
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('a locked wallet covers the window until the lock password is entered', async ({ context, extensionId }) => {
    test.setTimeout(180000);
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /^Settings$/ }).click();
      await page.getByRole('button', { name: /^Lock Passport$/ }).click();

      const dialog = page.locator('#passport-unlock-screen');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('heading', { name: /Unlock your wallet/i })).toBeVisible();
      const covered = await page.evaluate(() => {
        const el = document.getElementById('passport-unlock-screen');
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return {
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight
        };
      });
      expect(covered).not.toBeNull();
      expect(Math.abs(covered!.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(covered!.left)).toBeLessThanOrEqual(1);
      expect(Math.abs(covered!.width - covered!.innerWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(covered!.height - covered!.innerHeight)).toBeLessThanOrEqual(1);

      await dialog.getByRole('button', { name: /Forgot your lock password/i }).click();
      await expect(dialog.getByRole('heading', { name: 'Log out?' })).toBeVisible();
      await dialog.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(dialog.getByRole('heading', { name: /Unlock your wallet/i })).toBeVisible();

      await page.reload({ waitUntil: 'domcontentloaded' });
      const lockedAgain = page.locator('#passport-unlock-screen');
      await expect(lockedAgain.getByRole('heading', { name: /Unlock your wallet/i })).toBeVisible({ timeout: 20000 });
      await lockedAgain.getByLabel('Lock password').fill('not-the-lock-password');
      await lockedAgain.getByRole('button', { name: /^Unlock$/ }).click();
      await expect(lockedAgain.getByText('Wrong lock password.')).toBeVisible({ timeout: 30000 });
      await lockedAgain.getByLabel('Lock password').fill(TEST_LOCK_PASSWORD);
      await lockedAgain.getByRole('button', { name: /^Unlock$/ }).click();
      await expect(page.locator('#passport-unlock-screen')).toBeHidden({ timeout: 30000 });
      await expect(page.getByText('Accounts', { exact: true })).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
