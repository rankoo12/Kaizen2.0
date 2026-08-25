import { test, expect } from '@playwright/test';
import { openApp, main, gotoScreen } from './helpers';

/**
 * The Brain: every element Kaizen has learned, its scopes, confidence and
 * recall counts. This is the store that makes repeat runs cost 0 tokens.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await gotoScreen(page, 'The Brain');
  // The entry list arrives after the screen heading, so wait for real rows
  // before asserting on them.
  await expect(page.locator('div.row').first()).toBeVisible({ timeout: 30_000 });
});

const searchBox = 'input[placeholder="Search what it knows"]';

test.describe('Overview', () => {
  test('describes what it stores', async ({ page }) => {
    await expect(main(page)).toContainText(/every element kaizen has learned/i);
    await expect(main(page)).toContainText(/how much it stops you paying/i);
  });

  test('shows the reliability and volume tiles', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('reliable');
    expect(text).toContain('learned elements');
    expect(text).toContain('avg confidence');
    expect(text).toContain('recalls');
  });

  test('reports how many remembered resolutions held up', async ({ page }) => {
    await expect(main(page)).toContainText(/remembered resolutions held up/i);
  });

  test('shows the entry table columns', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('selector');
    expect(text).toContain('site');
    expect(text).toContain('scope');
    expect(text).toContain('confidence');
    expect(text).toContain('recalls');
  });

  test('lists learned entries', async ({ page }) => {
    expect(await page.locator('div.row').count()).toBeGreaterThan(0);
  });

  test('pairs a plain-English intent with a concrete selector', async ({ page }) => {
    // Entries read like "type ... in the Password field" + role=textbox[...].
    await expect(main(page)).toContainText(/role=|input|#/);
  });
});

test.describe('Scope filters', () => {
  test('"Workspace" shows only workspace-scoped entries', async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.waitForTimeout(800);

    const rows = await page.locator('div.row').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.toUpperCase()).toContain('WORKSPACE');
    }
  });

  test('"Global" shows only globally-scoped entries', async ({ page }) => {
    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.waitForTimeout(800);

    const rows = await page.locator('div.row').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.toUpperCase()).toContain('GLOBAL');
    }
  });

  test('"Needs review" shows only flagged entries', async ({ page }) => {
    await page.getByRole('button', { name: 'Needs review', exact: true }).click();
    await page.waitForTimeout(800);

    const rows = await page.locator('div.row').allInnerTexts();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.toUpperCase()).toContain('NEEDS REVIEW');
    }
  });

  test('"All" equals Workspace plus Global', async ({ page }) => {
    await page.getByRole('button', { name: 'Workspace', exact: true }).click();
    await page.waitForTimeout(800);
    const workspace = await page.locator('div.row').count();

    await page.getByRole('button', { name: 'Global', exact: true }).click();
    await page.waitForTimeout(800);
    const global = await page.locator('div.row').count();

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(800);
    const all = await page.locator('div.row').count();

    expect(all).toBe(workspace + global);
  });

  test('switching back to All widens the list again', async ({ page }) => {
    await page.getByRole('button', { name: 'Needs review', exact: true }).click();
    await page.waitForTimeout(800);
    const flagged = await page.locator('div.row').count();

    await page.getByRole('button', { name: 'All', exact: true }).click();
    await page.waitForTimeout(800);
    const all = await page.locator('div.row').count();

    expect(all).toBeGreaterThan(flagged);
  });
});

test.describe('Search', () => {
  test('filters entries by what they mean', async ({ page }) => {
    const before = await page.locator('div.row').count();

    await page.locator(searchBox).fill('Password');
    // Wait for the list to actually shrink rather than sampling mid-render.
    await expect.poll(() => page.locator('div.row').count(), { timeout: 20_000 })
      .toBeLessThan(before);

    const after = await page.locator('div.row').count();
    expect(after).toBeGreaterThan(0);

    const rows = await page.locator('div.row').allInnerTexts();
    for (const row of rows) {
      expect(row.toLowerCase()).toContain('password');
    }
  });

  test('shows an empty state and explains the resolution order', async ({ page }) => {
    await page.locator(searchBox).fill('zzzz-no-such-element-zzzz');
    await page.waitForTimeout(900);

    await expect(main(page)).toContainText(/nothing matches/i);
    // The empty state documents the cheapest-first cascade.
    await expect(main(page)).toContainText(/resolves cheapest-first/i);
    await expect(main(page)).toContainText(/only then the AI/i);
  });

  test('clearing the query restores the full list', async ({ page }) => {
    const before = await page.locator('div.row').count();

    await page.locator(searchBox).fill('zzzz-no-match-zzzz');
    await expect.poll(() => page.locator('div.row').count(), { timeout: 20_000 }).toBe(0);

    await page.locator(searchBox).fill('');
    await expect.poll(() => page.locator('div.row').count(), { timeout: 20_000 }).toBe(before);
  });
});
