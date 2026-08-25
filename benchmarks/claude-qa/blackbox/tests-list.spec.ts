import { test, expect } from '@playwright/test';
import {
  openApp,
  main,
  gotoScreen,
  createTest,
  deleteTest,
  searchTests,
  visibleTestNames,
  filterTests,
  visibleBadges,
  testRow,
  openRowMenu,
  agentName,
} from './helpers';

/**
 * The Tests screen: the list itself, its filters, search, row actions and the
 * create/edit/delete lifecycle.
 *
 * The workspace is shared and mutable (other agents add records concurrently),
 * so these tests assert on records they created and on before/after deltas —
 * never on absolute totals.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('Tests list', () => {
  test('shows the column headers', async ({ page }) => {
    const text = await main(page).innerText();
    expect(text.toLowerCase()).toContain('test');
    expect(text.toLowerCase()).toContain('memory');
    expect(text.toLowerCase()).toContain('status');
    expect(text.toLowerCase()).toContain('last run');
  });

  test('renders at least one test row', async ({ page }) => {
    await expect(page.locator('div.row-t').first()).toBeVisible({ timeout: 30_000 });
    expect(await page.locator('div.row-t').count()).toBeGreaterThan(0);
  });

  test('summarises how many tests and suites exist', async ({ page }) => {
    await expect(main(page)).toContainText(/\d+ tests? across \d+ suites?/i);
  });

  test('shows the health tiles', async ({ page }) => {
    const text = await main(page).innerText();
    expect(text).toContain('Suite health');
    expect(text).toContain('Needs a human');
    expect(text).toContain('Self-healed');
    expect(text).toContain('From memory');
  });

  test('groups rows under suite headings by default', async ({ page }) => {
    // With grouping on, suite names appear inside the list area.
    await expect(main(page)).toContainText('Checkout smoke');
  });

  test('offers the keyboard hints at the foot of the list', async ({ page }) => {
    await expect(main(page)).toContainText('open latest run');
    await expect(main(page)).toContainText('new test');
  });
});

test.describe('Search', () => {
  test('narrows the list to a matching test', async ({ page }) => {
    const name = await createTest(page, { label: 'Searchable' });
    await gotoScreen(page, 'Tests');

    const before = await visibleTestNames(page);
    expect(before.length).toBeGreaterThan(1);

    await searchTests(page, name);

    const after = await visibleTestNames(page);
    expect(after).toHaveLength(1);
    expect(after[0]).toContain(name);

    await deleteTest(page, name);
  });

  test('shows an empty state when nothing matches', async ({ page }) => {
    await searchTests(page, 'zzzz-definitely-no-such-test-zzzz');

    await expect(main(page)).toContainText(/no tests match/i);
    expect(await page.locator('div.row-t').count()).toBe(0);
  });

  test('restores the full list when the query is cleared', async ({ page }) => {
    const beforeCount = (await visibleTestNames(page)).length;

    await searchTests(page, 'zzzz-no-match-zzzz');
    expect(await page.locator('div.row-t').count()).toBe(0);

    await searchTests(page, '');
    expect((await visibleTestNames(page)).length).toBe(beforeCount);
  });

  test('matches on a partial name', async ({ page }) => {
    const name = await createTest(page, { label: 'PartialMatch' });
    await gotoScreen(page, 'Tests');

    await searchTests(page, 'PartialMatch');

    const names = await visibleTestNames(page);
    expect(names.some((n) => n.includes(name))).toBe(true);

    await deleteTest(page, name);
  });
});

test.describe('Status filters', () => {
  test('"Failing" shows only failed tests', async ({ page }) => {
    await filterTests(page, 'Failing');

    const badges = await visibleBadges(page);
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.toLowerCase()).toContain('failed');
    }
  });

  test('"Passed" shows only passing tests', async ({ page }) => {
    await filterTests(page, 'Passed');

    const badges = await visibleBadges(page);
    expect(badges.length).toBeGreaterThan(0);
    // Passed rows may additionally carry a DRAFT marker.
    for (const badge of badges) {
      expect(badge.toLowerCase()).toMatch(/passed|draft/);
    }
  });

  test('"Drafts" shows only tests Kaizen proposed', async ({ page }) => {
    await filterTests(page, 'Drafts');

    const rows = await visibleTestNames(page);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).toContain('DRAFT');
    }
  });

  test('"All" shows more rows than any single status filter', async ({ page }) => {
    await filterTests(page, 'Failing');
    const failing = await page.locator('div.row-t').count();

    await filterTests(page, 'All');
    const all = await page.locator('div.row-t').count();

    expect(all).toBeGreaterThan(failing);
  });

  test('switching filters changes the visible rows', async ({ page }) => {
    await filterTests(page, 'Failing');
    const failing = await visibleTestNames(page);

    await filterTests(page, 'Passed');
    const passed = await visibleTestNames(page);

    // The two sets must be disjoint — a test cannot be both.
    for (const name of passed) {
      expect(failing).not.toContain(name);
    }
  });

  test('the "Needs a human" tile filters the list', async ({ page }) => {
    await page.getByRole('button', { name: /Needs a human/ }).click();

    const badges = await visibleBadges(page);
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.toLowerCase()).toContain('failed');
    }
  });
});

test.describe('Creating a test', () => {
  test('saves a test and shows its detail view', async ({ page }) => {
    const name = agentName('Created');

    const created = await createTest(page, { label: 'Created' }).catch(() => null);
    expect(created).not.toBeNull();

    // A freshly created test has never run.
    await expect(main(page)).toContainText(/this test has never run/i);
    await expect(main(page)).toContainText(created!);

    await deleteTest(page, created!);
  });

  test('the new test appears in the list afterwards', async ({ page }) => {
    const name = await createTest(page, { label: 'Listed' });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(1);

    await deleteTest(page, name);
  });

  test('a new test starts with PENDING status and no run history', async ({ page }) => {
    const name = await createTest(page, { label: 'Pending' });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    const row = testRow(page, name);
    await expect(row).toContainText(/pending/i);
    await expect(row).toContainText(/never/i);

    await deleteTest(page, name);
  });

  test('persists the target URL that was entered', async ({ page }) => {
    const name = await createTest(page, {
      label: 'WithUrl',
      url: 'https://the-internet.herokuapp.com/login',
    });

    await expect(main(page)).toContainText(/the-internet\.herokuapp\.com/i);

    await deleteTest(page, name);
  });

  test('saves a multi-step test with all its steps', async ({ page }) => {
    const name = await createTest(page, {
      label: 'MultiStep',
      url: 'https://the-internet.herokuapp.com/login',
      steps: [
        'navigate to https://the-internet.herokuapp.com/login',
        'type "tomsmith" in the Username field',
        'verify the page contains "Login Page"',
      ],
    });

    // Re-open the editor and confirm every step survived the round-trip.
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await openRowMenu(page, name);
    await page.getByRole('button', { name: /Edit steps/i }).click();
    await expect(main(page)).toContainText(/editing the steps/i);

    const text = await main(page).innerText();
    expect(text).toContain('tomsmith');
    expect(text).toContain('Login Page');

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await deleteTest(page, name);
  });

  test('places the test in the suite that was chosen', async ({ page }) => {
    const name = await createTest(page, { label: 'InDemo', suite: 'Demo' });

    await gotoScreen(page, 'Tests');
    await page.getByRole('button', { name: /^Demo/ }).first().click();
    await expect(main(page)).toContainText('Demo');

    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(1);

    await deleteTest(page, name);
  });
});

test.describe('Row actions', () => {
  test('the overflow menu offers every row action', async ({ page }) => {
    const name = await createTest(page, { label: 'RowMenu' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await openRowMenu(page, name);

    await expect(page.getByRole('button', { name: /Open latest run/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Run now/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Edit steps/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Delete test$/ })).toBeVisible();

    await page.keyboard.press('Escape');
    await deleteTest(page, name);
  });

  test('"Edit steps" opens the editor pre-filled and keeps history', async ({ page }) => {
    const name = await createTest(page, { label: 'Editable' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await openRowMenu(page, name);
    await page.getByRole('button', { name: /Edit steps/i }).click();

    await expect(main(page)).toContainText(/editing the steps/i);
    await expect(main(page)).toContainText(/run history and learned selectors are kept/i);
    await expect(page.locator('main input').first()).toHaveValue(name);

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await deleteTest(page, name);
  });

  test('editing a test adds the new step to it', async ({ page }) => {
    const name = await createTest(page, { label: 'EditAdds' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await openRowMenu(page, name);
    await page.getByRole('button', { name: /Edit steps/i }).click();
    await expect(main(page)).toContainText(/editing the steps/i);

    const patch = page.waitForResponse(
      (r) => r.url().includes('/api/proxy/cases/') && r.request().method() === 'PATCH',
    );
    await page.locator('main div.row').filter({ hasText: 'Add a step' }).last().click();
    await page.locator('main input').nth(3).fill('verify the page contains "Example Domain"');
    await page.getByRole('button', { name: 'Save', exact: true }).click();

    // The edit is persisted as a PATCH, not a re-create.
    const body = (await patch).request().postData() ?? '';
    expect(body).toContain('Example Domain');

    await deleteTest(page, name);
  });
});

test.describe('Deleting a test', () => {
  test('asks for confirmation naming the test', async ({ page }) => {
    const name = await createTest(page, { label: 'ConfirmDelete' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await openRowMenu(page, name);
    await page.getByRole('button', { name: /^Delete test$/ }).click();

    await expect(page.locator('body')).toContainText(name);
    await expect(page.locator('body')).toContainText(/this can’t be undone/i);
    await expect(page.locator('body')).toContainText(/run history and its learned selectors/i);

    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
    await deleteTest(page, name);
  });

  test('Cancel keeps the test', async ({ page }) => {
    const name = await createTest(page, { label: 'KeepMe' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);

    await openRowMenu(page, name);
    await page.getByRole('button', { name: /^Delete test$/ }).click();
    await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();

    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(1);

    await deleteTest(page, name);
  });

  test('confirming removes the test from the list', async ({ page }) => {
    const name = await createTest(page, { label: 'RemoveMe' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(1);

    await openRowMenu(page, name);
    await page.getByRole('button', { name: /^Delete test$/ }).click();

    const del = page.waitForResponse(
      (r) => r.url().includes('/api/proxy/cases/') && r.request().method() === 'DELETE',
    );
    await page.getByRole('button', { name: /^Delete test$/ }).last().click();

    expect((await del).status()).toBe(204);
    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(0);
  });

  test('a deleted test stays gone after a reload', async ({ page }) => {
    const name = await createTest(page, { label: 'GoneForGood' });
    await deleteTest(page, name);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await openApp(page);
    await searchTests(page, name);

    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(0);
  });
});
