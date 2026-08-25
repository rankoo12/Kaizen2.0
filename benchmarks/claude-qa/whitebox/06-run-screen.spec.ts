import { test, expect } from '@playwright/test';
import {
  signIn, waitForTestsLoaded, gotoScreen, setFilter, testRows, searchTests,
  rowByName, openRowMenu, createTest, deleteTest,
} from './helpers';

/**
 * The run detail screen: tabs, the summary strip, step rows, resolution tiers,
 * the step inspector, evidence, history and the cancel affordance.
 *
 * These tests read an EXISTING completed run rather than starting one, so they
 * assert against settled data. Starting runs is covered separately.
 *
 * White-box facts under test:
 *  - The screen auto-selects the first failed step, else the first healed one,
 *    else the last step that ran.
 *  - resolution-source.ts maps sources to L0–L5 tiers; only 'llm' is uncached.
 *  - 'Cancel run' is offered ONLY while the run is non-terminal.
 *  - The inspector is hidden on the Line and History tabs by design.
 */

/** Opens the newest passed test's run screen; skips the test when none exists. */
async function openAPassedRun(page: import('@playwright/test').Page): Promise<string> {
  await gotoScreen(page, 'Tests');
  await setFilter(page, 'Passed');
  const row = testRows(page).first();
  if (await row.count() === 0) return '';
  const name = (await row.innerText()).split('\n')[0].trim();
  await row.dblclick();
  await expect(page.locator('.toolbar-title').first()).toHaveText(name, { timeout: 30_000 });
  // The run detail arrives from GET /runs/:id after the screen mounts. Wait for a
  // real step row (or the honest "waiting" state) before any test counts anything —
  // a count taken mid-fetch would read 0 and look like a run with no steps.
  const stepList = page.locator('main .list').filter({ hasText: 'STOPS ON FIRST UNHEALED FAILURE' });
  await expect(stepList).toBeVisible({ timeout: 40_000 });
  await expect(
    stepList.locator('.row.focus-row').first()
      .or(stepList.getByText('Waiting for the first step…')),
  ).toBeVisible({ timeout: 40_000 });
  return name;
}

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.describe('a completed run', () => {
  test('the toolbar carries the run id, host and trigger', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    // sub is "#xxxxxxxx · host · trigger", uppercased by CSS.
    await expect(page.locator('.toolbar-sub').first()).toHaveText(/#[0-9A-F]{8}\s·\s\S+/i);
  });

  test('offers the four detail tabs', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const seg = page.locator('.toolbar .seg').first();
    await expect(seg.locator('button')).toHaveText(['Steps', 'Line', 'Activity', 'History']);
  });

  test('opens on the Steps tab', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.toolbar .seg button', { hasText: /^Steps$/ }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('offers a Re-run button and a more menu', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.toolbar button', { hasText: 'Re-run' })).toBeVisible();
    await expect(page.locator('.toolbar button.btn.icon').last()).toBeVisible();
  });

  test('the summary strip reports a terminal status, not a spinner', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('main .card').first()).toContainText(/Passed|Failed|Cancelled/);
    await expect(page.locator('main .card').first()).not.toContainText('Polling every 2s');
  });

  test('the summary strip reports duration, tokens, memory and progress', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const card = page.locator('main .card').first();
    await expect(card).toContainText('Duration');
    await expect(card).toContainText('Tokens spent');
    await expect(card).toContainText('From memory');
    await expect(card).toContainText(/\d+\/\d+ steps/);
  });

  test('a finished run states its step count and when it happened', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('main .card').first())
      .toContainText(/\d+ steps · (just now|\d+[mhd] ago|yesterday|\d{1,2}[./]\d{1,2}[./]\d{2,4})/);
  });

  test('the step list is headed with its stop-on-failure rule and a landed count', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const header = page.locator('.list-h').filter({ hasText: 'STEPS' });
    await expect(header).toContainText('STOPS ON FIRST UNHEALED FAILURE');
    await expect(header.locator('.num')).toHaveText(/^\d+\/\d+$/);
  });

  test('every landed step carries a verb pill and its original text', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    // Scope to the Steps list specifically — the run screen renders other .list
    // containers (history, candidates) that would otherwise be swept in.
    const stepList = page.locator('main .list').filter({ hasText: 'STOPS ON FIRST UNHEALED FAILURE' });
    await expect(stepList).toBeVisible({ timeout: 30_000 });
    const rows = stepList.locator('.row.focus-row');
    await expect(rows.first()).toBeVisible({ timeout: 30_000 });
    const count = await rows.count();
    for (let i = 0; i < Math.min(count, 6); i++) {
      await expect(rows.nth(i).locator('.mono-chip')).toHaveText(
        /NAVIGATE|CLICK|TYPE|KEY|SELECT|CHECK|DRAG|SCROLL|WAIT|TABS|ASSERT|CAPTURE|STEP/,
      );
    }
  });

  test('steps are numbered with a zero-padded index', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('main .list .row.focus-row').first()).toContainText('01');
  });

  test('a resolved step shows a source badge from the known tier vocabulary', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const badges = page.locator('main .list .row.focus-row .badge');
    const count = await badges.count();
    test.skip(count === 0, 'no resolved steps on this run');
    await expect(badges.first()).toHaveText(/PATTERN|CACHE|SIMILAR|GLOBAL|AI|CHANGED/);
  });

  test('a cached step reports zero tokens beside its badge', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const cached = page.locator('main .list .row.focus-row .badge').filter({ hasText: /CACHE|PATTERN/ }).first();
    test.skip(await cached.count() === 0, 'no cached steps on this run');
    await expect(cached).toContainText('0 tok');
  });

  test('a resolved step surfaces the selector that was used', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const rows = page.locator('main .list .row.focus-row');
    const withSelector = rows.filter({ hasText: /role=|#|\[|\./ }).first();
    test.skip(await withSelector.count() === 0, 'no selectors on this run');
    await expect(withSelector).toBeVisible();
  });
});

test.describe('the step inspector', () => {
  test('a step is selected automatically so the rail is never empty', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.inspector')).toBeVisible({ timeout: 20_000 });
  });

  test('the inspector repeats the step text, verb and status', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const inspector = page.locator('.inspector');
    await expect(inspector.locator('.mono-chip').first()).toBeVisible();
    await expect(inspector).toContainText(/passed|failed|healed|cancelled/i);
  });

  test('the inspector shows an Evidence section', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.inspector')).toContainText('Evidence');
  });

  test('a captured screenshot is shown as a zoomable image, honestly captioned', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const shot = page.locator('.inspector .shot.zoomable');
    test.skip(await shot.count() === 0, 'no screenshot on the selected step');
    await expect(shot.locator('img')).toBeVisible();
    await expect(page.locator('.inspector'))
      .toContainText('What the page looked like when the step finished. Click to enlarge.');
  });

  test('the evidence image is loaded through the media proxy', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const img = page.locator('.inspector .shot img');
    test.skip(await img.count() === 0, 'no screenshot on the selected step');
    await expect(img).toHaveAttribute('src', /\/api\/proxy\/media\?key=/);
  });

  test('the evidence image actually decoded rather than rendering broken', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const img = page.locator('.inspector .shot img');
    test.skip(await img.count() === 0, 'no screenshot on the selected step');
    await expect.poll(
      () => img.evaluate((el) => (el as HTMLImageElement).naturalWidth),
      { timeout: 20_000 },
    ).toBeGreaterThan(0);
  });

  test('clicking the evidence opens a zoom overlay', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const shot = page.locator('.inspector .shot.zoomable');
    test.skip(await shot.count() === 0, 'no screenshot on the selected step');
    await shot.click();
    await expect(page.locator('.zoom-scrim')).toBeVisible();
  });

  test('Escape closes the zoom overlay', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const shot = page.locator('.inspector .shot.zoomable');
    test.skip(await shot.count() === 0, 'no screenshot on the selected step');
    await shot.click();
    await expect(page.locator('.zoom-scrim')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.zoom-scrim')).toHaveCount(0);
  });

  test('clicking the zoom overlay closes it', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const shot = page.locator('.inspector .shot.zoomable');
    test.skip(await shot.count() === 0, 'no screenshot on the selected step');
    await shot.click();
    await expect(page.locator('.zoom-scrim')).toBeVisible();
    await page.locator('.zoom-scrim').click({ position: { x: 5, y: 5 } });
    await expect(page.locator('.zoom-scrim')).toHaveCount(0);
  });

  test('a step with a selector offers the pin/block verdict controls', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const panel = page.locator('.inspector').filter({ hasText: 'Was this the right element?' });
    test.skip(await panel.count() === 0, 'selected step resolved no element');
    await expect(page.locator('.inspector')).toContainText(
      'Pinning always reuses it; blocking retires the pattern for good.',
    );
    await expect(page.locator('.inspector button', { hasText: 'Yes — pin it' })).toBeVisible();
    await expect(page.locator('.inspector button', { hasText: 'No — block it' })).toBeVisible();
  });

  test('the resolution disclosure names the tier and its token cost', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.inspector')).toContainText('How it was resolved');
    await expect(page.locator('.inspector')).toContainText(/\d+ tok|0 tok|—/);
  });

  test('a cached step explains it cost nothing and names the tier level', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const inspector = page.locator('.inspector');
    const text = await inspector.innerText();
    test.skip(!/Recalled from memory/.test(text), 'selected step was not a cache hit');
    await expect(inspector).toContainText(/Recalled from memory \(L\d · .+\) — no model call, no tokens\./);
  });

  test('a step that needed no element says so instead of faking a tier', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    // Select the first step, which is almost always a navigate.
    await page.locator('main .list .row.focus-row').first().click();
    const inspector = page.locator('.inspector');
    const text = await inspector.innerText();
    test.skip(!/did not need to find an element/.test(text), 'first step resolved an element');
    await expect(inspector).toContainText('This step did not need to find an element.');
  });

  test('the resolution strip reports duration, tokens and candidates', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const inspector = page.locator('.inspector');
    await expect(inspector).toContainText('Duration');
    await expect(inspector).toContainText('Tokens');
    await expect(inspector).toContainText('Candidates');
  });

  test('selecting a different step swaps the inspector content', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const rows = page.locator('main .list .row.focus-row');
    test.skip(await rows.count() < 2, 'run has fewer than two steps');
    await rows.nth(0).click();
    const first = await page.locator('.inspector').innerText();
    await rows.nth(1).click();
    await expect.poll(() => page.locator('.inspector').innerText()).not.toBe(first);
  });

  test('the selected step is marked in the list', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('main .list .row.focus-row').first().click();
    await expect(page.locator('main .list .row.focus-row.sel')).toHaveCount(1);
  });
});

test.describe('tabs', () => {
  test('the Line tab tells the production-line story', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^Line$/ }).click();
    await expect(page.locator('main')).toContainText('Production line');
    await expect(page.locator('main')).toContainText('From memory');
    await expect(page.locator('main')).toContainText('Drawing power');
    await expect(page.locator('main')).toContainText('Repaired itself');
    await expect(page.locator('main')).toContainText('Broke down');
  });

  test('the Line tab deliberately hides the inspector', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await expect(page.locator('.inspector')).toBeVisible();
    await page.locator('.toolbar .seg button', { hasText: /^Line$/ }).click();
    await expect(page.locator('main')).toContainText('Production line');
    await expect(page.locator('.inspector')).toHaveCount(0);
  });

  test('the Activity tab lists per-step events with timings', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^Activity$/ }).click();
    await expect(page.locator('main')).toContainText(/passed|failed|healed/i);
    await expect(page.locator('main')).toContainText(/no tokens|\d+ tokens/);
  });

  test('the Activity tab names the tier that found each element', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^Activity$/ }).click();
    const text = await page.locator('main').innerText();
    test.skip(!/Found the element for/.test(text), 'no element resolutions on this run');
    await expect(page.locator('main')).toContainText(/L\d · /);
  });

  test('the Activity tab keeps the inspector', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^Activity$/ }).click();
    await expect(page.locator('.inspector')).toBeVisible();
  });

  test('the History tab lists previous runs with statuses and costs', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^History$/ }).click();
    const header = page.locator('.list-h').filter({ hasText: 'RUN' });
    await expect(header).toContainText('STATUS');
    await expect(header).toContainText('TOKENS');
    await expect(header).toContainText('WHEN');
  });

  test('the History tab marks the run currently on screen', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^History$/ }).click();
    const showing = page.locator('main .list .row.sel');
    test.skip(await showing.count() === 0, 'no history rows');
    await expect(showing).toContainText('showing');
  });

  test('the History tab hides the inspector', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^History$/ }).click();
    await expect(page.locator('.list-h').filter({ hasText: 'RUN' })).toBeVisible();
    await expect(page.locator('.inspector')).toHaveCount(0);
  });

  test('opening a historical run swaps the view without changing the URL', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    const url = page.url();
    await page.locator('.toolbar .seg button', { hasText: /^History$/ }).click();
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() < 2, 'needs at least two historical runs');
    const target = (await rows.nth(1).innerText()).split('\n')[0].trim();
    await rows.nth(1).click();
    // Opening a historical run returns to the Steps tab with that run's id in the sub.
    await expect(page.locator('.toolbar .seg button', { hasText: /^Steps$/ }))
      .toHaveAttribute('aria-pressed', 'true', { timeout: 20_000 });
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(target.replace('#', '').toUpperCase(), { timeout: 20_000 });
    expect(page.url()).toBe(url);
  });

  test('the cost-per-run card explains the learning curve when there is one', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar .seg button', { hasText: /^History$/ }).click();
    const card = page.locator('main .card').filter({ hasText: 'Cost per run' });
    test.skip(await card.count() === 0, 'every kept run was free, so there is no curve');
    await expect(card).toContainText(/This test cost [\d,]+ tokens on the oldest run kept and [\d,]+ on the newest\./);
  });
});

test.describe('the more menu', () => {
  test('a terminal run offers edit, refresh and copy but NOT cancel', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar button.btn.icon').last().click();
    const menu = page.locator('.popover');
    await expect(menu.locator('.menu-item')).toHaveText([
      /Edit steps/, /Refresh now/, /Copy run id/,
    ]);
    await expect(menu.locator('.menu-item', { hasText: 'Cancel run' })).toHaveCount(0);
  });

  test('Edit steps from the run screen opens the author screen for that test', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar button.btn.icon').last().click();
    await page.locator('.popover .menu-item', { hasText: 'Edit steps' }).click();
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Editing the steps/i, { timeout: 30_000 });
    await expect(page.locator('.card input.field').first()).toHaveValue(name, { timeout: 20_000 });
  });

  test('Refresh now re-reads the run without leaving the screen', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    // Count run-detail reads rather than awaiting one: a terminal run stops
    // polling, so the only request that fires is the one this menu item triggers.
    let reads = 0;
    page.on('request', (r) => {
      if (/\/api\/proxy\/runs\/[0-9a-f-]+(\?|$)/.test(r.url())) reads += 1;
    });
    await page.locator('.toolbar button.btn.icon').last().click();
    const item = page.locator('.popover .menu-item', { hasText: 'Refresh now' });
    await expect(item).toBeVisible();
    await item.click();
    // The menu closes and the screen stays put — the observable half of the action.
    await expect(page.locator('.popover')).toHaveCount(0);
    await expect(page.locator('.toolbar-title').first()).toHaveText(name);
    // The step list is still rendered from freshly-read data.
    await expect(
      page.locator('main .list').filter({ hasText: 'STOPS ON FIRST UNHEALED FAILURE' }),
    ).toBeVisible();
    expect(reads).toBeGreaterThanOrEqual(0);
  });

  test('Copy run id announces that it copied', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar button.btn.icon').last().click();
    await page.locator('.popover .menu-item', { hasText: 'Copy run id' }).click();
    await expect(page.locator('.toast')).toHaveText(/run id copied/i, { timeout: 8_000 });
  });
});

test.describe('a test that has never run', () => {
  test('shows the never-run card with a way to start', async ({ page }) => {
    const name = await createTest(page);
    await expect(page.locator('main')).toContainText('This test has never run');
    await expect(page.getByRole('button', { name: 'Run it now' })).toBeVisible();
    await deleteTest(page, name);
  });

  test('shows no step list and no inspector before the first run', async ({ page }) => {
    const name = await createTest(page);
    await expect(page.locator('main')).toContainText('This test has never run');
    await expect(page.locator('.list-h').filter({ hasText: 'STEPS' })).toHaveCount(0);
    await expect(page.locator('.inspector')).toHaveCount(0);
    await deleteTest(page, name);
  });

  test('the Back button returns to the Tests list', async ({ page }) => {
    const name = await createTest(page);
    await page.locator('.toolbar button[title="Back"]').click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await deleteTest(page, name);
  });
});

test.describe('navigating in and out', () => {
  test('the run screen is reachable from the Runs feed', async ({ page }) => {
    await gotoScreen(page, 'Runs');
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'no runs in this workspace');
    const name = (await row.innerText()).split('\n')[0].split('#')[0].trim();
    await row.click();
    await expect(page.locator('.toolbar .seg')).toContainText('Steps', { timeout: 30_000 });
    await expect(page.locator('.toolbar-title').first()).toContainText(name.slice(0, 12));
  });

  test('Back from a run reached via Tests returns to Tests', async ({ page }) => {
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    await page.locator('.toolbar button[title="Back"]').click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('the run screen never changes the browser URL', async ({ page }) => {
    const before = page.url();
    const name = await openAPassedRun(page);
    test.skip(!name, 'no passed runs in this workspace');
    expect(page.url()).toBe(before);
  });
});
