/// <reference types="chrome"/>
'use strict';

import type { BrowserContext } from '@playwright/test';
import { FABRIC_MESH_HUB_REGISTRATION_KEY } from '../../../src/constants/fabricExtension';

export { FABRIC_MESH_HUB_REGISTRATION_KEY };

/**
 * Read `chrome.storage.local` from an extension page (popup has `chrome.storage` API).
 */
export async function readExtensionLocalStorage (extensionPage: {
  evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
}): Promise<Record<string, unknown>> {
  return extensionPage.evaluate(
    () =>
      new Promise<Record<string, unknown>>((resolve, reject) => {
        try {
          chrome.storage.local.get(null, (data) => {
            const err = chrome.runtime.lastError;
            if (err) reject(new Error(err.message));
            else resolve(data as Record<string, unknown>);
          });
        } catch (e) {
          reject(e);
        }
      })
  );
}

export async function clearMeshHubRegistration (context: BrowserContext, extensionId: string): Promise<void> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.evaluate(
      (key) =>
        new Promise<void>((resolve, reject) => {
          try {
            chrome.storage.local.remove(key, () => {
              const err = chrome.runtime.lastError;
              if (err) reject(new Error(err.message));
              else resolve();
            });
          } catch (e) {
            reject(e);
          }
        }),
      FABRIC_MESH_HUB_REGISTRATION_KEY
    );
  } finally {
    await page.close();
  }
}

export async function readMeshHubRegistration (
  context: BrowserContext,
  extensionId: string
): Promise<Record<string, unknown> | undefined> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/popup.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const all = await readExtensionLocalStorage(page);
    const raw = all[FABRIC_MESH_HUB_REGISTRATION_KEY];
    return raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : undefined;
  } finally {
    await page.close();
  }
}
