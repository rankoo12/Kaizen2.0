import { test, expect } from '@playwright/test';
import {
  signIn, waitForTestsLoaded, gotoScreen, openAuthor, nameField, urlField, stepInputs,
  readSteps, writeSteps, fillAuthorForm, createTest, deleteTest, searchTests, rowByName,
  openRowMenu, expectToast, uniqueName, createSuite, openSuite, testRows, suiteSelect,
} from './helpers';

/**
 * The create / read / update / delete lifecycle for suites and tests, asserted
 * through observable outcomes: the row appears in the list, the edit screen
 * reloads what was saved, the delete confirmation removes it for good.
 *
 * Everything created here carries the AGENT-B prefix and is cleaned up by its
 * own test, so a full run leaves the workspace as it found it.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.describe('suite creation from the sidebar', () => {
  test('the + button opens an inline name field, focused', async ({ page }) => {
    await page.locator('.sidebar button[title="New suite"]').click();
    const input = page.getByPlaceholder('New suite name');
    await expect(input).toBeVisible();
    await expect(input).toBeFocused();
  });

  test('Escape abandons naming without creating anything', async ({ page }) => {
    const before = await page.locator('.sidebar .side-item[style*="padding-left: 26px"]').count();
    await page.locator('.sidebar button[title="New suite"]').click();
    const input = page.getByPlaceholder('New suite name');
    await input.fill('AGENT-B never created');
    await input.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(page.locator('.sidebar .side-item[style*="padding-left: 26px"]')).toHaveCount(before);
  });

  test('blurring an empty field quietly abandons naming', async ({ page }) => {
    await page.locator('.sidebar button[title="New suite"]').click();
    await expect(page.getByPlaceholder('New suite name')).toBeVisible();
    await page.locator('main').click({ position: { x: 500, y: 500 } });
    await expect(page.getByPlaceholder('New suite name')).toHaveCount(0);
  });

  test('Enter creates the suite, announces it and lists it in the sidebar', async ({ page }) => {
    const name = uniqueName('Suite');
    await page.locator('.sidebar button[title="New suite"]').click();
    const input = page.getByPlaceholder('New suite name');
    await input.fill(name);
    await input.press('Enter');
    await expectToast(page, new RegExp(`suite.*${name}.*created`, 'i'));
    await expect(page.locator('.sidebar .side-item').filter({ hasText: name })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('a new suite starts with a zero case count', async ({ page }) => {
    const name = uniqueName('Suite');
    await createSuite(page, name);
    const row = page.locator('.sidebar .side-item').filter({ hasText: name });
    await expect(row.locator('.side-count')).toHaveText('0');
  });

  test('a new suite raises the suite total in the toolbar subtitle', async ({ page }) => {
    const before = Number(
      /tests across (\d+) suites/i.exec(await page.locator('.toolbar-sub').first().innerText())?.[1] ?? '0',
    );
    await createSuite(page, uniqueName('Suite'));
    await gotoScreen(page, 'Tests');
    await expect(page.locator('.toolbar-sub').first())
      .toHaveText(new RegExp(`tests across ${before + 1} suites`, 'i'), { timeout: 20_000 });
  });

  test('a new suite becomes selectable in the author screen picker', async ({ page }) => {
    const name = uniqueName('Suite');
    await createSuite(page, name);
    await openAuthor(page);
    await expect(suiteSelect(page).locator('option').filter({ hasText: name })).toHaveCount(1);
  });

  test('the naming field closes once the suite is created', async ({ page }) => {
    const name = uniqueName('Suite');
    await createSuite(page, name);
    await expect(page.getByPlaceholder('New suite name')).toHaveCount(0);
  });
});

test.describe('creating a test', () => {
  test('a saved test announces itself and opens its run screen', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /test saved/i);
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
    await deleteTest(page, name);
  });

  test('a brand new test reports honestly that it has never run', async ({ page }) => {
    const name = await createTest(page);
    await expect(page.locator('main')).toContainText('This test has never run');
    await expect(page.locator('main')).toContainText(
      'Run it once and every step, selector and screenshot shows up here.',
    );
    await deleteTest(page, name);
  });

  test('the saved test appears in the Tests list', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(rowByName(page, name)).toBeVisible();
    await deleteTest(page, name);
  });

  test('a never-run test shows PENDING and "never" in its row', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const row = rowByName(page, name);
    await expect(row).toContainText(/pending/i);
    await expect(row).toContainText('never');
    await deleteTest(page, name);
  });

  test('a new test records the demo user as its author', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(rowByName(page, name)).toContainText('Demo user');
    await deleteTest(page, name);
  });

  test('a new test displays its base URL without the scheme', async ({ page }) => {
    const name = await createTest(page, { url: 'https://example.com' });
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const row = rowByName(page, name);
    await expect(row).toContainText('example.com');
    await expect(row.locator('.row-s')).not.toContainText('https://');
    await deleteTest(page, name);
  });

  test('a test saved into a chosen suite lands in that suite', async ({ page }) => {
    const suite = uniqueName('Suite');
    await createSuite(page, suite);
    await openSuite(page, suite);
    await page.getByRole('button', { name: 'New Test', exact: true }).first().click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
    // Opening the author screen from a suite preselects that suite.
    await expect(suiteSelect(page).locator('option:checked')).toHaveText(suite);

    const name = uniqueName('Test');
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await openSuite(page, suite);
    await expect(testRows(page)).toHaveCount(1);
    await expect(testRows(page).first()).toContainText(name);
    await deleteTest(page, name);
  });

  test('adding a test raises that suite\'s sidebar count', async ({ page }) => {
    const suite = uniqueName('Suite');
    await createSuite(page, suite);
    const row = page.locator('.sidebar .side-item').filter({ hasText: suite });
    await expect(row.locator('.side-count')).toHaveText('0');

    await openSuite(page, suite);
    await page.getByRole('button', { name: 'New Test', exact: true }).first().click();
    const name = uniqueName('Test');
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await expect(page.locator('.sidebar .side-item').filter({ hasText: suite }).locator('.side-count'))
      .toHaveText('1', { timeout: 20_000 });
    await deleteTest(page, name);
  });

  test('creating a test raises the workspace case count', async ({ page }) => {
    const before = Number(
      await page.locator('.side-item').filter({ hasText: 'Tests' }).first().locator('.side-count').innerText(),
    );
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await expect(page.locator('.side-item').filter({ hasText: 'Tests' }).first().locator('.side-count'))
      .toHaveText(String(before + 1), { timeout: 20_000 });
    await deleteTest(page, name);
  });

  test('multi-step tests keep their step order', async ({ page }) => {
    const name = uniqueName('Test');
    const steps = [
      'navigate to https://example.com',
      'click the More information link',
      'verify the page contains "IANA"',
    ];
    await openAuthor(page);
    await fillAuthorForm(page, { name, url: 'https://example.com', steps });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
    await expect(stepInputs(page)).toHaveCount(3, { timeout: 20_000 });
    expect(await readSteps(page)).toEqual(steps);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('blank steps are dropped rather than saved as empty steps', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name,
      url: 'https://example.com',
      steps: ['navigate to https://example.com', '    ', 'verify the page contains "Example"'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(2, { timeout: 30_000 });
    expect(await readSteps(page)).toEqual([
      'navigate to https://example.com',
      'verify the page contains "Example"',
    ]);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('the name is trimmed before it is saved', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await nameField(page).fill(`   ${name}   `);
    await urlField(page).fill('https://example.com');
    await writeSteps(page, ['navigate to https://example.com']);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    // The run-screen title is the stored name, so a trimmed title proves the trim.
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
    await deleteTest(page, name);
  });
});

test.describe('editing a test', () => {
  test('Edit steps loads the stored name, URL and steps', async ({ page }) => {
    const name = uniqueName('Test');
    const steps = ['navigate to https://example.com', 'verify the page contains "Example Domain"'];
    await openAuthor(page);
    await fillAuthorForm(page, { name, url: 'https://example.com', steps });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();

    await expect(nameField(page)).toHaveValue(name, { timeout: 30_000 });
    await expect(urlField(page)).toHaveValue('https://example.com');
    expect(await readSteps(page)).toEqual(steps);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('edit mode titles itself with the test name and explains what is kept', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Editing the steps\. Run history and learned selectors are kept\./i);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('an added step is persisted and visible on reopen', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com',
      steps: ['navigate to https://example.com', 'verify the page contains "Example Domain"'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    // Edit: append a third step.
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    let menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(2, { timeout: 30_000 });
    await page.locator('.list .row').filter({ hasText: 'Add a step' }).click();
    await stepInputs(page).nth(2).fill('wait 1 second');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    // Reopen and confirm all three survived, in order.
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(3, { timeout: 30_000 });
    expect(await readSteps(page)).toEqual([
      'navigate to https://example.com',
      'verify the page contains "Example Domain"',
      'wait 1 second',
    ]);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('a removed step is persisted as removed', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com',
      steps: ['navigate to https://example.com', 'wait 1 second', 'verify the page contains "Example"'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    let menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(3, { timeout: 30_000 });
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(1).locator('button[title="Remove"]').click();
    await expect(stepInputs(page)).toHaveCount(2);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(2, { timeout: 30_000 });
    expect(await readSteps(page)).toEqual([
      'navigate to https://example.com',
      'verify the page contains "Example"',
    ]);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('a reordered step list is persisted in the new order', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com',
      steps: ['navigate to https://example.com', 'wait 1 second', 'wait 2 seconds'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    let menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(3, { timeout: 30_000 });
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(2).locator('button[title="Move up"]').click();
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(3, { timeout: 30_000 });
    expect(await readSteps(page)).toEqual([
      'navigate to https://example.com',
      'wait 2 seconds',
      'wait 1 second',
    ]);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('renaming a test updates the row in the list', async ({ page }) => {
    const name = uniqueName('Test');
    const renamed = `${name} renamed`;
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(nameField(page)).toHaveValue(name, { timeout: 30_000 });
    await nameField(page).fill(renamed);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    await gotoScreen(page, 'Tests');
    await searchTests(page, renamed);
    await expect(rowByName(page, renamed)).toBeVisible({ timeout: 20_000 });
    await deleteTest(page, renamed);
  });

  test('changing the target URL updates the row sub-line', async ({ page }) => {
    const name = uniqueName('Test');
    await openAuthor(page);
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(urlField(page)).toHaveValue('https://example.com', { timeout: 30_000 });
    await urlField(page).fill('https://iana.org');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(rowByName(page, name)).toContainText('iana.org', { timeout: 20_000 });
    await deleteTest(page, name);
  });

  test('cancelling an edit discards the change', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(nameField(page)).toHaveValue(name, { timeout: 30_000 });
    await nameField(page).fill(`${name} DISCARDED`);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');

    await searchTests(page, name);
    await expect(rowByName(page, name)).toBeVisible();
    await searchTests(page, 'DISCARDED');
    await expect(testRows(page)).toHaveCount(0);
    await deleteTest(page, name);
  });

  test('editing a test does not create a second copy of it', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(testRows(page)).toHaveCount(1);

    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Edit steps' }).click();
    await expect(stepInputs(page)).toHaveCount(1, { timeout: 30_000 });
    await page.locator('.list .row').filter({ hasText: 'Add a step' }).click();
    await stepInputs(page).nth(1).fill('wait 1 second');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /changes saved/i);

    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    await expect(testRows(page)).toHaveCount(1, { timeout: 20_000 });
    await deleteTest(page, name);
  });
});

test.describe('deleting a test', () => {
  test('the confirmation names the test and warns it is irreversible', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();

    const sheet = page.locator('.sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText(name);
    await expect(sheet).toContainText(
      'The test, its run history and its learned selectors are removed for everyone in the workspace.',
    );
    await expect(sheet).toContainText("This can’t be undone.");
    await sheet.getByRole('button', { name: 'Cancel' }).click();
    await deleteTest(page, name);
  });

  test('the confirmation offers exactly Cancel and Delete test', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
    await expect(page.locator('.sheet button')).toHaveText(['Cancel', 'Delete test']);
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
    await deleteTest(page, name);
  });

  test('cancelling the confirmation keeps the test', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.sheet')).toHaveCount(0);
    await searchTests(page, name);
    await expect(rowByName(page, name)).toBeVisible();
    await deleteTest(page, name);
  });

  test('Escape dismisses the confirmation without deleting', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
    await expect(page.locator('.sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
    await searchTests(page, name);
    await expect(rowByName(page, name)).toBeVisible();
    await deleteTest(page, name);
  });

  test('clicking the scrim dismisses the confirmation without deleting', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
    await expect(page.locator('.sheet')).toBeVisible();
    await page.locator('.scrim').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.sheet')).toHaveCount(0);
    await searchTests(page, name);
    await expect(rowByName(page, name)).toBeVisible();
    await deleteTest(page, name);
  });

  test('confirming removes the row and announces the deletion', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    await searchTests(page, name);
    const menu = await openRowMenu(page, rowByName(page, name));
    await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
    await page.locator('.sheet').getByRole('button', { name: 'Delete test' }).click();
    await expectToast(page, new RegExp(`deleted.*${name}`, 'i'));
    await searchTests(page, name);
    await expect(rowByName(page, name)).toHaveCount(0, { timeout: 20_000 });
  });

  test('a deleted test stays gone after a full reload', async ({ page }) => {
    const name = await createTest(page);
    await deleteTest(page, name);
    await page.reload();
    await waitForTestsLoaded(page);
    await searchTests(page, name);
    await expect(testRows(page)).toHaveCount(0);
  });

  test('deleting lowers the workspace case count', async ({ page }) => {
    const name = await createTest(page);
    await gotoScreen(page, 'Tests');
    const testsCount = page.locator('.side-item').filter({ hasText: 'Tests' }).first().locator('.side-count');
    const before = Number(await testsCount.innerText());
    await deleteTest(page, name);
    await expect(testsCount).toHaveText(String(before - 1), { timeout: 20_000 });
  });

  test('deleting lowers that suite\'s count too', async ({ page }) => {
    const suite = uniqueName('Suite');
    await createSuite(page, suite);
    await openSuite(page, suite);
    await page.getByRole('button', { name: 'New Test', exact: true }).first().click();
    const name = uniqueName('Test');
    await fillAuthorForm(page, {
      name, url: 'https://example.com', steps: ['navigate to https://example.com'],
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });

    await gotoScreen(page, 'Tests');
    const suiteCount = page.locator('.sidebar .side-item').filter({ hasText: suite }).locator('.side-count');
    await expect(suiteCount).toHaveText('1', { timeout: 20_000 });
    await deleteTest(page, name);
    await expect(suiteCount).toHaveText('0', { timeout: 20_000 });
  });
});
