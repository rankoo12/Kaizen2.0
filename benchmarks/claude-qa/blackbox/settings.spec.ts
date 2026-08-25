import { test, expect } from '@playwright/test';
import {
  openApp,
  main,
  gotoScreen,
  settingsTab,
  appearance,
  resetUiState,
  sidebar,
} from './helpers';

/**
 * Usage & Settings: the token budget, API keys, members, and appearance.
 *
 * Appearance and grouping persist in localStorage, so anything this file
 * changes is reset afterwards to avoid leaking into other specs.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
});

test.afterEach(async ({ page }) => {
  await resetUiState(page).catch(() => {});
});

test.describe('Usage', () => {
  test.beforeEach(async ({ page }) => {
    await settingsTab(page, 'Usage');
  });

  test('identifies the signed-in account', async ({ page }) => {
    await expect(main(page)).toContainText(/signed in as test@test\.com/i);
  });

  test('reports the monthly token budget and what is left', async ({ page }) => {
    await expect(main(page)).toContainText(/tokens this month/i);
    await expect(main(page)).toContainText(/left this cycle/i);
    await expect(main(page)).toContainText(/resets/i);
  });

  test('says tokens are spent on finding elements', async ({ page }) => {
    await expect(main(page)).toContainText(/spent on finding elements/i);
  });

  test('reports runs this month and free-run share', async ({ page }) => {
    await expect(main(page)).toContainText(/runs this month/i);
    await expect(main(page)).toContainText(/free runs/i);
  });

  test('states the over-budget rule', async ({ page }) => {
    await expect(main(page)).toContainText(
      /new runs are rejected the moment they’re submitted/i,
    );
    await expect(main(page)).toContainText(/rather than failing halfway through/i);
  });

  test('shows the tokens-per-run chart', async ({ page }) => {
    await expect(main(page)).toContainText(/tokens per run/i);
    await expect(main(page)).toContainText(/a mature test should cost close to nothing/i);
  });

  test('reports the member count', async ({ page }) => {
    await expect(main(page)).toContainText(/members/i);
  });
});

test.describe('API keys', () => {
  test.beforeEach(async ({ page }) => {
    await settingsTab(page, 'API keys');
  });

  test('explains what keys are for', async ({ page }) => {
    await expect(main(page)).toContainText(/for CI and scripts/i);
    await expect(main(page)).toContainText(/narrowest scope it needs/i);
  });

  test('states that only the hash is stored', async ({ page }) => {
    await expect(main(page)).toContainText(/only the hash is stored/i);
    await expect(main(page)).toContainText(/can’t be recovered afterwards/i);
  });

  test('offers a New key action', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'New key', exact: true })).toBeVisible();
  });

  test('shows the key table columns', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('scope');
    expect(text).toContain('last used');
    expect(text).toContain('created');
  });

  test('shows an empty state when no keys exist', async ({ page }) => {
    // The demo workspace ships with no keys.
    await expect(main(page)).toContainText(/no API keys yet|trigger a run from CI/i);
  });

  test('documents the CI curl call and the scope rule', async ({ page }) => {
    await expect(main(page)).toContainText(/Authorization: Bearer/i);
    await expect(main(page)).toContainText(/needs execute scope or higher/i);
    await expect(main(page)).toContainText(/403/);
  });
});

test.describe('Members', () => {
  test.beforeEach(async ({ page }) => {
    await settingsTab(page, 'Members');
  });

  test('lists the demo user as the workspace owner', async ({ page }) => {
    await expect(main(page)).toContainText('test@test.com');
    await expect(main(page)).toContainText(/owner/i);
  });

  test('shows the member table columns', async ({ page }) => {
    const text = (await main(page).innerText()).toLowerCase();
    expect(text).toContain('member');
    expect(text).toContain('role');
    expect(text).toContain('joined');
  });

  test('states the workspace isolation rule', async ({ page }) => {
    await expect(main(page)).toContainText(/only ever see this workspace’s data/i);
    await expect(main(page)).toContainText(/roles decide who can author tests/i);
  });
});

test.describe('Appearance', () => {
  test.beforeEach(async ({ page }) => {
    await settingsTab(page, 'Appearance');
  });

  test('offers the three themes', async ({ page }) => {
    for (const theme of ['Aperture', 'Light', 'Dark']) {
      await expect(page.getByRole('button', { name: theme, exact: true })).toBeVisible();
    }
    await expect(main(page)).toContainText(/aperture is the industrial skin/i);
  });

  test('switching to Light applies the light theme', async ({ page }) => {
    expect(await appearance(page)).not.toBe('light');

    await page.getByRole('button', { name: 'Light', exact: true }).click();

    await expect.poll(() => appearance(page)).toBe('light');
  });

  test('switching to Dark applies the dark theme', async ({ page }) => {
    await page.getByRole('button', { name: 'Dark', exact: true }).click();

    await expect.poll(() => appearance(page)).toBe('dark');
  });

  test('switching back to Aperture restores it', async ({ page }) => {
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect.poll(() => appearance(page)).toBe('dark');

    await page.getByRole('button', { name: 'Aperture', exact: true }).click();

    await expect.poll(() => appearance(page)).toBe('aperture');
  });

  test('the chosen theme survives a reload', async ({ page }) => {
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect.poll(() => appearance(page)).toBe('dark');

    await page.reload({ waitUntil: 'domcontentloaded' });

    await expect.poll(() => appearance(page)).toBe('dark');
  });

  test('the theme is persisted in localStorage', async ({ page }) => {
    await page.getByRole('button', { name: 'Light', exact: true }).click();
    await expect.poll(() => appearance(page)).toBe('light');

    const stored = await page.evaluate(() => localStorage.getItem('kaizen.appearance'));
    expect(stored).toBe('light');
  });

  test('offers the group-tests-by-suite switch', async ({ page }) => {
    const toggle = page.locator('button[role=switch]');
    await expect(toggle).toBeVisible();
    await expect(main(page)).toContainText(/off shows one flat list/i);
  });

  test('turning grouping off flattens the tests list', async ({ page }) => {
    const toggle = page.locator('button[role=switch]');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => localStorage.getItem('kaizen.groupBySuite'))).toBe('0');

    // With grouping off the list no longer carries suite header rows.
    await gotoScreen(page, 'Tests');
    await expect(main(page)).toContainText(/tests across/i);
  });

  test('the grouping switch can be turned back on', async ({ page }) => {
    const toggle = page.locator('button[role=switch]');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');

    await toggle.click();

    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => localStorage.getItem('kaizen.groupBySuite'))).toBe('1');
  });

  test('shows the session block with a sign-out action', async ({ page }) => {
    await expect(main(page)).toContainText(/session/i);
    await expect(main(page)).toContainText('test@test.com');
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  });
});

test.describe('Settings sub-tab navigation', () => {
  test('each sub-tab shows its own content', async ({ page }) => {
    await settingsTab(page, 'API keys');
    await expect(main(page)).toContainText(/for CI and scripts/i);

    await settingsTab(page, 'Members');
    await expect(main(page)).toContainText(/owner/i);
    await expect(main(page)).not.toContainText(/for CI and scripts/i);

    await settingsTab(page, 'Appearance');
    await expect(main(page)).toContainText(/aperture is the industrial skin/i);
  });

  test('returning to the Usage tab shows the budget again', async ({ page }) => {
    await settingsTab(page, 'Appearance');
    await expect(main(page)).toContainText(/aperture is the industrial skin/i);

    await settingsTab(page, 'Usage');

    await expect(main(page)).toContainText(/tokens this month/i);
  });
});
