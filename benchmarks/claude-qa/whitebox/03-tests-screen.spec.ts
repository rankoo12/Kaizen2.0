import { test, expect } from '@playwright/test';
import {
  signIn, gotoScreen, waitForTestsLoaded, testRows, searchTests, rowByName,
  openRowMenu, setFilter, uniqueName, createSuite, openSuite,
} from './helpers';

/**
 * The Tests screen: filters, search, the suite-health card, row rendering rules,
 * row menus, selection, keyboard list navigation and empty states.
 *
 * White-box facts under test:
 *  - Filters read the LAST RUN's status, except Drafts which reads caseStatus.
 *  - 'Failing' includes 'cancelled', and a never-run case ('pending') matches no
 *    filter but All — so the four filter counts need not sum to the total.
 *  - Search matches "{name} {suiteName} {baseUrl} {author}", case-insensitively.
 *  - The suite-health stats are computed workspace-wide in useDesignData and are
 *    NOT re-derived for a suite filter.
 *  - The ⋯ menu is portalled into document.body and closes on any scroll.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.describe('toolbar', () => {
  test('titles the screen Tests and counts cases across suites', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await expect(page.locator('.toolbar-sub').first()).toHaveText(/^\d+ tests across \d+ suites$/i);
  });

  test('offers the search box, the filter segment and the two action buttons', async ({ page }) => {
    await expect(page.getByPlaceholder('Search tests')).toBeVisible();
    await expect(page.locator('.seg').first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Analyze', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New Test', exact: true }).first()).toBeVisible();
  });

  test('the Analyze button explains itself on hover', async ({ page }) => {
    await expect(page.getByRole('button', { name: 'Analyze', exact: true }))
      .toHaveAttribute('title', 'Have Kaizen explore your app and propose tests');
  });

  test('shows no Back button until a suite filter is applied', async ({ page }) => {
    await expect(page.locator('.toolbar button[title="Back"]')).toHaveCount(0);
  });

  test('does not offer a Run suite button on the unfiltered list', async ({ page }) => {
    await expect(page.locator('.toolbar button', { hasText: 'Run suite' })).toHaveCount(0);
  });
});

test.describe('filter segment', () => {
  test('exposes All, Failing, Healed and Passed', async ({ page }) => {
    const seg = page.locator('.seg').first();
    await expect(seg.locator('button', { hasText: /^All$/ })).toBeVisible();
    await expect(seg.locator('button', { hasText: /^Failing$/ })).toBeVisible();
    await expect(seg.locator('button', { hasText: /^Healed$/ })).toBeVisible();
    await expect(seg.locator('button', { hasText: /^Passed$/ })).toBeVisible();
  });

  test('starts on All with aria-pressed set', async ({ page }) => {
    const seg = page.locator('.seg').first();
    await expect(seg.locator('button', { hasText: /^All$/ })).toHaveAttribute('aria-pressed', 'true');
  });

  test('choosing a filter moves aria-pressed to exactly one button', async ({ page }) => {
    await setFilter(page, 'Passed');
    const pressed = page.locator('.seg').first().locator('button[aria-pressed="true"]');
    await expect(pressed).toHaveCount(1);
    await expect(pressed).toHaveText(/^Passed$/);
  });

  test('the Passed filter shows only rows whose status badge reads Passed', async ({ page }) => {
    await setFilter(page, 'Passed');
    const rows = testRows(page);
    const count = await rows.count();
    test.skip(count === 0, 'no passed tests in this workspace');
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/passed/i);
    }
  });

  test('the Failing filter shows only failed or cancelled rows', async ({ page }) => {
    await setFilter(page, 'Failing');
    const rows = testRows(page);
    const count = await rows.count();
    test.skip(count === 0, 'no failing tests in this workspace');
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/failed|cancelled/i);
    }
  });

  test('the Healed filter shows only healed rows', async ({ page }) => {
    await setFilter(page, 'Healed');
    const rows = testRows(page);
    const count = await rows.count();
    if (count === 0) {
      await expect(page.locator('.card').filter({ hasText: 'No tests match' })).toBeVisible();
      return;
    }
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/healed/i);
    }
  });

  test('each filter narrows the list relative to All', async ({ page }) => {
    await setFilter(page, 'All');
    const all = await testRows(page).count();
    for (const f of ['Failing', 'Healed', 'Passed'] as const) {
      await setFilter(page, f);
      expect(await testRows(page).count()).toBeLessThanOrEqual(all);
    }
  });

  test('returning to All restores the full list', async ({ page }) => {
    const all = await testRows(page).count();
    await setFilter(page, 'Passed');
    await setFilter(page, 'All');
    await expect(testRows(page)).toHaveCount(all);
  });

  test('the Drafts chip is labelled with its own count and matches the rows it yields', async ({ page }) => {
    const drafts = page.locator('.seg').first().locator('button').filter({ hasText: /^Drafts \d+$/ });
    test.skip(await drafts.count() === 0, 'this workspace has no drafts');
    const label = await drafts.innerText();
    const declared = Number(label.replace(/\D/g, ''));
    await drafts.click();
    await expect(drafts).toHaveAttribute('aria-pressed', 'true');
    await expect(testRows(page)).toHaveCount(declared);
  });

  test('every row under the Drafts filter is badged DRAFT or PROVING', async ({ page }) => {
    const drafts = page.locator('.seg').first().locator('button').filter({ hasText: /^Drafts \d+$/ });
    test.skip(await drafts.count() === 0, 'this workspace has no drafts');
    await drafts.click();
    const rows = testRows(page);
    const count = await rows.count();
    for (let i = 0; i < count; i++) {
      // A draft row also carries a status badge, so assert the lifecycle badge exists
      // rather than that it is the row's only badge.
      await expect(
        rows.nth(i).locator('.badge').filter({ hasText: /^(DRAFT|PROVING)$/ }),
      ).toHaveCount(1);
    }
  });

  test('a filter that matches nothing shows the "No tests match" card, not the onboarding card', async ({ page }) => {
    await setFilter(page, 'Healed');
    const rows = await testRows(page).count();
    test.skip(rows > 0, 'this workspace has healed tests');
    const card = page.locator('.card').filter({ hasText: 'No tests match' });
    await expect(card).toBeVisible();
    await expect(card).toContainText('Try a different filter, or write a new test in plain English.');
    // The onboarding card is reserved for a workspace with NO cases at all.
    await expect(
      page.locator('.card').filter({ hasText: "Your suite is empty. Kaizen isn't." }),
    ).toHaveCount(0);
  });

  test('the empty-filter card still offers a way to write a test', async ({ page }) => {
    await setFilter(page, 'Healed');
    test.skip(await testRows(page).count() > 0, 'this workspace has healed tests');
    await expect(
      page.locator('.card').filter({ hasText: 'No tests match' }).getByRole('button', { name: 'New Test' }),
    ).toBeVisible();
  });
});

test.describe('search', () => {
  test('a nonsense query empties the list and shows the no-match card', async ({ page }) => {
    await searchTests(page, 'zzz-nothing-can-match-this-agent-b');
    await expect(testRows(page)).toHaveCount(0);
    await expect(page.locator('.card').filter({ hasText: 'No tests match' })).toBeVisible();
  });

  test('clearing the query restores every row', async ({ page }) => {
    const all = await testRows(page).count();
    await searchTests(page, 'zzz-nothing-can-match-this-agent-b');
    await expect(testRows(page)).toHaveCount(0);
    await searchTests(page, '');
    await expect(testRows(page)).toHaveCount(all);
  });

  test('matching is case-insensitive', async ({ page }) => {
    const firstName = (await testRows(page).first().innerText()).split('\n')[0].trim();
    test.skip(!firstName, 'no rows to search');
    await searchTests(page, firstName.toUpperCase());
    await expect(testRows(page).first()).toContainText(firstName);
  });

  test('a query matches the base URL as well as the name', async ({ page }) => {
    // The predicate concatenates name, suite, baseUrl and author before matching.
    await searchTests(page, 'example.com');
    const rows = testRows(page);
    const count = await rows.count();
    test.skip(count === 0, 'no example.com tests');
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText('example.com');
    }
  });

  test('a query matches the author name', async ({ page }) => {
    await searchTests(page, 'Demo user');
    const count = await testRows(page).count();
    expect(count).toBeGreaterThan(0);
    await expect(testRows(page).first()).toContainText('Demo user');
  });

  test('search composes with the segment filter rather than replacing it', async ({ page }) => {
    await setFilter(page, 'Passed');
    const passed = await testRows(page).count();
    test.skip(passed === 0, 'no passed tests');
    await searchTests(page, 'zzz-nothing-can-match-this-agent-b');
    await expect(testRows(page)).toHaveCount(0);
    // The filter is still Passed after the search narrowed to nothing.
    await expect(page.locator('.seg').first().locator('button[aria-pressed="true"]')).toHaveText(/^Passed$/);
  });

  test('typing in the search box does not trigger the list keyboard shortcuts', async ({ page }) => {
    // The Tests-screen handler bails when the event target is an INPUT.
    const box = page.getByPlaceholder('Search tests');
    await box.click();
    await box.press('ArrowDown');
    await box.press('ArrowDown');
    await expect(page.locator('.row.focus-row.sel')).toHaveCount(0);
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });
});

test.describe('suite health card', () => {
  test('shows a Green ring whose label is a percentage', async ({ page }) => {
    const ring = page.locator('.card.rise').filter({ hasText: 'Suite health' });
    await expect(ring).toContainText('Green');
    await expect(ring.locator('.num').first()).toHaveText(/^\d+%$/, { timeout: 15_000 });
  });

  test('narrates the pass, heal and fail split in one sentence', async ({ page }) => {
    await expect(page.locator('.card.rise').filter({ hasText: 'Suite health' }))
      .toContainText(/\d+ passed clean, \d+ healed themselves, \d+ need a human\./);
  });

  test('offers the three headline stats', async ({ page }) => {
    const card = page.locator('.card.rise').filter({ hasText: 'Suite health' });
    await expect(card).toContainText('Needs a human');
    await expect(card).toContainText('Self-healed');
    await expect(card).toContainText('From memory');
  });

  test('the Needs a human tile is a button that applies the Failing filter', async ({ page }) => {
    await page.locator('button').filter({ hasText: 'Needs a human' }).click();
    const pressed = page.locator('.seg').first().locator('button[aria-pressed="true"]');
    await expect(pressed).toHaveText(/^Failing$/);
  });

  test('the fail count on the tile agrees with the number of Failing rows', async ({ page }) => {
    const card = page.locator('.card.rise').filter({ hasText: 'Suite health' });
    const sentence = await card.innerText();
    const declared = Number(/(\d+) need a human/.exec(sentence)?.[1] ?? '-1');
    await setFilter(page, 'Failing');
    await expect(testRows(page)).toHaveCount(declared);
  });

  test('the passed count in the sentence agrees with the Passed filter', async ({ page }) => {
    const sentence = await page.locator('.card.rise').filter({ hasText: 'Suite health' }).innerText();
    const declared = Number(/(\d+) passed clean/.exec(sentence)?.[1] ?? '-1');
    await setFilter(page, 'Passed');
    await expect(testRows(page)).toHaveCount(declared);
  });

  test('the healed count in the sentence agrees with the Healed filter', async ({ page }) => {
    const sentence = await page.locator('.card.rise').filter({ hasText: 'Suite health' }).innerText();
    const declared = Number(/(\d+) healed themselves/.exec(sentence)?.[1] ?? '-1');
    await setFilter(page, 'Healed');
    await expect(testRows(page)).toHaveCount(declared);
  });

  test('From memory reads a percentage or an honest dash, never a bare zero', async ({ page }) => {
    const tile = page.locator('div').filter({ hasText: /^From memory/ }).first();
    const card = page.locator('.card.rise').filter({ hasText: 'Suite health' });
    await expect(card).toContainText(/From memory/);
    // Either "N%" with the runs sub-line, or "—" with "no runs yet".
    await expect(card).toContainText(/(of last runs cost 0 tokens|no runs yet)/);
    await expect(tile).toBeVisible();
  });
});

test.describe('list header and row rendering', () => {
  test('labels the columns when there is at least one row', async ({ page }) => {
    test.skip(await testRows(page).count() === 0, 'no rows');
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('TEST');
    await expect(header).toContainText('MEMORY');
    await expect(header).toContainText('COST');
    await expect(header).toContainText('STATUS');
    await expect(header).toContainText('LAST RUN');
  });

  test('hides the column header entirely when the list is empty', async ({ page }) => {
    await searchTests(page, 'zzz-nothing-can-match-this-agent-b');
    await expect(testRows(page)).toHaveCount(0);
    await expect(page.locator('.list-h').filter({ hasText: 'MEMORY' })).toHaveCount(0);
  });

  test('every row shows a status badge from the known vocabulary', async ({ page }) => {
    const rows = testRows(page);
    const count = Math.min(await rows.count(), 10);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(
        /passed|failed|healed|skipped|pending|queued|running|cancelled/i,
      );
    }
  });

  test('a row strips the protocol from the base URL in its sub-line', async ({ page }) => {
    const sub = page.locator('.row.focus-row .row-s').first();
    await expect(sub).not.toContainText('https://');
    await expect(sub).not.toContainText('http://');
  });

  test('a never-run row reads "never" rather than a fabricated date', async ({ page }) => {
    const neverRow = testRows(page).filter({ hasText: /never/ }).first();
    test.skip(await neverRow.count() === 0, 'no never-run tests');
    await expect(neverRow).toContainText(/pending/i);
  });

  test('a never-run row shows an em dash for cost, never "free"', async ({ page }) => {
    const neverRow = testRows(page).filter({ hasText: /never/ }).first();
    test.skip(await neverRow.count() === 0, 'no never-run tests');
    // lastCost is null for a case that has not run; the column renders '—'.
    await expect(neverRow).toContainText('—');
  });

  test('a zero-token run renders as "free", not as "0"', async ({ page }) => {
    const freeRow = testRows(page).filter({ hasText: /free/ }).first();
    test.skip(await freeRow.count() === 0, 'no zero-token runs');
    await expect(freeRow).toContainText('free');
  });

  test('a memory column with no lookups shows a dash rather than 0%', async ({ page }) => {
    // cacheHitPct null must never render as 0% — that would claim a measurement.
    const cells = page.locator('.row.focus-row .num[title*="lookup"]');
    const count = Math.min(await cells.count(), 10);
    test.skip(count === 0, 'no memory cells rendered');
    for (let i = 0; i < count; i++) {
      const title = await cells.nth(i).getAttribute('title');
      const text = (await cells.nth(i).innerText()).trim();
      if (title === 'No element lookups yet') expect(text).toBe('—');
      else expect(text).toMatch(/^\d+%$/);
    }
  });

  test('a generated test keeps its Kaizen provenance mark', async ({ page }) => {
    const mark = page.locator('.row.focus-row [aria-label="Written by Kaizen"]');
    test.skip(await mark.count() === 0, 'no generated tests in this workspace');
    await expect(mark.first()).toBeVisible();
  });

  test('the footer advertises the four keyboard affordances', async ({ page }) => {
    const footer = page.locator('.scroll').filter({ hasText: 'open latest run' }).last();
    await expect(footer).toContainText('move');
    await expect(footer).toContainText('open latest run');
    await expect(footer).toContainText('⌘R');
    await expect(footer).toContainText('⌘N');
  });
});

test.describe('draft rows', () => {
  test('a draft row offers Accept instead of a play button', async ({ page }) => {
    const drafts = page.locator('.seg').first().locator('button').filter({ hasText: /^Drafts \d+$/ });
    test.skip(await drafts.count() === 0, 'this workspace has no drafts');
    await drafts.click();
    const row = testRows(page).filter({ hasText: 'DRAFT' }).first();
    test.skip(await row.count() === 0, 'no DRAFT-badged rows');
    await row.hover();
    await expect(row.locator('button', { hasText: 'Accept' })).toBeVisible();
    await expect(row.locator('button[title="Run now (⌘R)"]')).toHaveCount(0);
  });

  test('a draft row menu offers acceptance rather than running', async ({ page }) => {
    const drafts = page.locator('.seg').first().locator('button').filter({ hasText: /^Drafts \d+$/ });
    test.skip(await drafts.count() === 0, 'this workspace has no drafts');
    await drafts.click();
    const row = testRows(page).filter({ hasText: 'DRAFT' }).first();
    test.skip(await row.count() === 0, 'no DRAFT-badged rows');
    const menu = await openRowMenu(page, row);
    await expect(menu.locator('.menu-item', { hasText: 'Accept into the suite' })).toBeVisible();
    await expect(menu.locator('.menu-item', { hasText: 'Run now' })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});

test.describe('row menu', () => {
  test('a normal row menu lists open, run, edit and delete', async ({ page }) => {
    await setFilter(page, 'Passed');
    const row = testRows(page).first();
    test.skip(await row.count() === 0, 'no passed rows');
    const menu = await openRowMenu(page, row);
    await expect(menu.locator('.menu-item')).toHaveText([
      /Open latest run/,
      /Run now/,
      /Edit steps/,
      /Delete test/,
    ]);
    await page.keyboard.press('Escape');
  });

  test('the menu advertises the ⏎ and ⌘R shortcuts beside their items', async ({ page }) => {
    await setFilter(page, 'Passed');
    const row = testRows(page).first();
    test.skip(await row.count() === 0, 'no passed rows');
    const menu = await openRowMenu(page, row);
    await expect(menu.locator('.menu-item', { hasText: 'Open latest run' })).toContainText('⏎');
    await expect(menu.locator('.menu-item', { hasText: 'Run now' })).toContainText('⌘R');
    await page.keyboard.press('Escape');
  });

  test('Escape closes the row menu', async ({ page }) => {
    const row = testRows(page).first();
    await openRowMenu(page, row);
    await page.keyboard.press('Escape');
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('clicking elsewhere closes the row menu', async ({ page }) => {
    const row = testRows(page).first();
    await openRowMenu(page, row);
    await page.locator('.toolbar').first().click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.popover')).toHaveCount(0);
  });

  test('the menu is portalled to the body so a clipping list cannot cut it off', async ({ page }) => {
    const row = testRows(page).first();
    await openRowMenu(page, row);
    const isBodyChild = await page.locator('.popover').evaluate((el) => el.parentElement === document.body);
    expect(isBodyChild).toBe(true);
    await page.keyboard.press('Escape');
  });

  test('scrolling closes the menu rather than leaving it floating over the wrong row', async ({ page }) => {
    const row = testRows(page).first();
    await openRowMenu(page, row);
    await page.locator('.scroll').first().evaluate((el) => el.scrollBy(0, 250));
    await expect(page.locator('.popover')).toHaveCount(0);
  });
});

test.describe('selection and keyboard list navigation', () => {
  test('a single click selects a row without navigating away', async ({ page }) => {
    const row = testRows(page).first();
    await row.click();
    await expect(row).toHaveClass(/\bsel\b/);
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('selecting another row moves the selection', async ({ page }) => {
    test.skip(await testRows(page).count() < 2, 'needs at least two rows');
    await testRows(page).nth(0).click();
    await testRows(page).nth(1).click();
    await expect(page.locator('.row.focus-row.sel')).toHaveCount(1);
    await expect(testRows(page).nth(1)).toHaveClass(/\bsel\b/);
  });

  test('ArrowDown selects the first row when nothing is selected', async ({ page }) => {
    await page.locator('main').click({ position: { x: 400, y: 700 } });
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.row.focus-row.sel')).toHaveCount(1);
  });

  test('ArrowDown then ArrowUp returns to the previous row', async ({ page }) => {
    test.skip(await testRows(page).count() < 3, 'needs at least three rows');
    await page.locator('main').click({ position: { x: 400, y: 700 } });
    await page.keyboard.press('ArrowDown');
    const first = await page.locator('.row.focus-row.sel').innerText();
    await page.keyboard.press('ArrowDown');
    const second = await page.locator('.row.focus-row.sel').innerText();
    expect(second).not.toBe(first);
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.row.focus-row.sel')).toHaveText(first);
  });

  test('ArrowUp at the top of the list stays on the first row', async ({ page }) => {
    await testRows(page).first().click();
    const firstText = await testRows(page).first().innerText();
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.row.focus-row.sel')).toHaveText(firstText);
  });

  test('double-clicking a row opens its latest run', async ({ page }) => {
    await setFilter(page, 'Passed');
    const row = testRows(page).first();
    test.skip(await row.count() === 0, 'no passed rows');
    const name = (await row.innerText()).split('\n')[0].trim();
    await row.dblclick();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
    await expect(page.locator('.seg').first()).toContainText('Steps');
  });

  test('Enter on a focused row opens it', async ({ page }) => {
    await setFilter(page, 'Passed');
    const row = testRows(page).first();
    test.skip(await row.count() === 0, 'no passed rows');
    const name = (await row.innerText()).split('\n')[0].trim();
    await row.click();
    await row.press('Enter');
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
  });

  test('the Open latest run menu item does the same as a double click', async ({ page }) => {
    await setFilter(page, 'Passed');
    const row = testRows(page).first();
    test.skip(await row.count() === 0, 'no passed rows');
    const name = (await row.innerText()).split('\n')[0].trim();
    const menu = await openRowMenu(page, row);
    await menu.locator('.menu-item', { hasText: 'Open latest run' }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
  });

  test('rows are focusable so the list is reachable by keyboard alone', async ({ page }) => {
    await expect(testRows(page).first()).toHaveAttribute('tabindex', '0');
  });
});

test.describe('suite filtering', () => {
  const suiteName = uniqueName('Suite');

  test('opening a suite retitles the screen and reveals a Back button', async ({ page }) => {
    const existing = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    test.skip(await existing.count() === 0, 'no suites in the sidebar');
    const name = (await existing.innerText()).replace(/\d+$/, '').trim();
    await existing.click();
    await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 20_000 });
    await expect(page.locator('.toolbar button[title="Back"]')).toBeVisible();
  });

  test('Back clears the suite filter and returns to the full list', async ({ page }) => {
    const existing = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    test.skip(await existing.count() === 0, 'no suites in the sidebar');
    await existing.click();
    await expect(page.locator('.toolbar button[title="Back"]')).toBeVisible();
    await page.locator('.toolbar button[title="Back"]').click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('a suite view shows only that suite\'s tests', async ({ page }) => {
    const existing = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    test.skip(await existing.count() === 0, 'no suites in the sidebar');
    const declared = Number(await existing.locator('.side-count').innerText());
    await existing.click();
    await expect(page.locator('.toolbar button[title="Back"]')).toBeVisible();
    await expect(testRows(page)).toHaveCount(declared);
  });

  test('a suite view surfaces the Run suite button', async ({ page }) => {
    const existing = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    test.skip(await existing.count() === 0, 'no suites in the sidebar');
    await existing.click();
    await expect(page.locator('.toolbar button', { hasText: 'Run suite' })).toBeVisible();
  });

  test('leaving Tests for another screen clears the suite filter', async ({ page }) => {
    const existing = page.locator('.sidebar .side-item[style*="padding-left: 26px"]').first();
    test.skip(await existing.count() === 0, 'no suites in the sidebar');
    await existing.click();
    await expect(page.locator('.toolbar button[title="Back"]')).toBeVisible();
    await gotoScreen(page, 'Runs');
    await gotoScreen(page, 'Tests');
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await expect(page.locator('.toolbar button[title="Back"]')).toHaveCount(0);
  });

  test('an empty suite disables Run suite and explains why', async ({ page }) => {
    await createSuite(page, suiteName);
    await openSuite(page, suiteName);
    const button = page.locator('.toolbar button', { hasText: 'Run suite' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute(
      'title', 'Nothing to run yet — accept a draft or write a test first',
    );
  });

  test('an empty suite shows the no-match card rather than any rows', async ({ page }) => {
    await openSuite(page, suiteName);
    await expect(testRows(page)).toHaveCount(0);
    await expect(page.locator('.card').filter({ hasText: 'No tests match' })).toBeVisible();
  });

  test('the suite-health card is workspace-wide even inside an empty suite', async ({ page }) => {
    // Documented mismatch: stats come from useDesignData over ALL cases and are not
    // re-derived for the active suite filter, so an empty suite still shows totals.
    await openSuite(page, suiteName);
    await expect(testRows(page)).toHaveCount(0);
    const card = page.locator('.card.rise').filter({ hasText: 'Suite health' });
    await expect(card).toBeVisible();
    const sentence = await card.innerText();
    const passed = Number(/(\d+) passed clean/.exec(sentence)?.[1] ?? '0');
    const failed = Number(/(\d+) need a human/.exec(sentence)?.[1] ?? '0');
    expect(passed + failed).toBeGreaterThan(0);
  });

  test('the toolbar subtitle also ignores the suite filter', async ({ page }) => {
    await gotoScreen(page, 'Tests');
    const unfiltered = await page.locator('.toolbar-sub').first().innerText();
    const total = Number(/(\d+) tests across/i.exec(unfiltered)?.[1] ?? '0');
    await openSuite(page, suiteName);
    await expect(testRows(page)).toHaveCount(0);
    // The suite view swaps the subtitle for the suite description, which is empty
    // here — the point is that the zero-row suite never reports "0 tests".
    await expect(page.locator('.toolbar-sub').first()).not.toHaveText('0 tests across 0 suites');
    expect(total).toBeGreaterThan(0);
  });
});
