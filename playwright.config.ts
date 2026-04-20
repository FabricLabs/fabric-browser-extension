import { defineConfig } from '@playwright/test';

/**
 * UI tests load the unpacked extension from `/assets` (run `npm run build` first).
 * `webServer` serves the same static tree + `/api/endpoint` as the dev harness.
 */
export default defineConfig({
  testDir: './tests/ui',
  timeout: 60000,
  expect: { timeout: 15000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3044',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  },
  webServer: {
    command: 'node scripts/local-test-server.js',
    url: 'http://localhost:3044/test.html',
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
    env: {
      ...process.env,
      PORT: '3044',
      HOST: '127.0.0.1'
    }
  },
  projects: [{ name: 'chromium-extension', use: {} }]
});
