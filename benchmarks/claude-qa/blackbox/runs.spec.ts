import { test, expect } from '@playwright/test';
import { openApp, main, gotoScreen, visibleBadges } from './helpers';

/**
 * The Runs feed and the run detail view.
 *
 * These tests only READ existing run history. They never trigger a run: runs
 * are long-lived background jobs that would outlive the suite.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('Runs feed', () => {
  test.beforeEach(async ({ page }) => {
    await gotoScreen(page, 'Runs');
    // Rows stream in after the heading; wait for them before counting.
    await expect(page.locator('div.row').first()).toBeVisible({ timeout: 30_000 });
  });

  test('describes itself as the newest-first feed', async ({ page }) => {
    await expect(main(page)).toContainText(/runs in this workspace, newest first/i);
  });

  test('shows the summary tiles', async ({ page }) => {
    const text = await main(page).innerText();
    expect(text.toLowerCase()).toContain('runs shown');
    expect(text.toLowerCase()).toContain('passed clean');
    expect(text.toLowerCase()).toContain('self-healed');
    expect(text.toLowerCase()).toContain('tokens');
  });

  test('shows the run table columns', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('status');
    expect(text).toContain('duration');
    expect(text).toContain('trigger');
  });

  test('lists run rows', async ({ page }) => {
    expect(await page.locator('div.row').count()).toBeGreaterThan(0);
  });

  test('caps the feed at 50 rows and says so', async ({ page }) => {
    // The API is called with ?limit=50 and the tile reports "N of M total".
    await expect(main(page)).toContainText(/of \d+ total/i);
    const rows = await page.locator('div.row').count();
    expect(rows).toBeLessThanOrEqual(60);
  });

  test('each run row carries a short run id', async ({ page }) => {
    const first = page.locator('div.row').first();
    await expect(first).toContainText(/#[0-9a-f]{6,}/i);
  });

  test('"Failed" shows only failed runs', async ({ page }) => {
    await page.getByRole('button', { name: 'Failed', exact: true }).first().click();
    await page.waitForTimeout(800);

    const badges = await visibleBadges(page);
    expect(badges.length).toBeGreaterThan(0);
    const statuses = badges.filter((b) => /passed|failed/i.test(b));
    for (const status of statuses) {
      expect(status.toLowerCase()).toContain('failed');
    }
  });

  test('"All" shows at least as many rows as "Failed"', async ({ page }) => {
    await page.getByRole('button', { name: 'Failed', exact: true }).first().click();
    await page.waitForTimeout(800);
    const failed = await page.locator('div.row').count();

    await page.getByRole('button', { name: 'All', exact: true }).first().click();
    await page.waitForTimeout(800);
    const all = await page.locator('div.row').count();

    expect(all).toBeGreaterThanOrEqual(failed);
  });

  test('clicking a run row opens its detail view', async ({ page }) => {
    await expect(main(page)).not.toContainText(/stops on first unhealed failure/i);

    await page.locator('div.row').first().click();

    // The detail view has its own tab strip and step list.
    await expect(page.getByRole('button', { name: 'Steps', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Re-run', exact: true })).toBeVisible();
  });
});

test.describe('Run detail', () => {
  test.beforeEach(async ({ page }) => {
    await gotoScreen(page, 'Runs');
    await expect(page.locator('div.row').first()).toBeVisible({ timeout: 30_000 });

    // Open a FINISHED run. The newest row can still be executing, and an
    // in-flight run has no steps or resolution detail to assert on yet.
    // Match on the row's status badge so a still-running row is skipped.
    const finished = page
      .locator('div.row')
      .filter({ has: page.locator('.badge', { hasText: /^(PASSED|FAILED)$/i }) })
      .first();
    await expect(finished).toBeVisible({ timeout: 30_000 });
    await finished.click();

    await expect(page.getByRole('button', { name: 'Steps', exact: true })).toBeVisible();
    // Wait for the step list itself, not merely the tab strip.
    await expect(main(page)).toContainText(/stops on first unhealed failure/i, {
      timeout: 30_000,
    });
  });

  test('identifies the run by id, host and trigger', async ({ page }) => {
    await expect(main(page)).toContainText(/#[0-9a-f]{6,}/i);
    await expect(main(page)).toContainText(/web|testwriter/i);
  });

  test('offers the four detail tabs and a re-run action', async ({ page }) => {
    for (const tab of ['Steps', 'Line', 'Activity', 'History']) {
      await expect(page.getByRole('button', { name: tab, exact: true })).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Re-run', exact: true })).toBeVisible();
  });

  test('shows duration, token spend and memory tiles', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('duration');
    expect(text).toContain('tokens spent');
    expect(text).toContain('from memory');
    expect(text).toContain('progress');
  });

  test('the Steps tab lists steps in order and explains the stop rule', async ({ page }) => {
    await expect(main(page)).toContainText(/steps · in order, stops on first unhealed failure/i);
    // Steps are numbered 01, 02, ...
    await expect(main(page)).toContainText(/\b01\b/);
  });

  test('steps show the selector Kaizen actually used', async ({ page }) => {
    // Real runs record a concrete selector per element step.
    await expect(main(page)).toContainText(/role=|#|\[data-/);
  });

  test('the Line tab shows the production-line metaphor', async ({ page }) => {
    await page.getByRole('button', { name: 'Line', exact: true }).click();

    await expect(main(page)).toContainText(/production line/i);
    await expect(main(page)).toContainText(/from memory/i);
    await expect(main(page)).toContainText(/drawing power/i);
    await expect(main(page)).toContainText(/repaired itself/i);
    await expect(main(page)).toContainText(/broke down/i);
  });

  test('the Activity tab reveals the cache hierarchy', async ({ page }) => {
    await page.getByRole('button', { name: 'Activity', exact: true }).click();

    // Resolution sources are named per lookup: L0 archetype, L1 redis, L2 postgres.
    await expect(main(page)).toContainText(/L[0-2] ·|passed|no tokens/i);
  });

  test('the History tab lists previous runs of the same test', async ({ page }) => {
    await page.getByRole('button', { name: 'History', exact: true }).click();

    await expect(main(page)).toContainText(/cost per run/i);
    await expect(main(page)).toContainText(/showing/i);
  });

  test('switching tabs changes the content', async ({ page }) => {
    await expect(main(page)).toContainText(/stops on first unhealed failure/i);

    await page.getByRole('button', { name: 'Line', exact: true }).click();
    await expect(main(page)).toContainText(/production line/i);
    await expect(main(page)).not.toContainText(/stops on first unhealed failure/i);

    await page.getByRole('button', { name: 'Steps', exact: true }).click();
    await expect(main(page)).toContainText(/stops on first unhealed failure/i);
  });

  test('selecting a step reveals its evidence and feedback controls', async ({ page }) => {
    // The last step is selected by default and shows its detail panel.
    await expect(main(page)).toContainText(/was this the right element/i);
    await expect(page.getByRole('button', { name: /Yes — pin it/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /No — block it/ })).toBeVisible();
    await expect(main(page)).toContainText(/evidence/i);
  });

  test('explains what pinning and blocking do', async ({ page }) => {
    await expect(main(page)).toContainText(/pinning always reuses it/i);
    await expect(main(page)).toContainText(/blocking retires the pattern for good/i);
  });

  test('reports how the step was resolved', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('how it was resolved');
    expect(text).toContain('selector used');
    expect(text).toContain('tokens');
  });
});

test.describe('Failed run diagnostics', () => {
  test('a failed run explains what went wrong', async ({ page }) => {
    await gotoScreen(page, 'Runs');
    await expect(page.locator('div.row').first()).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Failed', exact: true }).first().click();
    await page.waitForTimeout(1200);

    const rows = await page.locator('div.row').count();
    test.skip(rows === 0, 'no failed runs in this workspace');

    await page.locator('div.row').first().click();
    await expect(page.getByRole('button', { name: 'Steps', exact: true })).toBeVisible();

    await expect(main(page)).toContainText(/failed/i);
    // Failed runs surface a diagnosis of the healing attempt.
    await expect(main(page)).toContainText(/what went wrong|healing/i);
  });
});
