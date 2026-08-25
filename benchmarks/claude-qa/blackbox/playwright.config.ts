import { defineConfig, devices } from '@playwright/test';
import * as path from 'path';

/**
 * Kaizen black-box suite.
 *
 * workers: 1 is REQUIRED — the tests share one mutable workspace (suites, cases,
 * the Brain, usage counters). Parallel workers would race on the same records.
 *
 * globalSetup signs in once and stores the session cookie; every test reuses it
 * through `storageState`, so the suite performs a single login instead of one
 * per test. Auth tests opt out explicitly with an empty storageState.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  globalSetup: path.join(__dirname, 'global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    storageState: path.join(__dirname, '.auth-state.json'),
    headless: true,
    viewport: { width: 1500, height: 1000 },
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
