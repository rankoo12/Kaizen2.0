import { test, expect } from '@playwright/test';
import {
  openApp,
  main,
  sidebar,
  gotoScreen,
  openComposer,
  composer,
  setInput,
  agentName,
  createTest,
  deleteTest,
  searchTests,
} from './helpers';

/**
 * Suites: creation from the composer, selection, and scoping the Tests screen.
 *
 * Suites cannot be deleted through the UI, so these tests create as few as
 * possible and always name them with the AGENT-A prefix so they are traceable.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('Suite picker in the composer', () => {
  test('lists the existing suites', async ({ page }) => {
    await openComposer(page);

    const options = await composer.suiteSelect(page).locator('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(1);
    expect(options.join(' | ')).toContain('Demo');
  });

  test('the "+" button swaps the picker for a name field', async ({ page }) => {
    await openComposer(page);
    await expect(composer.suiteSelect(page)).toBeVisible();

    await composer.newSuiteButton(page).click();

    await expect(composer.newSuiteInput(page)).toBeVisible();
    await expect(composer.suiteSelect(page)).toHaveCount(0);
  });

  test('pressing Enter creates the suite and selects it', async ({ page }) => {
    const suiteName = agentName('Suite');
    await openComposer(page);
    await composer.newSuiteButton(page).click();

    const created = page.waitForResponse(
      (r) =>
        r.url().endsWith('/api/proxy/suites') &&
        r.request().method() === 'POST',
    );
    await setInput(composer.newSuiteInput(page), suiteName);
    await composer.newSuiteInput(page).press('Enter');

    // The suite is really created server-side...
    const body = (await created).request().postData() ?? '';
    expect(body).toContain(suiteName);

    // ...the field reverts to a picker with the new suite selected...
    await expect(composer.suiteSelect(page)).toBeVisible();
    await expect(composer.suiteSelect(page).locator('option:checked')).toHaveText(suiteName);

    // ...and it shows up in the sidebar.
    await expect(sidebar(page)).toContainText(suiteName);
  });

  test('a suite created this way accepts a new test', async ({ page }) => {
    const suiteName = agentName('Suite');
    await openComposer(page);
    await composer.newSuiteButton(page).click();
    await setInput(composer.newSuiteInput(page), suiteName);
    await composer.newSuiteInput(page).press('Enter');
    await expect(composer.suiteSelect(page)).toBeVisible();

    const testName = agentName('InNewSuite');
    await setInput(composer.name(page), testName);
    await setInput(composer.url(page), 'https://example.com');
    await setInput(composer.step(page, 0), 'navigate to https://example.com');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(main(page)).toContainText(testName);

    // The suite now reports one test.
    await gotoScreen(page, 'Tests');
    await page.getByRole('button', { name: new RegExp(`^${suiteName}`) }).first().click();
    await expect(page.locator('div.row-t').filter({ hasText: testName })).toHaveCount(1);

    await deleteTest(page, testName);
  });

  /**
   * BUG: typing a new suite name and blurring (instead of pressing Enter)
   * silently discards it — no POST /suites is issued and the test is saved
   * into whichever suite happens to be first in the list.
   *
   * This test pins the CORRECT behaviour and is expected to fail until fixed.
   */
  test.fail('blurring a new suite name should not silently discard it', async ({ page }) => {
    const suiteName = agentName('BlurSuite');
    await openComposer(page);
    await composer.newSuiteButton(page).click();
    await setInput(composer.newSuiteInput(page), suiteName);

    // Move focus away without pressing Enter.
    await composer.name(page).click();
    await page.waitForTimeout(1_000);

    // Either the suite was created, or the picker still holds the typed name —
    // what must NOT happen is the name vanishing without a trace.
    await expect(sidebar(page)).toContainText(suiteName);
  });
});

test.describe('Suite scoping on the Tests screen', () => {
  test('selecting a suite filters the list to its tests', async ({ page }) => {
    await page.getByRole('button', { name: /^Checkout smoke/ }).first().click();

    await expect(main(page)).toContainText('Checkout smoke');
    // A suite-scoped view offers running the whole suite.
    await expect(page.getByRole('button', { name: 'Run suite', exact: true })).toBeVisible();
  });

  test('a suite-scoped view reports what Kaizen knows about the app', async ({ page }) => {
    await page.getByRole('button', { name: /^Checkout smoke/ }).first().click();

    await expect(main(page)).toContainText(/what kaizen knows about this app/i);
    await expect(main(page)).toContainText(/known pages have a test/i);
  });

  test('a test created in one suite does not appear under another', async ({ page }) => {
    const name = await createTest(page, { label: 'SuiteIsolated', suite: 'Demo' });

    await gotoScreen(page, 'Tests');
    await page.getByRole('button', { name: /^Checkout smoke/ }).first().click();
    await expect(main(page)).toContainText('Checkout smoke');

    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(0);

    await deleteTest(page, name);
  });

  test('the sidebar count for a suite grows when a test is added to it', async ({ page }) => {
    const suiteButton = page.getByRole('button', { name: /^Demo/ }).first();
    const before = (await suiteButton.innerText()).match(/(\d+)\s*$/)?.[1];

    const name = await createTest(page, { label: 'CountsUp', suite: 'Demo' });
    await gotoScreen(page, 'Tests');

    const after = (await page.getByRole('button', { name: /^Demo/ }).first().innerText())
      .match(/(\d+)\s*$/)?.[1];

    expect(Number(after)).toBeGreaterThan(Number(before));

    await deleteTest(page, name);
  });

  test('returning to Tests clears the suite scope', async ({ page }) => {
    await page.getByRole('button', { name: /^Checkout smoke/ }).first().click();
    await expect(page.getByRole('button', { name: 'Run suite', exact: true })).toBeVisible();

    await gotoScreen(page, 'Tests');

    await expect(main(page)).toContainText(/tests across/i);
    await expect(page.getByRole('button', { name: 'Run suite', exact: true })).toHaveCount(0);
  });
});
