import { expect, type Page, type Locator } from '@playwright/test';

/**
 * Shared helpers for the AGENT-B white-box suite.
 *
 * Design notes that shape everything here:
 *  - The app has NO data-testid attributes. Every selector is role/text/title/class based.
 *  - Screens switch by React state, not by URL. `page.goto` always lands on the Tests
 *    screen, so navigation inside the app must be done by clicking.
 *  - Toasts auto-dismiss after 2600ms, so toast assertions must be made promptly.
 *  - Stat numbers animate (CountUp), so read them with retrying matchers, never innerText().
 */

/** Everything this suite creates is prefixed so it is traceable and never confused
 *  with the workspace's pre-existing records. */
export const PREFIX = 'AGENT-B';

export function uniqueName(kind: string): string {
  const suffix = `${Date.now().toString(36).slice(-5)}${Math.random().toString(36).slice(2, 6)}`;
  return `${PREFIX} ${kind} ${suffix}`;
}

// ─── auth ────────────────────────────────────────────────────────────────────

/**
 * Puts the page into the authenticated app.
 *
 * The suite signs in once in global-setup and shares the session through
 * `use.storageState`, so the normal path here is just a navigation — no login
 * round trip. When the context has no session (01-auth.spec.ts opts out of the
 * shared state to test the signed-out app), it falls back to clicking through
 * the Demo user button.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto('/tests', { waitUntil: 'domcontentloaded' });

  // Middleware bounces an unauthenticated visitor to /login?next=/tests.
  if (/\/login/.test(page.url())) {
    await page.getByRole('button', { name: 'Demo user' }).click();
    await page.waitForURL('**/tests', { timeout: 60_000 });
  }

  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 });
  // The sidebar user pill is disabled until GET /api/auth/me resolves; waiting on the
  // real display name means the session (and therefore every proxied fetch) is ready.
  await expect(page.locator('.sidebar').getByText('Demo user')).toBeVisible({ timeout: 60_000 });
}

/** Explicitly drives the Demo user button — for tests that assert the login flow. */
export async function signInViaDemoButton(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Demo user' }).click();
  await page.waitForURL('**/tests', { timeout: 60_000 });
  await expect(page.locator('.sidebar')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('.sidebar').getByText('Demo user')).toBeVisible({ timeout: 60_000 });
}

/** Waits until the Tests list has finished its first data load. */
export async function waitForTestsLoaded(page: Page): Promise<void> {
  await expect(page.locator('.toolbar-title').first()).toHaveText('Tests', { timeout: 30_000 });
  // Either rows or an empty-state card must exist; both mean the fetch resolved.
  await expect(
    page.locator('.list .row.focus-row').first().or(page.locator('.card').filter({ hasText: /No tests/ })),
  ).toBeVisible({ timeout: 30_000 });
}

// ─── navigation ──────────────────────────────────────────────────────────────

export type ScreenName = 'Tests' | 'Runs' | 'Analyses' | 'The Brain' | 'Usage';

/** Clicks a sidebar nav item and waits for that screen's toolbar title. */
export async function gotoScreen(page: Page, name: ScreenName): Promise<void> {
  await page.locator('.side-item').filter({ hasText: name }).first().click();
  const expected = name;
  await expect(page.locator('.toolbar-title').first()).toHaveText(expected, { timeout: 30_000 });
}

/** Opens one of the four menu-bar menus and returns the popover locator. */
export async function openMenu(page: Page, label: 'File' | 'View' | 'Account' | 'Help'): Promise<Locator> {
  await page.locator('.mb-item', { hasText: new RegExp(`^${label}$`) }).click();
  const popover = page.locator('.popover');
  await expect(popover).toBeVisible();
  return popover;
}

export async function closeMenu(page: Page, label: 'File' | 'View' | 'Account' | 'Help'): Promise<void> {
  await page.locator('.mb-item', { hasText: new RegExp(`^${label}$`) }).click();
  await expect(page.locator('.popover')).toHaveCount(0);
}

// ─── toasts ──────────────────────────────────────────────────────────────────

/**
 * Asserts a toast matching `pattern` appears. CSS uppercases `.toast`, so callers
 * should pass a case-insensitive regex.
 */
export async function expectToast(page: Page, pattern: RegExp): Promise<void> {
  await expect(page.locator('.toast')).toHaveText(pattern, { timeout: 10_000 });
}

// ─── the tests screen ────────────────────────────────────────────────────────

export function testRows(page: Page): Locator {
  return page.locator('.list .row.focus-row');
}

/** Narrows the Tests list to a single named record via the search box. */
export async function searchTests(page: Page, query: string): Promise<void> {
  const box = page.getByPlaceholder('Search tests');
  await box.fill(query);
  // The filter is a synchronous useMemo, but React needs a tick to paint.
  await page.waitForTimeout(400);
}

export function rowByName(page: Page, name: string): Locator {
  return testRows(page).filter({ hasText: name }).first();
}

/** Opens a row's ⋯ menu. The Menu is portalled into document.body, so the returned
 *  locator is document-scoped, not row-scoped. Any scroll closes it. */
export async function openRowMenu(page: Page, row: Locator): Promise<Locator> {
  await row.hover();
  await row.locator('.row-actions button').last().click();
  const popover = page.locator('.popover');
  await expect(popover).toBeVisible();
  return popover;
}

/** Applies one of the Tests-screen segment filters. */
export async function setFilter(
  page: Page,
  label: 'All' | 'Failing' | 'Healed' | 'Passed' | RegExp,
): Promise<void> {
  const seg = page.locator('.seg').first();
  const button = typeof label === 'string'
    ? seg.locator('button', { hasText: new RegExp(`^${label}$`) })
    : seg.locator('button').filter({ hasText: label });
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
}

// ─── the author screen ───────────────────────────────────────────────────────

/** Opens the New-test screen from the Tests toolbar. */
export async function openAuthor(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New Test', exact: true }).first().click();
  await expect(page.locator('.toolbar-title').first()).toHaveText('New test', { timeout: 20_000 });
}

export function nameField(page: Page): Locator {
  return page.locator('.card input.field').first();
}

export function urlField(page: Page): Locator {
  return page.locator('input.field.num').first();
}

export function stepInputs(page: Page): Locator {
  return page.locator('.list input.field');
}

export function suiteSelect(page: Page): Locator {
  return page.locator('select.field').first();
}

/** Reads every step input's current value, in order. */
export async function readSteps(page: Page): Promise<string[]> {
  return stepInputs(page).evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
}

/** Replaces the whole step list with `steps`, adding rows as needed. */
export async function writeSteps(page: Page, steps: string[]): Promise<void> {
  const addRow = page.locator('.list .row').filter({ hasText: 'Add a step' });
  for (let i = 0; i < steps.length; i++) {
    if (await stepInputs(page).count() <= i) {
      await addRow.click();
      await expect(stepInputs(page)).toHaveCount(i + 1);
    }
    await stepInputs(page).nth(i).fill(steps[i]);
  }
}

/** Fills the author form completely. Returns nothing; caller decides Save vs Save & Run. */
export async function fillAuthorForm(
  page: Page,
  opts: { name: string; url: string; steps: string[] },
): Promise<void> {
  await nameField(page).fill(opts.name);
  await urlField(page).fill(opts.url);
  await writeSteps(page, opts.steps);
}

/**
 * Creates a test end to end (Save, not Save & Run) and returns its name.
 * Leaves the app on the Run screen for the new case, which is where the app goes.
 */
export async function createTest(
  page: Page,
  opts: { name?: string; url?: string; steps?: string[] } = {},
): Promise<string> {
  const name = opts.name ?? uniqueName('Test');
  await openAuthor(page);
  await fillAuthorForm(page, {
    name,
    url: opts.url ?? 'https://example.com',
    steps: opts.steps ?? ['navigate to https://example.com'],
  });
  await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
  // Saving navigates to the Run screen titled with the case name.
  await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
  return name;
}

/** Deletes a named test through the row menu + confirmation sheet. */
export async function deleteTest(page: Page, name: string): Promise<void> {
  await gotoScreen(page, 'Tests');
  await searchTests(page, name);
  const row = rowByName(page, name);
  if (await row.count() === 0) return;
  const menu = await openRowMenu(page, row);
  await menu.locator('.menu-item', { hasText: 'Delete test' }).click();
  const sheet = page.locator('.sheet');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: 'Delete test' }).click();
  await expect(page.locator('.sheet')).toHaveCount(0);
  await searchTests(page, name);
  await expect(rowByName(page, name)).toHaveCount(0, { timeout: 20_000 });
}

// ─── suites ──────────────────────────────────────────────────────────────────

/** Creates a suite from the sidebar + button and waits for it to appear there. */
export async function createSuite(page: Page, name: string): Promise<void> {
  await gotoScreen(page, 'Tests');
  await page.locator('.sidebar button[title="New suite"]').click();
  const input = page.getByPlaceholder('New suite name');
  await expect(input).toBeVisible();
  await input.fill(name);
  await input.press('Enter');
  await expect(page.locator('.side-item').filter({ hasText: name })).toBeVisible({ timeout: 20_000 });
}

/** Clicks a suite row in the sidebar and waits for the filtered Tests view. */
export async function openSuite(page: Page, name: string): Promise<void> {
  await page.locator('.side-item').filter({ hasText: name }).first().click();
  await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 20_000 });
}

// ─── sheets ──────────────────────────────────────────────────────────────────

export function sheet(page: Page): Locator {
  return page.locator('.sheet');
}

/** Opens the Analyze sheet from the Tests toolbar. */
export async function openAnalyzeSheet(page: Page): Promise<Locator> {
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  const s = sheet(page);
  await expect(s).toBeVisible({ timeout: 20_000 });
  await expect(s).toContainText('Analyze an app');
  return s;
}

// ─── misc ────────────────────────────────────────────────────────────────────

/** The `data-appearance` value currently on <html>. */
export async function appearance(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-appearance'));
}

/** Forces a known appearance so a test never inherits another test's theme. */
export async function setAppearance(page: Page, value: 'aperture' | 'light' | 'dark'): Promise<void> {
  await gotoScreen(page, 'Usage');
  await page.locator('.seg button', { hasText: /^Appearance$/ }).click();
  const label = value[0].toUpperCase() + value.slice(1);
  await page.locator('.seg button', { hasText: new RegExp(`^${label}$`) }).click();
  await expect.poll(() => appearance(page)).toBe(value);
}
