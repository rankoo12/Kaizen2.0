import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

/**
 * Kaizen white-box suite (AGENT-B).
 *
 * workers: 1 is not a performance choice — the tests share one live workspace
 * (the demo tenant). Suites, cases and API keys created by one spec are visible
 * to every other, and the Tests screen is a single mutable list. Parallel workers
 * would make row counts and "Drafts N" labels race against each other.
 *
 * globalSetup signs in ONCE and saves the session to .auth-state.json, which
 * every spec inherits through `use.storageState`. That removes the slowest and
 * flakiest step from every test. 01-auth.spec.ts opts back out with
 * `test.use({ storageState: undefined })` because it tests the signed-out app.
 */
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  globalSetup: require.resolve('./global-setup'),
  fullyParallel: false,
  workers: 1,
  forbidOnly: true,
  retries: 0,
  // The app is a Next.js dev server proxying to a Fastify API; the first request
  // to a cold route compiles it, and the server may be under load.
  timeout: 120_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  outputDir: 'test-results',
  use: {
    baseURL: 'http://localhost:3001',
    headless: true,
    viewport: { width: 1500, height: 950 },
    storageState: path.join(__dirname, '.auth-state.json'),
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
    locale: 'en-US',
    timezoneId: 'UTC',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1500, height: 950 } },
    },
  ],
});
