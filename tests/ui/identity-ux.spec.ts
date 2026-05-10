'use strict';

import { test, expect } from './extension.fixtures';
import { ensureHarnessFabricNodeActive } from './helpers/fabricNodeSettings';
import { loginWithTestMnemonic } from './helpers/popupAuth';

test.describe('@fabric/passport logged-in UX', () => {
  test.describe.configure({ timeout: 120000 });
  test('seed login reaches dashboard with Fabric node card and footer actions', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await expect(page.getByText('Loaded Identities')).toBeVisible();
      await expect(page.getByRole('button', { name: /Connect & register/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Settings$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Logout$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Add New Identity/i })).toBeVisible();
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
      await expect(page.getByText('Loaded Identities')).toBeVisible();
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
      const hubInput = page.getByPlaceholder('https://hub.fabric.pub or http://127.0.0.1:3003');
      await hubInput.fill(baseURL ?? 'http://localhost:3044');
      await page.getByRole('button', { name: /^Add Fabric Node$/ }).click();
      const fabricRow = page.getByRole('listitem').filter({ hasText: /3044/ }).last();
      await expect(fabricRow).toBeVisible({ timeout: 15000 });
      await fabricRow.locator('button[title="Set active for mesh"]').click();
      await page.getByRole('button', { name: /Register background mesh/i }).click();
      await expect(page.getByText(/Background mesh registered/i)).toBeVisible({ timeout: 20000 });
      await page.getByRole('button', { name: /^Back$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Connect & register shows RPC outcome when active node is local harness', async ({ context, extensionId, baseURL }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await ensureHarnessFabricNodeActive(page, baseURL);
      await expect(page.getByText('Loaded Identities')).toBeVisible();
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
      await expect(page.getByText(/Logging out removes all identities/i)).toBeVisible();
      await page.getByRole('button', { name: /^Cancel$/ }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Add New Identity shows methods and returns to dashboard', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await loginWithTestMnemonic(page, extensionId);
      await page.getByRole('button', { name: /Add New Identity/i }).click();
      await expect(page.locator('.message .header').filter({ hasText: /^Add New Identity$/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /^Create New$/ })).toBeVisible();
      await page.getByRole('button', { name: /Back to Dashboard/i }).click();
      await expect(page.getByText('Loaded Identities')).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
