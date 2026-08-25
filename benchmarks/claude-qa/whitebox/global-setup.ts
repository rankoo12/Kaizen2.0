import { chromium, expect, type FullConfig } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Signs in ONCE for the whole run and saves the session cookies.
 *
 * Every spec then starts already authenticated via `use.storageState`, which
 * removes the slowest and flakiest step from ~500 tests and turns hundreds of
 * sign-ins into one. The specs that TEST authentication itself
 * (01-auth.spec.ts) override this with `test.use({ storageState: undefined })`
 * so they still see the signed-out app.
 *
 * The session is cookie-based (http-only ACCESS_COOKIE / REFRESH_COOKIE set by
 * /api/auth/demo), and the proxy transparently refreshes an expired access
 * token, so a state file captured here stays usable for the length of a run.
 */

export const STORAGE_STATE = path.join(__dirname, '.auth-state.json');

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = (config.projects[0]?.use?.baseURL as string) ?? 'http://localhost:3001';

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ baseURL, viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();

    // Generous timeouts on purpose: this runs once, and the app compiles its
    // routes on first hit, so a cold start here is normal rather than a fault.
    page.setDefaultNavigationTimeout(120_000);
    page.setDefaultTimeout(120_000);

    await page.goto('/login', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: 'Demo user' }).click();
    await page.waitForURL('**/tests', { timeout: 120_000 });

    // Wait for the shell to actually hydrate with a resolved session, not just
    // for the URL to change — a state file saved mid-login would be useless.
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 120_000 });
    await expect(page.locator('.sidebar').getByText('Demo user')).toBeVisible({ timeout: 120_000 });

    // Prove the cookies really authenticate a proxied API call before trusting them.
    const me = await page.evaluate(async () => {
      const res = await fetch('/api/auth/me');
      return res.ok ? res.json() : null;
    });
    if (!me?.user?.email) throw new Error('global-setup: signed in but /api/auth/me did not resolve');

    // Normalise the per-device preferences so no earlier run's theme or grouping
    // choice leaks in and changes what the specs see.
    await page.evaluate(() => {
      localStorage.setItem('kaizen.appearance', 'aperture');
      localStorage.setItem('kaizen.groupBySuite', '1');
    });

    await context.storageState({ path: STORAGE_STATE });
    await context.close();

    // eslint-disable-next-line no-console
    console.log(`[global-setup] signed in as ${me.user.email} (role ${me.role}); state -> ${STORAGE_STATE}`);
  } finally {
    await browser.close();
  }

  if (!fs.existsSync(STORAGE_STATE)) {
    throw new Error('global-setup: storage state file was not written');
  }
}
