import { test, expect } from '@playwright/test';
import { openApp, main, gotoScreen, openMenu, closeMenu, appearance, sidebar } from './helpers';

/**
 * The app shell: sidebar navigation, the menu bar, keyboard shortcuts.
 *
 * Kaizen is a single-page app — the URL stays /tests on every screen — so all
 * navigation assertions check the content of <main>, never page.url().
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.describe('Sidebar navigation', () => {
  test('starts on the Tests screen', async ({ page }) => {
    await expect(main(page)).toContainText(/tests across/i);
  });

  test('navigates to Runs', async ({ page }) => {
    await expect(main(page)).not.toContainText(/runs in this workspace/i);
    await gotoScreen(page, 'Runs');
    await expect(main(page)).toContainText(/runs in this workspace, newest first/i);
  });

  test('navigates to Analyses', async ({ page }) => {
    await expect(main(page)).not.toContainText(/every time kaizen explored/i);
    await gotoScreen(page, 'Analyses');
    await expect(main(page)).toContainText(/every time kaizen explored an app and proposed tests/i);
  });

  test('navigates to The Brain', async ({ page }) => {
    await expect(main(page)).not.toContainText(/every element kaizen has learned/i);
    await gotoScreen(page, 'The Brain');
    await expect(main(page)).toContainText(/every element kaizen has learned/i);
  });

  test('navigates to Usage', async ({ page }) => {
    await expect(main(page)).not.toContainText(/signed in as/i);
    await gotoScreen(page, 'Usage');
    await expect(main(page)).toContainText(/signed in as test@test.com/i);
  });

  test('Settings opens the same screen as Usage', async ({ page }) => {
    await gotoScreen(page, 'Settings');
    // Settings and Usage share one screen with sub-tabs.
    await expect(main(page)).toContainText(/signed in as test@test.com/i);
    for (const tab of ['API keys', 'Members', 'Appearance']) {
      await expect(page.getByRole('button', { name: tab, exact: true }).first()).toBeVisible();
    }
  });

  test('returns to Tests from another screen', async ({ page }) => {
    await gotoScreen(page, 'Runs');
    await expect(main(page)).toContainText(/runs in this workspace/i);

    await gotoScreen(page, 'Tests');
    await expect(main(page)).toContainText(/tests across/i);
    await expect(main(page)).not.toContainText(/runs in this workspace/i);
  });

  test('the URL stays on /tests across every screen', async ({ page }) => {
    // Documents the SPA behaviour: navigation never changes the address.
    for (const screen of ['Runs', 'Analyses', 'The Brain', 'Usage'] as const) {
      await gotoScreen(page, screen);
      expect(page.url()).toContain('/tests');
    }
  });

  test('lists every suite in the sidebar with a count', async ({ page }) => {
    const side = sidebar(page);
    await expect(side).toContainText(/workspace/i);
    await expect(side).toContainText('Checkout smoke');
    await expect(side).toContainText('Demo');
  });

  test('clicking a suite scopes the Tests screen to that suite', async ({ page }) => {
    await expect(main(page)).toContainText(/tests across/i);

    await page.getByRole('button', { name: /^Checkout smoke/ }).first().click();

    // The heading becomes the suite, and a suite-only action appears.
    await expect(main(page)).toContainText('Checkout smoke');
    await expect(page.getByRole('button', { name: 'Run suite', exact: true })).toBeVisible();
    await expect(main(page)).toContainText(/known pages have a test/i);
  });
});

test.describe('Menu bar', () => {
  test('the File menu offers the creation actions', async ({ page }) => {
    const items = await openMenu(page, 'File');
    const text = (await items.allInnerTexts()).join(' | ');
    expect(text).toContain('New Test');
    expect(text).toContain('New Suite');
    expect(text).toContain('Analyze an app');
    await closeMenu(page);
  });

  test('the View menu lists every screen with its shortcut', async ({ page }) => {
    const items = await openMenu(page, 'View');
    const text = (await items.allInnerTexts()).join(' | ');
    expect(text).toContain('Tests');
    expect(text).toContain('Runs');
    expect(text).toContain('Analyses');
    expect(text).toContain('The Brain');
    expect(text).toContain('Usage');
    expect(text).toContain('Hide sidebar');
    await closeMenu(page);
  });

  test('the Account menu shows the signed-in identity', async ({ page }) => {
    const items = await openMenu(page, 'Account');
    const text = (await items.allInnerTexts()).join(' | ');
    expect(text).toContain('test@test.com');
    expect(text).toContain('Sign out');
    await closeMenu(page);
  });

  test('the Help menu documents the keyboard shortcuts', async ({ page }) => {
    await openMenu(page, 'Help');
    await expect(page.locator('body')).toContainText('⌘N new');
    await closeMenu(page);
  });

  test('Escape closes an open menu', async ({ page }) => {
    const items = await openMenu(page, 'File');
    const openCount = await items.count();
    expect(openCount).toBeGreaterThan(0);

    await closeMenu(page);
    // Closing unmounts the menu items entirely.
    await expect(page.locator('button.menu-item')).toHaveCount(0);
  });

  test('File > New Test opens the composer', async ({ page }) => {
    await expect(main(page)).not.toContainText(/write it in english/i);

    const items = await openMenu(page, 'File');
    await items.filter({ hasText: 'New Test' }).first().click();

    await expect(main(page)).toContainText(/write it in english/i);
  });

  test('View > Hide sidebar removes the sidebar', async ({ page }) => {
    await expect(sidebar(page)).toHaveCount(1);

    const items = await openMenu(page, 'View');
    await items.filter({ hasText: 'Hide sidebar' }).first().click();

    await expect(sidebar(page)).toHaveCount(0);
  });

  test('the sidebar can be brought back after hiding it', async ({ page }) => {
    let items = await openMenu(page, 'View');
    await items.filter({ hasText: 'Hide sidebar' }).first().click();
    await expect(sidebar(page)).toHaveCount(0);

    items = await openMenu(page, 'View');
    await items.filter({ hasText: /sidebar/i }).first().click();
    await expect(sidebar(page)).toHaveCount(1);
  });
});

test.describe('Keyboard shortcuts', () => {
  test('Meta+2 opens Runs', async ({ page }) => {
    await expect(main(page)).not.toContainText(/runs in this workspace/i);
    await page.keyboard.press('Meta+2');
    await expect(main(page)).toContainText(/runs in this workspace/i);
  });

  test('Meta+3 opens Analyses', async ({ page }) => {
    await page.keyboard.press('Meta+3');
    await expect(main(page)).toContainText(/every time kaizen explored/i);
  });

  test('Meta+4 opens The Brain', async ({ page }) => {
    await page.keyboard.press('Meta+4');
    await expect(main(page)).toContainText(/every element kaizen has learned/i);
  });

  test('Meta+5 opens Usage', async ({ page }) => {
    await page.keyboard.press('Meta+5');
    await expect(main(page)).toContainText(/signed in as/i);
  });

  test('Meta+1 returns to Tests', async ({ page }) => {
    await page.keyboard.press('Meta+2');
    await expect(main(page)).toContainText(/runs in this workspace/i);

    await page.keyboard.press('Meta+1');
    await expect(main(page)).toContainText(/tests across/i);
  });

  test('Meta+N opens the new-test composer', async ({ page }) => {
    await expect(main(page)).not.toContainText(/write it in english/i);
    await page.keyboard.press('Meta+n');
    await expect(main(page)).toContainText(/write it in english/i);
  });

  test('Shift+Meta+A cycles the appearance', async ({ page }) => {
    const before = await appearance(page);
    await page.keyboard.press('Shift+Meta+A');
    await expect
      .poll(() => appearance(page), { timeout: 15_000 })
      .not.toBe(before);
  });
});
