'use strict';

import { test, expect } from './extension.fixtures';

test.describe('@fabric/passport onboarding (empty profile)', () => {
  test('shows brand and primary actions when no identity exists', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByText('@fabric/passport')).toBeVisible();
      await expect(page.getByText(/don't have an identity yet/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Create New/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Use Existing/i })).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Create New → security copy → Go Back returns to home', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Create New/i }).click();
      await expect(page.getByText('Important Security Information')).toBeVisible();
      await page.getByRole('button', { name: /Go Back/i }).click();
      await expect(page.getByText(/don't have an identity yet/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });

  test('Use Existing → login methods → Go Back returns to home', async ({ context, extensionId }) => {
    const page = await context.newPage();
    try {
      await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: /Use Existing/i }).click();
      await expect(page.getByText('Choose Login Method')).toBeVisible();
      await expect(page.getByText(/would like to log in/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /Use Seed Phrase/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /coming soon/i })).toBeVisible();
      await expect(page.getByRole('button', { name: /Use Extended Public Key/i })).toBeVisible();
      await page.getByRole('button', { name: /^Go Back$/i }).click();
      await expect(page.getByText(/don't have an identity yet/i)).toBeVisible();
    } finally {
      await page.close();
    }
  });
});
