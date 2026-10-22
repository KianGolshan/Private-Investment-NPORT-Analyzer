import { defineConfig, devices } from '@playwright/test';

// The browser suite (P6c R3, staff review F17): the built app (npm run
// build:web) on the real Express server over the golden warehouse
// (e2e/server.cjs). Chromium only.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://127.0.0.1:4173',
    acceptDownloads: true,
    ...devices['Desktop Chrome'],
  },
  // E2E_BASE_URL: audit a server already running (the full warehouse), with no golden server
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        command: 'node e2e/server.cjs',
        url: 'http://127.0.0.1:4173/api/freshness',
        reuseExistingServer: false,
        timeout: 120_000,
        stdout: 'pipe',
      },
});
