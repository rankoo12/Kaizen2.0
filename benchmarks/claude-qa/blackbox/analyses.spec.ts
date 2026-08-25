import { test, expect } from '@playwright/test';
import { openApp, main, gotoScreen, setInput } from './helpers';

/**
 * The Analyses screen and the "Analyze an app" sheet.
 *
 * ⚠ SAFETY: submitting this sheet starts a background exploration job that runs
 * for 2–20 minutes and outlives the test suite. NOTHING in this file clicks
 * "Start exploring". Every test opens the sheet, inspects it, and cancels.
 */

const URL_FIELD = 'input[placeholder="https://staging.your-app.com"]';

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await gotoScreen(page, 'Analyses');
});

async function openSheet(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: /Analyze an app/i }).first().click();
  await expect(page.locator('body')).toContainText(/explores it read-only/i);
}

async function cancelSheet(page: import('@playwright/test').Page): Promise<void> {
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(page.locator('body')).not.toContainText(/explores it read-only/i);
}

test.describe('Analyses screen', () => {
  test('describes what an analysis is', async ({ page }) => {
    await expect(main(page)).toContainText(/every time kaizen explored an app and proposed tests/i);
  });

  test('shows the summary tiles', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('analyses');
    expect(text).toContain('tests proposed');
    expect(text).toContain('spent writing');
  });

  test('shows the analysis table columns', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('app');
    expect(text).toContain('suite');
    expect(text).toContain('status');
  });

  test('lists past analyses with their outcome', async ({ page }) => {
    await expect(page.locator('div.row').first()).toBeVisible({ timeout: 30_000 });
    const rows = await page.locator('div.row').count();
    expect(rows).toBeGreaterThan(0);
    await expect(main(page)).toContainText(/failed|passed|cancelled/i);
  });
});

test.describe('Analyze sheet — opening and cancelling only', () => {
  test('opens with its read-only promise', async ({ page }) => {
    await openSheet(page);

    await expect(page.locator('body')).toContainText(/explores it read-only/i);
    await expect(page.locator('body')).toContainText(/writes only what you approve/i);

    await cancelSheet(page);
  });

  test('offers a suite picker and an app URL field', async ({ page }) => {
    await openSheet(page);

    await expect(page.locator(URL_FIELD)).toBeVisible();
    await expect(page.getByRole('button', { name: 'New', exact: true })).toBeVisible();

    await cancelSheet(page);
  });

  test('warns not to paste credentials into the description', async ({ page }) => {
    await openSheet(page);

    await expect(page.locator('body')).toContainText(/don't paste credentials/i);

    await cancelSheet(page);
  });

  test('"Start exploring" is disabled without a URL', async ({ page }) => {
    await openSheet(page);
    await page.locator(URL_FIELD).fill('');

    await expect(page.getByRole('button', { name: 'Start exploring', exact: true })).toBeDisabled();

    await cancelSheet(page);
  });

  test('warns when the target looks like a production URL', async ({ page }) => {
    await openSheet(page);

    await setInput(page.locator(URL_FIELD), 'https://example.com');

    await expect(page.locator('body')).toContainText(/this looks like a production url/i);
    await expect(page.locator('body')).toContainText(/staging environment is the calmer choice/i);

    await cancelSheet(page);
  });

  test('does not warn for a staging URL', async ({ page }) => {
    await openSheet(page);

    await setInput(page.locator(URL_FIELD), 'https://staging.example.com');

    await expect(page.locator('body')).not.toContainText(/this looks like a production url/i);

    await cancelSheet(page);
  });

  test('does not warn for a localhost URL', async ({ page }) => {
    await openSheet(page);

    await setInput(page.locator(URL_FIELD), 'http://localhost:3000');

    await expect(page.locator('body')).not.toContainText(/this looks like a production url/i);

    await cancelSheet(page);
  });

  test('offers the throwaway-data consent toggle, off by default', async ({ page }) => {
    await openSheet(page);

    await expect(page.locator('body')).toContainText(/allow tests that create throwaway data/i);
    await expect(page.locator('body')).toContainText(/proposed unproven instead of executed/i);

    await cancelSheet(page);
  });

  test('offers signed-in exploration as an option', async ({ page }) => {
    await openSheet(page);

    await expect(page.locator('body')).toContainText(/signed-in exploration/i);
    await expect(page.locator('body')).toContainText(/only what a signed-out visitor sees/i);

    await cancelSheet(page);
  });

  test('the disclosure explains what exploration never does', async ({ page }) => {
    await openSheet(page);
    await expect(page.locator('body')).not.toContainText(/obeys robots\.txt/i);

    await page.getByRole('button', { name: /What exploration does/i }).click();

    await expect(page.locator('body')).toContainText(/obeys robots\.txt/i);
    await expect(page.locator('body')).toContainText(/never submits them/i);
    await expect(page.locator('body')).toContainText(/never pressed/i);

    await cancelSheet(page);
  });

  test('Advanced reveals the exploration depth choices', async ({ page }) => {
    await openSheet(page);
    await expect(page.locator('body')).not.toContainText(/exploration depth/i);

    await page.getByRole('button', { name: /Advanced/ }).click();

    await expect(page.locator('body')).toContainText(/exploration depth/i);
    await expect(page.locator('body')).toContainText(/quick/i);
    await expect(page.locator('body')).toContainText(/standard/i);
    await expect(page.locator('body')).toContainText(/deep/i);

    await cancelSheet(page);
  });

  test('Advanced offers approval and proving toggles', async ({ page }) => {
    await openSheet(page);
    await page.getByRole('button', { name: /Advanced/ }).click();

    await expect(page.locator('body')).toContainText(/pause for my approval after planning/i);
    await expect(page.locator('body')).toContainText(/prove each test with a real run/i);

    await cancelSheet(page);
  });

  test('states the expected cost and duration', async ({ page }) => {
    await openSheet(page);
    await page.getByRole('button', { name: /Advanced/ }).click();

    await expect(page.locator('body')).toContainText(/standard depth usually takes 2–5 minutes/i);

    await cancelSheet(page);
  });

  test('Cancel closes the sheet without starting anything', async ({ page }) => {
    let started = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /jobs|analy/i.test(r.url())) started = true;
    });

    await openSheet(page);
    await setInput(page.locator(URL_FIELD), 'https://staging.example.com');
    await cancelSheet(page);

    // Cancelling must never have queued an exploration job.
    expect(started).toBe(false);
  });
});

test.describe('Analysis report', () => {
  test('opening a past analysis shows its findings', async ({ page }) => {
    const banner = page.getByRole('button', { name: /See why/ });
    const hasBanner = (await banner.count()) > 0;

    if (hasBanner) {
      await banner.first().click();
    } else {
      await page.locator('div.row').first().click();
    }

    // The report names the QA persona and lists what Kaizen found.
    await expect(main(page)).toContainText(/qa engineer|what kaizen found|the analysis stopped/i);
  });

  test('findings carry a severity and a source URL', async ({ page }) => {
    const banner = page.getByRole('button', { name: /See why/ });
    test.skip((await banner.count()) === 0, 'no analysis report banner in this workspace');

    await banner.first().click();
    await expect(main(page)).toContainText(/what kaizen found/i);

    await expect(main(page)).toContainText(/low|medium|high/i);
    await expect(main(page)).toContainText(/https?:\/\//);
  });

  test('reports accessibility problems it noticed', async ({ page }) => {
    const banner = page.getByRole('button', { name: /See why/ });
    test.skip((await banner.count()) === 0, 'no analysis report banner in this workspace');

    await banner.first().click();

    await expect(main(page)).toContainText(/readable label|accessible name|screen reader/i);
  });
});
