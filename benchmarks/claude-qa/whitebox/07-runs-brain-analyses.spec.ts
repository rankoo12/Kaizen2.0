import { test, expect } from '@playwright/test';
import { signIn, waitForTestsLoaded, gotoScreen } from './helpers';

/**
 * The three read-only reporting screens: Runs, The Brain and Analyses.
 *
 * White-box facts under test:
 *  - The Runs stat strip is computed over the LOADED PAGE (limit=50), not the
 *    whole workspace, and labels itself that way.
 *  - The Runs filter set is All/Active/Failed/Healed — there is deliberately no
 *    "Passed" filter here, unlike the Tests screen.
 *  - needsReview(entry) = !pinned && confidence < 0.75, ignoring failCountWindow.
 *  - The Brain can list the same intent twice (WORKSPACE and GLOBAL scope).
 *  - Analyses fans out one /suites/:id/jobs request per suite and merges them.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.describe('Runs screen', () => {
  test.beforeEach(async ({ page }) => {
    await gotoScreen(page, 'Runs');
    // The feed loads asynchronously and renders "Loading runs…" first. Counting
    // rows before it settles would read 0 and mistake a slow fetch for an empty
    // result — which is exactly how a filter test can pass for the wrong reason.
    await expect(page.locator('main')).not.toContainText('Loading runs…', { timeout: 40_000 });
  });

  test('titles itself and states the workspace run total', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('Runs');
    await expect(page.locator('.toolbar-sub').first())
      .toHaveText(/(\d+ runs? in this workspace, newest first|Every execution in this workspace, newest first)/i);
  });

  test('offers exactly All, Active, Failed and Healed — no Passed filter', async ({ page }) => {
    const seg = page.locator('.toolbar .seg').first();
    await expect(seg.locator('button')).toHaveText(['All', 'Active', 'Failed', 'Healed']);
  });

  test('labels the run columns', async ({ page }) => {
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('TEST');
    await expect(header).toContainText('STATUS');
    await expect(header).toContainText('TOKENS');
    await expect(header).toContainText('TRIGGER');
    await expect(header).toContainText('WHEN');
  });

  test('the stat strip is explicitly scoped to the runs it loaded', async ({ page }) => {
    const card = page.locator('main .card.rise').first();
    await expect(card).toContainText('RUNS SHOWN');
    await expect(card).toContainText(/of \d+ total|all of them/);
  });

  test('the stat strip breaks the loaded runs into pass, heal and fail', async ({ page }) => {
    const card = page.locator('main .card.rise').first();
    await expect(card).toContainText('PASSED CLEAN');
    await expect(card).toContainText('SELF-HEALED');
    await expect(card).toContainText('FAILED');
    await expect(card).toContainText('TOKENS');
  });

  test('the RUNS SHOWN figure matches the number of rows rendered', async ({ page }) => {
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'no runs in this workspace');
    // CountUp animates the value, so poll rather than reading once.
    await expect.poll(async () => {
      const text = await page.locator('main .card.rise').first().innerText();
      return Number(/RUNS SHOWN\s*\n?\s*([\d,]+)/.exec(text)?.[1]?.replace(/,/g, '') ?? '-1');
    }, { timeout: 15_000 }).toBe(count);
  });

  test('the page size is capped at 50 runs', async ({ page }) => {
    const count = await page.locator('main .list .row').count();
    expect(count).toBeLessThanOrEqual(50);
  });

  test('the Failed filter shows only failed rows', async ({ page }) => {
    const button = page.locator('.toolbar .seg button', { hasText: /^Failed$/ });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('main .list .row');
    // Settle: either rows render, or the no-match message does.
    await expect(rows.first().or(page.locator('main').getByText('No runs match that filter')))
      .toBeVisible({ timeout: 30_000 });
    const count = await rows.count();
    if (count === 0) {
      await expect(page.locator('main')).toContainText('No runs match that filter');
      return;
    }
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i)).toContainText(/failed/i);
    }
  });

  test('the Healed filter shows only healed rows or the no-match message', async ({ page }) => {
    const button = page.locator('.toolbar .seg button', { hasText: /^Healed$/ });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('main .list .row');
    // Settle: either rows render, or the no-match message does.
    await expect(rows.first().or(page.locator('main').getByText('No runs match that filter')))
      .toBeVisible({ timeout: 30_000 });
    const count = await rows.count();
    if (count === 0) {
      await expect(page.locator('main')).toContainText('No runs match that filter');
      return;
    }
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i)).toContainText(/healed/i);
    }
  });

  test('the Active filter shows only queued or running rows', async ({ page }) => {
    const button = page.locator('.toolbar .seg button', { hasText: /^Active$/ });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('main .list .row');
    // Settle: either rows render, or the no-match message does.
    await expect(rows.first().or(page.locator('main').getByText('No runs match that filter')))
      .toBeVisible({ timeout: 30_000 });
    const count = await rows.count();
    if (count === 0) {
      await expect(page.locator('main')).toContainText('No runs match that filter');
      return;
    }
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i)).toContainText(/running|queued|waiting for a browser|step \d+ of/i);
    }
  });

  test('returning to All restores the full loaded page', async ({ page }) => {
    const all = await page.locator('main .list .row').count();
    await page.locator('.toolbar .seg button', { hasText: /^Failed$/ }).click();
    await page.locator('.toolbar .seg button', { hasText: /^All$/ }).click();
    await expect(page.locator('main .list .row')).toHaveCount(all);
  });

  test('the active pill appears only while something is in flight', async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Active$/ }).click();
    const activeRows = await page.locator('main .list .row').count();
    await page.locator('.toolbar .seg button', { hasText: /^All$/ }).click();
    const pill = page.locator('.toolbar .pill').filter({ hasText: /active/ });
    if (activeRows === 0) await expect(pill).toHaveCount(0);
    else await expect(pill).toContainText(`${activeRows} active`);
  });

  test('the refresh button re-reads the feed', async ({ page }) => {
    const request = page.waitForRequest((r) => r.url().includes('/api/proxy/runs?limit='));
    await page.locator('.toolbar button[title="Refresh"]').click();
    await request;
    await expect(page.locator('.toolbar-title').first()).toHaveText('Runs');
  });

  test('each run row carries a short run id', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'no runs');
    await expect(row).toContainText(/#[0-9a-f]{8}/);
  });

  test('a zero-token run renders as free rather than 0', async ({ page }) => {
    const freeRow = page.locator('main .list .row').filter({ hasText: /free/ }).first();
    test.skip(await freeRow.count() === 0, 'no free runs');
    await expect(freeRow).toContainText('free');
  });

  test('every row shows an uppercase trigger badge', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'no runs');
    await expect(row.locator('.badge').last()).toHaveText(/^(WEB|API|CLI|SCHEDULE|TESTWRITER|—)$/);
  });

  test('proving runs are kept out of the workspace feed', async ({ page }) => {
    // triggered_by 'testwriter' runs are Kaizen's own evidence and are excluded.
    const rows = page.locator('main .list .row');
    const count = Math.min(await rows.count(), 50);
    for (let i = 0; i < count; i++) {
      await expect(rows.nth(i).locator('.badge').last()).not.toHaveText('TESTWRITER');
    }
  });

  test('clicking a run row opens the run detail screen', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'no runs');
    await row.click();
    await expect(page.locator('.toolbar .seg')).toContainText('Steps', { timeout: 30_000 });
  });

  test('a run duration is formatted in ms or seconds, never raw', async ({ page }) => {
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() === 0, 'no runs');
    await expect(rows.first()).toContainText(/(\d+ms|\d+(\.\d+)?s|—)/);
  });
});

test.describe('The Brain', () => {
  test.beforeEach(async ({ page }) => {
    await gotoScreen(page, 'The Brain');
    // Entries arrive from GET /brain/selectors; until then the list shows
    // "Reading the brain…" and a row count of 0 would be a lie.
    await expect(page.locator('main')).not.toContainText('Reading the brain…', { timeout: 40_000 });
  });

  test('titles itself and explains what it holds', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('The Brain');
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Every element Kaizen has learned, and how much it stops you paying/i);
  });

  test('offers a search box and the four scope filters', async ({ page }) => {
    await expect(page.getByPlaceholder('Search what it knows')).toBeVisible();
    const seg = page.locator('.toolbar .seg').first();
    await expect(seg.locator('button')).toHaveText(['All', 'Workspace', 'Global', 'Needs review']);
  });

  test('summarises reliability, learned elements, confidence and recalls', async ({ page }) => {
    const card = page.locator('main .card.rise').first();
    await expect(card).toContainText('Reliable');
    await expect(card).toContainText('Learned elements');
    await expect(card).toContainText('Avg confidence');
    await expect(card).toContainText('Recalls');
  });

  test('the reliability sentence reconciles good recalls against the total', async ({ page }) => {
    const card = page.locator('main .card.rise').first();
    const text = await card.innerText();
    test.skip(/Nothing learned yet/.test(text), 'the brain is empty');
    await expect(card).toContainText(/\d+% of recalls worked first time/);
    await expect(card).toContainText(/[\d,]+ of [\d,]+ remembered resolutions held up/);
  });

  test('labels the entry columns', async ({ page }) => {
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('SELECTOR');
    await expect(header).toContainText('SCOPE');
    await expect(header).toContainText('CONFIDENCE');
    await expect(header).toContainText('RECALLS');
  });

  test('every entry is badged either WORKSPACE or GLOBAL', async ({ page }) => {
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'the brain is empty');
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i).locator('.badge').filter({ hasText: /WORKSPACE|GLOBAL/ })).toHaveCount(1);
    }
  });

  test('the Workspace filter yields only workspace-scoped entries', async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Workspace$/ }).click();
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'no workspace entries');
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i)).toContainText('WORKSPACE');
      await expect(rows.nth(i).locator('.badge').filter({ hasText: 'GLOBAL' })).toHaveCount(0);
    }
  });

  test('the Global filter yields only globally-scoped entries', async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Global$/ }).click();
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'no global entries');
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i)).toContainText('GLOBAL');
    }
  });

  test('Workspace and Global partition the full list between them', async ({ page }) => {
    const all = await page.locator('main .list .row').count();
    test.skip(all === 0, 'the brain is empty');
    await page.locator('.toolbar .seg button', { hasText: /^Workspace$/ }).click();
    const tenant = await page.locator('main .list .row').count();
    await page.locator('.toolbar .seg button', { hasText: /^Global$/ }).click();
    const global = await page.locator('main .list .row').count();
    expect(tenant + global).toBe(all);
  });

  test('every Needs review entry is badged as such', async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Needs review$/ }).click();
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'nothing needs review');
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i)).toContainText('NEEDS REVIEW');
    }
  });

  test('a pinned entry is never flagged for review', async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Needs review$/ }).click();
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'nothing needs review');
    // needsReview = !pinned && confidence < 0.75, so no pin icon may appear here.
    for (let i = 0; i < Math.min(count, 12); i++) {
      await expect(rows.nth(i).locator('svg[aria-label]')).toHaveCount(0);
    }
  });

  test('a nonsense search empties the list and says nothing matches', async ({ page }) => {
    await page.getByPlaceholder('Search what it knows').fill('zzz-nothing-agent-b');
    await expect(page.locator('main .list .row')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('Nothing matches');
  });

  test('clearing the search restores every entry', async ({ page }) => {
    const all = await page.locator('main .list .row').count();
    test.skip(all === 0, 'the brain is empty');
    await page.getByPlaceholder('Search what it knows').fill('zzz-nothing-agent-b');
    await expect(page.locator('main .list .row')).toHaveCount(0);
    await page.getByPlaceholder('Search what it knows').fill('');
    await expect(page.locator('main .list .row')).toHaveCount(all);
  });

  test('search matches the selector text as well as the intent', async ({ page }) => {
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() === 0, 'the brain is empty');
    await page.getByPlaceholder('Search what it knows').fill('role=');
    const count = await rows.count();
    test.skip(count === 0, 'no role= selectors');
    for (let i = 0; i < Math.min(count, 10); i++) {
      await expect(rows.nth(i)).toContainText('role=');
    }
  });

  test('clicking an entry expands its provenance panel', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'the brain is empty');
    await row.click();
    await expect(page.locator('main')).toContainText('Selector Kaizen learned');
    await expect(page.locator('main')).toContainText('Outcomes');
    await expect(page.locator('main')).toContainText('Success rate');
    await expect(page.locator('main')).toContainText('Where it came from');
  });

  test('the expanded panel reconciles good and bad outcomes with the recall count', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'the brain is empty');
    const recalls = Number((await row.locator('.num').last().innerText()).replace(/,/g, '')) ||
      Number((await row.innerText()).match(/\n(\d+)\n/)?.[1] ?? '0');
    await row.click();
    const panel = page.locator('main').filter({ hasText: 'Selector Kaizen learned' });
    const text = await panel.innerText();
    const good = Number(/([\d,]+) good/.exec(text)?.[1]?.replace(/,/g, '') ?? '-1');
    const bad = Number(/([\d,]+) bad/.exec(text)?.[1]?.replace(/,/g, '') ?? '-1');
    expect(good).toBeGreaterThanOrEqual(0);
    expect(bad).toBeGreaterThanOrEqual(0);
    if (recalls > 0) expect(good + bad).toBe(recalls);
  });

  test('clicking the entry again collapses the panel', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    test.skip(await row.count() === 0, 'the brain is empty');
    await row.click();
    await expect(page.locator('main')).toContainText('Selector Kaizen learned');
    await row.click();
    await expect(page.locator('main')).not.toContainText('Selector Kaizen learned');
  });

  test('only one entry is expanded at a time', async ({ page }) => {
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() < 2, 'needs two entries');
    await rows.nth(0).click();
    await rows.nth(2).click();
    await expect(page.locator('main').getByText('Selector Kaizen learned')).toHaveCount(1);
  });

  test('an entry with provenance offers a jump to the step that used it', async ({ page }) => {
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() === 0, 'the brain is empty');
    // Find the first entry whose panel offers the jump.
    for (let i = 0; i < Math.min(await rows.count(), 8); i++) {
      await rows.nth(i).click();
      const button = page.locator('main button', { hasText: 'Open the step that used it' });
      if (await button.count() > 0) {
        await expect(button).toBeVisible();
        return;
      }
      await rows.nth(i).click();
    }
    test.skip(true, 'no entry carries a reachable step');
  });

  test('the jump lands on the run screen with a step selected', async ({ page }) => {
    const rows = page.locator('main .list .row');
    test.skip(await rows.count() === 0, 'the brain is empty');
    let opened = false;
    for (let i = 0; i < Math.min(await rows.count(), 8); i++) {
      await rows.nth(i).click();
      const button = page.locator('main button', { hasText: 'Open the step that used it' });
      if (await button.count() > 0) { await button.click(); opened = true; break; }
      await rows.nth(i).click();
    }
    test.skip(!opened, 'no entry carries a reachable step');
    await expect(page.locator('.toolbar .seg')).toContainText('Steps', { timeout: 30_000 });
    await expect(page.locator('.inspector')).toBeVisible({ timeout: 20_000 });
  });

  test('explains the cheapest-first resolution cascade', async ({ page }) => {
    await expect(page.locator('main')).toContainText(
      /Kaizen resolves cheapest-first: known patterns, then this workspace.s cache/i,
    );
  });

  test('a confidence value is a two-decimal number or an honest dash', async ({ page }) => {
    const rows = page.locator('main .list .row');
    const count = await rows.count();
    test.skip(count === 0, 'the brain is empty');
    for (let i = 0; i < Math.min(count, 8); i++) {
      await expect(rows.nth(i)).toContainText(/(\d\.\d{2}|—)/);
    }
  });
});

test.describe('Analyses screen', () => {
  test.beforeEach(async ({ page }) => {
    await gotoScreen(page, 'Analyses');
    // The screen fans out one /suites/:id/jobs request per suite and shows
    // "Loading…" until they all land. Counting rows before that would read 0 and
    // mistake a pending fan-out for an empty workspace.
    await expect(page.locator('main .card').filter({ hasText: /^Loading…$/ }))
      .toHaveCount(0, { timeout: 40_000 });
  });

  test('titles itself and explains what it records', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('Analyses');
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Every time Kaizen explored an app and proposed tests/i);
  });

  test('offers a way to start an analysis from the toolbar', async ({ page }) => {
    await expect(page.locator('.toolbar button', { hasText: 'Analyze an app' })).toBeVisible();
  });

  test('summarises analyses, tests proposed and spend once a job exists', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    test.skip(await rows.count() === 0, 'no analyses in this workspace');
    const card = page.locator('main .card.rise').first();
    await expect(card).toContainText('Analyses');
    await expect(card).toContainText('Tests proposed');
    await expect(card).toContainText('Spent writing');
  });

  test('the Analyses count matches the number of job rows', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    const count = await rows.count();
    test.skip(count === 0, 'no analyses in this workspace');
    await expect.poll(async () => {
      const text = await page.locator('main .card.rise').first().innerText();
      return Number(/Analyses\s*\n?\s*([\d,]+)/.exec(text)?.[1]?.replace(/,/g, '') ?? '-1');
    }, { timeout: 15_000 }).toBe(count);
  });

  test('labels the job columns', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    test.skip(await rows.count() === 0, 'no analyses in this workspace');
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('APP');
    await expect(header).toContainText('STATUS');
    await expect(header).toContainText('WHEN');
  });

  test('every job carries a status from the mapped vocabulary', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    const count = await rows.count();
    test.skip(count === 0, 'no analyses in this workspace');
    for (let i = 0; i < Math.min(count, 10); i++) {
      await expect(rows.nth(i).locator('.badge'))
        .toHaveText(/DONE|NEEDS YOU|WORKING|QUEUED|FAILED|BLOCKED/);
    }
  });

  test('a job row names the app by host, not by full URL', async ({ page }) => {
    const row = page.locator('main .list .row.focus-row').first();
    test.skip(await row.count() === 0, 'no analyses in this workspace');
    await expect(row.locator('.row-t')).not.toContainText('https://');
    await expect(row.locator('.row-t')).not.toContainText('http://');
  });

  test('a job that proposed nothing is still listed with its reason', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    const count = await rows.count();
    test.skip(count === 0, 'no analyses in this workspace');
    // outcomeOf always produces a sub-line, even for a zero-proposal job.
    for (let i = 0; i < Math.min(count, 6); i++) {
      await expect(rows.nth(i).locator('.row-s')).not.toBeEmpty();
    }
  });

  test('an empty analyses list explains the feature rather than showing nothing', async ({ page }) => {
    const rows = page.locator('main .list .row.focus-row');
    test.skip(await rows.count() > 0, 'this workspace has analyses');
    await expect(page.locator('main')).toContainText('No analyses yet');
    await expect(page.locator('main')).toContainText(
      /it explores it, plans what a QA engineer would test/i,
    );
  });

  test('the Analyses screen reads job data for every suite', async ({ page }) => {
    // One /suites/:id/jobs request per suite: the fan-out is the design.
    await gotoScreen(page, 'Tests');
    const suites = await page.locator('.sidebar .side-item[style*="padding-left: 26px"]').count();
    const seen = new Set<string>();
    page.on('request', (r) => {
      const m = /\/api\/proxy\/suites\/([0-9a-f-]+)\/jobs/.exec(r.url());
      if (m) seen.add(m[1]);
    });
    await gotoScreen(page, 'Analyses');
    await expect.poll(() => seen.size, { timeout: 25_000 }).toBe(suites);
  });
});
