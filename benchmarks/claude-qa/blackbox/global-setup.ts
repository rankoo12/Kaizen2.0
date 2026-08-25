import { chromium, FullConfig } from '@playwright/test';
import * as path from 'path';

/**
 * Sign in ONCE for the whole suite and persist the session cookie.
 *
 * Kaizen sessions are cookie-based, so a single demo sign-in captured here is
 * reused by every test via `use.storageState`. That removes a login round-trip
 * from each test — the slowest and flakiest step when the server is busy.
 *
 * Tests that exercise authentication itself (sign-in, sign-out, route guards)
 * opt out with `test.use({ storageState: { cookies: [], origins: [] } })` and
 * drive the login form directly.
 */
async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = 'http://localhost:3001';
  const statePath = path.join(__dirname, '.auth-state.json');

  const browser = await chromium.launch({ headless: true });
  try {
    // The dev server can recycle itself; a couple of attempts absorb that blip
    // rather than failing the entire suite before it starts.
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const context = await browser.newContext({ baseURL });
      const page = await context.newPage();
      try {
        await page.goto(`${baseURL}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await page.getByRole('button', { name: /demo user/i }).click({ timeout: 60_000 });
        await page.waitForURL(/\/tests/, { timeout: 60_000 });

        // Don't save until the workspace has really loaded, so the cookie we
        // store is one the server has accepted.
        await page.locator('main').filter({ hasText: /tests across/i }).first()
          .waitFor({ state: 'visible', timeout: 60_000 });

        await context.storageState({ path: statePath });
        await context.close();
        return;
      } catch (error) {
        lastError = error;
        await context.close();
        if (attempt < 3) await new Promise((r) => setTimeout(r, 5_000));
      }
    }
    throw lastError;
  } finally {
    await browser.close();
  }
}

export default globalSetup;
