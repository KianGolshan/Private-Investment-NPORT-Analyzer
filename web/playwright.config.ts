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
  use: { baseURL: 'http://127.0.0.1:4173', acceptDownloads: true, ...devices['Desktop Chrome'] },
  webServer: {
    command: 'node e2e/server.cjs',
    url: 'http://127.0.0.1:4173/api/freshness',
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
  },
});
