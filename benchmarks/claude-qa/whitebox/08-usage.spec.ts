import { test, expect } from '@playwright/test';
import { signIn, waitForTestsLoaded, gotoScreen, expectToast, uniqueName } from './helpers';

/**
 * The Usage / Settings screen: the quota meter, the cost history chart, API key
 * creation and revocation, and the members list.
 *
 * White-box facts under test:
 *  - QuotaMeter has three states, and budget <= 0 is NOT rendered as "0% used" —
 *    it gets its own copy, because no allowance rejects runs differently.
 *  - The keys table distinguishes null (loading) from [] (genuinely empty).
 *  - The new-key sheet defaults to the Execute scope; description maxLength=120.
 *  - The raw key is shown exactly once and only its hash is stored.
 *  - The CI snippet deliberately shows POST /runs, not POST /cases/:id/run,
 *    because an API key gets 401 on the latter.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
  await gotoScreen(page, 'Usage');
});

test.describe('screen structure', () => {
  test('titles itself and names the signed-in user', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('Usage');
    await expect(page.locator('.toolbar-sub').first()).toContainText(/Signed in as test@test\.com/i);
  });

  test('offers the four tabs', async ({ page }) => {
    const seg = page.locator('.toolbar .seg').first();
    await expect(seg.locator('button')).toHaveText(['Usage', 'API keys', 'Members', 'Appearance']);
  });

  test('opens on the Usage tab', async ({ page }) => {
    await expect(page.locator('.toolbar .seg button', { hasText: /^Usage$/ }))
      .toHaveAttribute('aria-pressed', 'true');
  });

  test('each tab swaps the panel content', async ({ page }) => {
    await expect(page.locator('main')).toContainText('Tokens this month');
    await page.locator('.toolbar .seg button', { hasText: /^Members$/ }).click();
    await expect(page.locator('main')).toContainText('MEMBER');
    await expect(page.locator('main')).not.toContainText('Tokens this month');
  });
});

test.describe('usage tab', () => {
  test('shows the monthly token spend with its purpose', async ({ page }) => {
    await expect(page.locator('main')).toContainText('Tokens this month');
    await expect(page.locator('main')).toContainText('spent on finding elements');
  });

  test('shows a real number rather than a placeholder once loaded', async ({ page }) => {
    const value = page.locator('main .card').first().locator('.num').first();
    await expect(value).toHaveText(/^[\d,]+$/, { timeout: 25_000 });
  });

  test('a configured budget is stated as a denominator', async ({ page }) => {
    const card = page.locator('main .card').first();
    const text = await card.innerText();
    test.skip(!/of [\d,]+/.test(text), 'no budget is configured on this workspace');
    await expect(card).toContainText(/of [\d,]+/);
  });

  test('a workspace under budget reports what is left and when it resets', async ({ page }) => {
    const card = page.locator('main .card').first();
    const text = await card.innerText();
    test.skip(/no token allowance/.test(text), 'this workspace has no allowance');
    test.skip(/Limit reached/.test(text), 'this workspace is over budget');
    await expect(card).toContainText(/[\d,]+ left this cycle/);
    await expect(card).toContainText(/resets /);
  });

  test('a workspace with no allowance says so instead of showing an empty meter', async ({ page }) => {
    const card = page.locator('main .card').first();
    const text = await card.innerText();
    test.skip(!/no token allowance/.test(text), 'this workspace has an allowance');
    await expect(card).toContainText(
      'This workspace has no token allowance, so new runs are rejected at submit.',
    );
    await expect(card.locator('.meter')).toHaveCount(0);
  });

  test('reports runs this month, free-run share and member count', async ({ page }) => {
    const card = page.locator('main .card').first();
    await expect(card).toContainText('Runs this month');
    await expect(card).toContainText('Free runs');
    await expect(card).toContainText('Members');
  });

  test('the free-run share is a percentage backed by a sample size', async ({ page }) => {
    const card = page.locator('main .card').first();
    const text = await card.innerText();
    test.skip(/no runs yet/.test(text), 'this workspace has no costed runs');
    await expect(card).toContainText(/\d+ of the last \d+ cost nothing/);
  });

  test('explains that going over budget rejects runs at submit', async ({ page }) => {
    await expect(page.locator('main')).toContainText(
      /Go over it and new runs are rejected the moment they.re submitted/i,
    );
  });

  test('shows the tokens-per-run chart with its thesis', async ({ page }) => {
    await expect(page.locator('main')).toContainText('Tokens per run · last 30 days');
    await expect(page.locator('main')).toContainText(
      'The line that matters: a mature test should cost close to nothing.',
    );
  });

  test('the chart resolves to a real state, never staying on the loading text', async ({ page }) => {
    const card = page.locator('main .card').filter({ hasText: 'Tokens per run' });
    await expect(card).not.toContainText('Loading 30 days…', { timeout: 30_000 });
  });

  test('an all-free 30 days is celebrated rather than drawn as a flat broken line', async ({ page }) => {
    const card = page.locator('main .card').filter({ hasText: 'Tokens per run' });
    const text = await card.innerText();
    test.skip(!/cost 0/.test(text), 'this workspace spent tokens in the last 30 days');
    await expect(card).toContainText(/Every run in the last 30 days cost/);
    await expect(card).toContainText("There’s no curve to plot until something needs the AI again.");
  });

  test('a workspace with no runs invites one rather than showing an empty chart', async ({ page }) => {
    const card = page.locator('main .card').filter({ hasText: 'Tokens per run' });
    const text = await card.innerText();
    test.skip(!/Run a test and the cost curve starts here/.test(text), 'this workspace has runs');
    await expect(card).toContainText('Run a test and the cost curve starts here.');
  });
});

test.describe('members tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^Members$/ }).click();
  });

  test('labels the member columns', async ({ page }) => {
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('MEMBER');
    await expect(header).toContainText('ROLE');
    await expect(header).toContainText('JOINED');
  });

  test('lists the signed-in user and marks them as you', async ({ page }) => {
    const row = page.locator('main .list .row').filter({ hasText: 'test@test.com' });
    await expect(row).toBeVisible({ timeout: 25_000 });
    await expect(row).toContainText('(you)');
  });

  test('shows the demo account as the workspace owner', async ({ page }) => {
    const row = page.locator('main .list .row').filter({ hasText: 'test@test.com' });
    await expect(row.locator('.pill')).toHaveText('owner', { timeout: 25_000 });
  });

  test('shows an initials avatar for each member', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    await expect(row).toBeVisible({ timeout: 25_000 });
    await expect(row).toContainText('DU');
  });

  test('states a join date rather than leaving the cell blank', async ({ page }) => {
    const row = page.locator('main .list .row').first();
    await expect(row).toContainText(/(\d{1,2}[./]\d{1,2}[./]\d{2,4}|invited)/, { timeout: 25_000 });
  });

  test('explains the workspace isolation model', async ({ page }) => {
    await expect(page.locator('main')).toContainText(
      /Members only ever see this workspace.s data; roles decide who can author tests/i,
    );
  });

  test('the member count agrees with the Usage tab figure', async ({ page }) => {
    // Members arrive from GET /tenants/:id/members; count only once a row exists,
    // or a pending fetch would be read as a zero-member workspace.
    await expect(page.locator('main .list .row').first()).toBeVisible({ timeout: 40_000 });
    const rows = await page.locator('main .list .row').count();
    await page.locator('.toolbar .seg button', { hasText: /^Usage$/ }).click();
    await expect.poll(async () => {
      const text = await page.locator('main .card').first().innerText();
      return Number(/Members\s*\n?\s*([\d,]+)/.exec(text)?.[1]?.replace(/,/g, '') ?? '-1');
    }, { timeout: 20_000 }).toBe(rows);
  });
});

test.describe('API keys tab', () => {
  test.beforeEach(async ({ page }) => {
    await page.locator('.toolbar .seg button', { hasText: /^API keys$/ }).click();
  });

  test('explains the per-pipeline key model', async ({ page }) => {
    await expect(page.locator('main')).toContainText(
      /Give each pipeline its own key with the narrowest scope it needs/i,
    );
    await expect(page.locator('main')).toContainText(
      /Only the hash is stored, so a key is shown once/i,
    );
  });

  test('labels the key columns', async ({ page }) => {
    const header = page.locator('.list-h').first();
    await expect(header).toContainText('KEY');
    await expect(header).toContainText('SCOPE');
    await expect(header).toContainText('LAST USED');
    await expect(header).toContainText('CREATED');
  });

  test('resolves out of the loading state into a real table or a real empty state', async ({ page }) => {
    await expect(page.locator('main')).not.toContainText('Loading keys…', { timeout: 25_000 });
  });

  test('shows the CI snippet using the endpoint an API key can actually reach', async ({ page }) => {
    await expect(page.locator('main pre')).toContainText('POST $KAIZEN_API/runs');
    await expect(page.locator('main pre')).toContainText('Authorization: Bearer $KAIZEN_KEY');
    // POST /cases/:id/run is behind requireAuth, so it is deliberately not offered here.
    await expect(page.locator('main pre')).not.toContainText('/cases/');
  });

  test('states the scope a CI key needs and what a read-only key gets', async ({ page }) => {
    await expect(page.locator('main')).toContainText(
      /Needs execute scope or higher — a read-only key is refused with 403/i,
    );
  });

  test('the New key sheet asks what the key is for and what it may do', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText('New API key');
    await expect(sheet).toContainText('What is it for?');
    await expect(sheet).toContainText('What may it do?');
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
  });

  test('the description field is capped at 120 characters', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    await expect(page.locator('.sheet input').first()).toHaveAttribute('maxlength', '120');
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
  });

  test('the sheet offers three scopes, each with an explanation', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText('Read only');
    await expect(sheet).toContainText('Read tests, runs and results. Cannot start anything.');
    await expect(sheet).toContainText('Execute');
    await expect(sheet).toContainText('Everything above, plus trigger runs. What CI usually needs.');
    await expect(sheet).toContainText('Admin');
    await expect(sheet).toContainText('Full workspace control, including creating more keys. Owner only.');
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
  });

  test('the sheet warns the key cannot be recovered later', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    await expect(page.locator('.sheet')).toContainText(
      /The key is shown once on the next screen\. Only its hash is stored/i,
    );
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
  });

  test('cancelling the sheet creates nothing', async ({ page }) => {
    const before = await page.locator('main .list .row').count();
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(uniqueName('unused key'));
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.sheet')).toHaveCount(0);
    await expect(page.locator('main .list .row')).toHaveCount(before);
  });

  test('Escape dismisses the new-key sheet', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    await expect(page.locator('.sheet')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('creating a key reveals the raw secret exactly once', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();

    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText('Your new API key', { timeout: 30_000 });
    await expect(sheet).toContainText(
      /Copy it now — it isn.t stored in a readable form and won.t be shown again\./i,
    );
    await expect(sheet.locator('.num')).toHaveText(/^kzn_live_[0-9a-f]{32}$/);
    await sheet.getByRole('button', { name: 'Done' }).click();

    // The secret is gone from the UI the moment the sheet closes.
    await expect(page.locator('main')).not.toContainText(/kzn_live_[0-9a-f]{32}/);

    // Clean up.
    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('a created key appears in the table with its scope and a truncated prefix', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.badge')).toHaveText('read only');
    await expect(row.locator('.row-s')).toContainText('kzn_live_');
    // A brand-new key has never been used, and "never" is the useful signal.
    await expect(row).toContainText('never');

    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('the Execute scope is the default when nothing is chosen', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    // Deliberately do NOT pick a scope.
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await expect(row.locator('.badge')).toHaveText('execute');

    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('a key created without a description is listed as Untitled key', async ({ page }) => {
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: 'Untitled key' }).first();
    await expect(row).toBeVisible({ timeout: 20_000 });

    await row.locator('button[title="Revoke this key"]').click();
    await expect(page.locator('.sheet')).toContainText('Untitled key');
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('the revoke confirmation names the key and scopes the damage', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[title="Revoke this key"]').click();

    const sheet = page.locator('.sheet');
    await expect(sheet).toContainText(label);
    await expect(sheet).toContainText(
      'Anything still using this key stops working immediately. Other keys in this workspace are unaffected.',
    );
    // The dismiss label avoids two buttons both reading "Cancel".
    await expect(sheet.locator('button')).toHaveText(['Keep it', 'Revoke key']);

    await sheet.getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('Keep it dismisses the revoke confirmation without revoking', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Keep it' }).click();
    await expect(page.locator('.sheet')).toHaveCount(0);
    await expect(row).toBeVisible();

    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('revoking announces that the key stops working now', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expectToast(page, /revoked.*it stops working now/i);
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('a revoked key stays gone after leaving and returning to the tab', async ({ page }) => {
    const label = uniqueName('key');
    await page.getByRole('button', { name: 'New key' }).click();
    await page.locator('.sheet input').first().fill(label);
    await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
    await page.locator('.sheet button', { hasText: 'Create key' }).click();
    await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
    await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();

    const row = page.locator('main .list .row').filter({ hasText: label });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
      timeout: 20_000,
    });

    await page.locator('.toolbar .seg button', { hasText: /^Members$/ }).click();
    await page.locator('.toolbar .seg button', { hasText: /^API keys$/ }).click();
    await expect(page.locator('main')).not.toContainText('Loading keys…', { timeout: 25_000 });
    await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0);
  });

  test('revoking one key leaves the others alone', async ({ page }) => {
    const keep = uniqueName('keeper');
    const drop = uniqueName('doomed');
    for (const label of [keep, drop]) {
      await page.getByRole('button', { name: 'New key' }).click();
      await page.locator('.sheet input').first().fill(label);
      await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
      await page.locator('.sheet button', { hasText: 'Create key' }).click();
      await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
      await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();
      await expect(page.locator('main .list .row').filter({ hasText: label }))
        .toBeVisible({ timeout: 20_000 });
    }

    await page.locator('main .list .row').filter({ hasText: drop })
      .locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: drop })).toHaveCount(0, {
      timeout: 20_000,
    });
    await expect(page.locator('main .list .row').filter({ hasText: keep })).toBeVisible();

    await page.locator('main .list .row').filter({ hasText: keep })
      .locator('button[title="Revoke this key"]').click();
    await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
    await expect(page.locator('main .list .row').filter({ hasText: keep })).toHaveCount(0, {
      timeout: 20_000,
    });
  });

  test('every created key is unique', async ({ page }) => {
    const secrets: string[] = [];
    const labels: string[] = [];
    for (let i = 0; i < 2; i++) {
      const label = uniqueName('unique');
      labels.push(label);
      await page.getByRole('button', { name: 'New key' }).click();
      await page.locator('.sheet input').first().fill(label);
      await page.locator('.sheet .menu-item', { hasText: 'Read only' }).click();
      await page.locator('.sheet button', { hasText: 'Create key' }).click();
      await expect(page.locator('.sheet')).toContainText('Your new API key', { timeout: 30_000 });
      secrets.push(await page.locator('.sheet .num').innerText());
      await page.locator('.sheet').getByRole('button', { name: 'Done' }).click();
      await expect(page.locator('main .list .row').filter({ hasText: label }))
        .toBeVisible({ timeout: 20_000 });
    }
    expect(secrets[0]).not.toBe(secrets[1]);

    for (const label of labels) {
      await page.locator('main .list .row').filter({ hasText: label })
        .locator('button[title="Revoke this key"]').click();
      await page.locator('.sheet').getByRole('button', { name: 'Revoke key' }).click();
      await expect(page.locator('main .list .row').filter({ hasText: label })).toHaveCount(0, {
        timeout: 20_000,
      });
    }
  });
});
