import { Page, Locator, expect } from '@playwright/test';

/**
 * Shared helpers for the Kaizen black-box suite.
 *
 * Facts these encode (learned by exploration, documented in APP-KNOWLEDGE.md):
 *  - The app is an SPA: the URL is ALWAYS /tests. Never assert navigation via page.url().
 *  - List rows are `div.row` / `div.row-t`, never <table> rows.
 *  - Row action buttons are icon-only and appear on hover.
 *  - The workspace is shared and mutable, so tests assert on records they created
 *    and on before/after deltas, never on absolute totals.
 */

export const BASE = 'http://localhost:3001';

/**
 * Set a controlled React input reliably.
 *
 * `fill()` alone occasionally leaves this app's controlled inputs with stale
 * component state (the DOM shows the value but the form submits empty), so
 * assert the value landed and retry by typing if it did not.
 */
export async function setInput(target: Locator, value: string): Promise<void> {
  await target.click();
  await target.fill(value);
  if ((await target.inputValue()) !== value) {
    await target.fill('');
    await target.pressSequentially(value, { delay: 10 });
  }
  await expect(target).toHaveValue(value);
}

/**
 * Many Kaizen headings and labels are uppercased with `text-transform` in CSS,
 * so the DOM text is actually lower case ("29 tests across 5 suites", "Workspace").
 * Matching on the visual casing silently fails — always compare case-insensitively.
 */
export function ci(text: string): RegExp {
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

/** Unique, traceable name for anything this agent creates. */
export function agentName(label: string): string {
  const suffix = Math.random().toString(36).slice(2, 8);
  return `AGENT-A ${label} ${suffix}`;
}

/**
 * Enter the signed-in workspace.
 *
 * The session cookie is established once by global-setup.ts and injected into
 * every context via `storageState`, so this only needs to open the app and wait
 * for the workspace data to arrive — no login round-trip per test.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: /^Tests/ }).first()).toBeVisible({
    timeout: 60_000,
  });
  // Wait until the workspace data has actually loaded: the header settles on a
  // real suite count, not the transient "0 tests across 0 suites" first paint.
  await expect(main(page)).toContainText(/tests across/i, { timeout: 60_000 });
  await expect(page.locator('div.row-t').first()).toBeVisible({ timeout: 60_000 });
}

/**
 * Sign in through the UI with the Demo user button.
 *
 * Only for tests that exercise authentication itself — everything else should
 * use `openApp`, which reuses the shared session. Callers must opt out of the
 * stored state with `test.use({ storageState: { cookies: [], origins: [] } })`.
 */
export async function signIn(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const demo = page.getByRole('button', { name: /demo user/i });
  await expect(demo).toBeVisible({ timeout: 60_000 });
  await demo.click();
  await page.waitForURL(/\/tests/, { timeout: 60_000 });
  await expect(page.getByRole('button', { name: /^Tests/ }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(main(page)).toContainText(/tests across/i, { timeout: 60_000 });
  await expect(page.locator('div.row-t').first()).toBeVisible({ timeout: 60_000 });
}

/** The main content region. Every screen renders here. */
export function main(page: Page): Locator {
  return page.locator('main');
}

/** The workspace sidebar. It is a div.sidebar, not an <aside>. */
export function sidebar(page: Page): Locator {
  return page.locator('div.sidebar');
}

/**
 * Reset the UI preferences Kaizen persists in localStorage.
 *
 * Appearance and "group tests by suite" survive reloads, so a test that changes
 * them would leak into later tests. (Sidebar visibility is NOT persisted — it
 * returns on reload — so it needs no reset.)
 */
export async function resetUiState(page: Page): Promise<void> {
  await page.goto(`${BASE}/tests`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('kaizen.appearance', 'aperture');
    localStorage.setItem('kaizen.groupBySuite', '1');
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
}

/** First two lines of <main> — the screen's heading + sub-heading. */
export async function screenHeading(page: Page): Promise<string> {
  const text = await main(page).innerText();
  return text.split('\n').slice(0, 2).join(' | ');
}

/** Click a primary nav entry in the sidebar (Tests/Runs/Analyses/The Brain/Usage/Settings). */
export async function gotoScreen(
  page: Page,
  name: 'Tests' | 'Runs' | 'Analyses' | 'The Brain' | 'Usage' | 'Settings',
): Promise<void> {
  if (name === 'Tests') {
    await page.getByRole('button', { name: /^Tests/ }).first().click();
  } else {
    await page.getByRole('button', { name, exact: true }).first().click();
  }
  // NOTE: headings are uppercased with CSS only; the DOM text is lower case
  // ("29 tests across 5 suites"), so match case-insensitively.
  await expect(main(page)).toContainText(name === 'Tests' ? /tests across/i : name, {
    timeout: 20_000,
  });
}

/** Open a top menu-bar menu and return its items. */
export async function openMenu(page: Page, menu: 'File' | 'View' | 'Account' | 'Help'): Promise<Locator> {
  await page.getByRole('button', { name: menu, exact: true }).click();
  const items = page.locator('button.menu-item');
  await expect(items.first()).toBeVisible();
  return items;
}

export async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
}

/** A test row in the list, located by its visible name. */
export function testRow(page: Page, name: string): Locator {
  return page.locator('div.row').filter({ hasText: name }).first();
}

/** Open a test row's "…" overflow menu (hover first — the buttons are hover-revealed). */
export async function openRowMenu(page: Page, name: string): Promise<void> {
  const row = testRow(page, name);
  await row.scrollIntoViewIfNeeded();
  await row.hover();
  await row.locator('.row-actions button').nth(1).click();
  await expect(page.getByRole('button', { name: /Open latest run/i })).toBeVisible();
}

/** Composer field accessors. In <main>: input 0 = name, input 1 = URL, inputs 2+ = steps. */
export const composer = {
  name: (page: Page) => main(page).locator('input').nth(0),
  url: (page: Page) => main(page).locator('input[value^="https://"], input').nth(1),
  step: (page: Page, i: number) => main(page).locator('input').nth(2 + i),
  suiteSelect: (page: Page) => main(page).locator('select').first(),
  newSuiteButton: (page: Page) => main(page).locator('button[title="New suite"]'),
  newSuiteInput: (page: Page) => main(page).locator('input[placeholder="New suite name"]'),
  /** "Add a step" is a div.row, NOT a button. */
  addStep: (page: Page) => main(page).locator('div.row').filter({ hasText: 'Add a step' }).last(),
  moveUp: (page: Page) => main(page).locator('button[title="Move up"]'),
  moveDown: (page: Page) => main(page).locator('button[title="Move down"]'),
  remove: (page: Page) => main(page).locator('button[title="Remove"]'),
  compiledPlan: (page: Page) => main(page).locator('text=Compiled plan'),
};

/** Open the New-test composer and wait for it. */
export async function openComposer(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New Test', exact: true }).first().click();
  await expect(main(page)).toContainText('WRITE IT IN ENGLISH');
  await expect(composer.suiteSelect(page)).toBeVisible();
}

/** Read the values of the step inputs currently in the composer. */
export async function stepValues(page: Page): Promise<string[]> {
  const all = await main(page).locator('input').all();
  const vals: string[] = [];
  for (let i = 2; i < all.length; i++) vals.push(await all[i].inputValue());
  return vals;
}

/**
 * Type a single step into the composer and return the compiled-plan text,
 * which reveals the action kind (NAVIGATE/CLICK/…) and strategy (PATTERN/LOOKUP).
 */
export async function compileStep(page: Page, phrase: string): Promise<string> {
  await composer.step(page, 0).fill(phrase);
  const planRegion = main(page);
  await expect(planRegion).toContainText('Compiled plan');
  // The plan re-renders as you type; give the debounce a beat then read it.
  await page.waitForTimeout(500);
  const text = await planRegion.innerText();
  return text.slice(text.indexOf('Compiled plan'));
}

/**
 * Create a test through the UI and return its name.
 * Uses an existing suite (never the buggy blur-path) so the record is traceable.
 */
export async function createTest(
  page: Page,
  opts: { label?: string; url?: string; steps?: string[]; suite?: string } = {},
): Promise<string> {
  const name = agentName(opts.label ?? 'Test');
  const url = opts.url ?? 'https://example.com';
  const steps = opts.steps ?? [`navigate to ${url}`];

  await openComposer(page);
  await setInput(composer.name(page), name);
  await setInput(composer.url(page), url);
  if (opts.suite) {
    await composer.suiteSelect(page).selectOption({ label: opts.suite });
  }
  await setInput(composer.step(page, 0), steps[0]);
  for (let i = 1; i < steps.length; i++) {
    await composer.addStep(page).click();
    await setInput(composer.step(page, i), steps[i]);
  }
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  // After save the app shows the new test's detail view.
  await expect(main(page)).toContainText(name, { timeout: 30_000 });
  return name;
}

/** Delete a test through the UI, confirming the in-app dialog. */
export async function deleteTest(page: Page, name: string): Promise<void> {
  await gotoScreen(page, 'Tests');
  await searchTests(page, name);
  if ((await page.locator('div.row-t').filter({ hasText: name }).count()) === 0) return;
  await openRowMenu(page, name);
  await page.getByRole('button', { name: /^Delete test$/ }).click();
  await expect(page.locator('body')).toContainText('This can’t be undone');
  await page.getByRole('button', { name: /^Delete test$/ }).last().click();
  await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(0, {
    timeout: 30_000,
  });
}

/** Type into the Tests search box and let the list settle. */
export async function searchTests(page: Page, query: string): Promise<void> {
  const box = page.locator('input[placeholder="Search tests"]');
  await box.fill(query);
  await page.waitForTimeout(600);
}

/** Names of every test row currently rendered. */
export async function visibleTestNames(page: Page): Promise<string[]> {
  return page.locator('div.row-t').allInnerTexts();
}

/** Click one of the Tests screen's filter tabs. */
export async function filterTests(
  page: Page,
  tab: 'All' | 'Failing' | 'Healed' | 'Passed' | 'Drafts',
): Promise<void> {
  await page.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click();
  await page.waitForTimeout(700);
}

/** Status badge texts currently rendered in the list. */
export async function visibleBadges(page: Page): Promise<string[]> {
  return page.locator('.badge').allInnerTexts();
}

/** Go to Settings and select one of its sub-tabs. */
export async function settingsTab(
  page: Page,
  tab: 'Usage' | 'API keys' | 'Members' | 'Appearance',
): Promise<void> {
  await gotoScreen(page, 'Settings');
  await page.getByRole('button', { name: tab, exact: true }).click();
  await page.waitForTimeout(600);
}

/** Current appearance, as the app records it on <html>. */
export async function appearance(page: Page): Promise<string | null> {
  return page.evaluate(() => document.documentElement.getAttribute('data-appearance'));
}

/** Open the "Analyze an app" sheet. NEVER submit it — it starts a long background job. */
export async function openAnalyzeSheet(page: Page): Promise<Locator> {
  await gotoScreen(page, 'Analyses');
  await page.getByRole('button', { name: /Analyze an app/i }).first().click();
  const sheet = page.locator('div').filter({ hasText: /^Analyze an app/ }).last();
  await expect(page.locator('body')).toContainText('explores it read-only');
  return sheet;
}

/** Close the Analyze sheet via its Cancel button. */
export async function cancelAnalyzeSheet(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Cancel', exact: true }).last().click();
  await expect(page.locator('body')).not.toContainText('explores it read-only');
}
