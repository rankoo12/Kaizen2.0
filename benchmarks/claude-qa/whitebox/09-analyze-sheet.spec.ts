import { test, expect } from '@playwright/test';
import {
  signIn, waitForTestsLoaded, gotoScreen, openAnalyzeSheet, sheet, uniqueName, openAuthor, urlField,
} from './helpers';

/**
 * The Analyze sheet: consent copy, the two grants, the URL heuristic, the
 * advanced options and the submit gate.
 *
 * ⚠ SAFETY RULE FOR THIS WHOLE FILE ⚠
 * Submitting this dialog starts a long-running background exploration job that
 * outlives the test run. NO test here ever clicks "Start exploring" or
 * "Suggest tests" (the submit). The submit gate is verified by reading the
 * button's `disabled` state and `title` only. Every test dismisses the sheet.
 *
 * White-box facts under test:
 *  - canSubmit = !!suiteId && /^https?:\/\/.+/i.test(url) && !authIncomplete && !busy
 *  - authIncomplete = authScope && !loginCaseId
 *  - looksLikeProduction(url) is TRUE unless the hostname matches
 *    /staging|stage|dev|test|preview|localhost|127\.|\.local/i
 *  - The consent switch's sub-copy changes with its state.
 *  - The signed-in grant is disabled for non-admins; the demo user is an owner,
 *    so it is enabled here.
 */

const URL_FIELD = 'input[placeholder="https://staging.your-app.com"]';
const SUBMIT = 'Start exploring';

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.afterEach(async ({ page }) => {
  // Belt and braces: never leave a sheet open where a stray click could submit it.
  if (await page.locator('.sheet').count() > 0) await page.keyboard.press('Escape');
});

test.describe('opening and dismissing', () => {
  test('the Analyze button opens the sheet with its premise', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText(
      'Kaizen explores it read-only, shows you a test plan, and writes only what you approve.',
    );
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
  });

  test('Cancel closes the sheet', async ({ page }) => {
    await openAnalyzeSheet(page);
    await page.locator('.sheet button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('Escape closes the sheet', async ({ page }) => {
    await openAnalyzeSheet(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('clicking the scrim closes the sheet', async ({ page }) => {
    await openAnalyzeSheet(page);
    await page.locator('.scrim').click({ position: { x: 10, y: 10 } });
    await expect(page.locator('.sheet')).toHaveCount(0);
  });

  test('clicking inside the card does NOT close the sheet', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.click({ position: { x: 50, y: 40 } });
    await expect(page.locator('.sheet')).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('the File menu reaches the same dialog', async ({ page }) => {
    await page.locator('.mb-item', { hasText: /^File$/ }).click();
    await page.locator('.popover .menu-item', { hasText: 'Analyze an app…' }).click();
    await expect(page.locator('.sheet')).toContainText('Analyze an app');
    await page.keyboard.press('Escape');
  });

  test('the Analyses screen reaches the same dialog', async ({ page }) => {
    await gotoScreen(page, 'Analyses');
    await page.locator('.toolbar button', { hasText: 'Analyze an app' }).click();
    await expect(page.locator('.sheet')).toContainText('Analyze an app');
    await page.keyboard.press('Escape');
  });
});

test.describe('form fields', () => {
  test('offers a suite picker prefilled with a real suite', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    const select = s.locator('select').first();
    await expect(select).toBeVisible();
    expect(await select.inputValue()).not.toBe('');
    await page.keyboard.press('Escape');
  });

  test('offers an App URL field with a staging placeholder', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('App URL');
    await expect(s.locator(URL_FIELD)).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('offers an optional app description capped at 8000 characters', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('Describe your app — optional, but it makes the plan sharper');
    await expect(s.locator('textarea')).toHaveAttribute('maxlength', '8000');
    await page.keyboard.press('Escape');
  });

  test('warns not to paste credentials into the description', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText("Don't paste credentials — they're detected and removed.");
    await page.keyboard.press('Escape');
  });

  test('states the expected time and token cost before committing', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText(
      /Standard depth usually takes 2–5 minutes and well under 50k tokens/i,
    );
    await expect(s).toContainText(/Deep scans can take up to 20 minutes/i);
    await page.keyboard.press('Escape');
  });
});

test.describe('the production-URL heuristic', () => {
  test('a production-looking host earns the cautionary notice', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://shop.example.com');
    await expect(s).toContainText('This looks like a production URL.');
    await expect(s).toContainText('A staging environment is the calmer choice.');
    await page.keyboard.press('Escape');
  });

  test('a staging host gets the softer notice instead', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://staging.example.com');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await expect(s).not.toContainText('This looks like a production URL.');
    await page.keyboard.press('Escape');
  });

  test('localhost is treated as non-production', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('http://localhost:3001');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });

  test('a 127.x address is treated as non-production', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('http://127.0.0.1:8080');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });

  test('a .local host is treated as non-production', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://app.mymachine.local');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });

  test('a preview host is treated as non-production', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://preview.example.com');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });

  test('the notice swaps as the URL is edited', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://shop.example.com');
    await expect(s).toContainText('This looks like a production URL.');
    await s.locator(URL_FIELD).fill('https://staging.shop.example.com');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });

  test('an unparseable URL falls back to the softer notice', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('not a url at all');
    await expect(s).toContainText('Use a staging URL if you have one.');
    await page.keyboard.press('Escape');
  });
});

test.describe('the throwaway-data consent', () => {
  test('starts off, and says what "off" means', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('What Kaizen may do on your site');
    await expect(s).toContainText('Allow tests that create throwaway data');
    const consent = s.locator('.switch').first();
    await expect(consent).toHaveAttribute('aria-checked', 'false');
    await expect(s).toContainText(
      'Off: signup and cart tests are still written, but proposed unproven instead of executed.',
    );
    await page.keyboard.press('Escape');
  });

  test('turning it on changes the copy to describe what will be created', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    const consent = s.locator('.switch').first();
    await consent.click();
    await expect(consent).toHaveAttribute('aria-checked', 'true');
    await expect(s).toContainText('Kaizen may create unique per-run records');
    await expect(s).toContainText('Recorded on every job for audit.');
    await page.keyboard.press('Escape');
  });

  test('the consent switch toggles back off', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    const consent = s.locator('.switch').first();
    await consent.click();
    await expect(consent).toHaveAttribute('aria-checked', 'true');
    await consent.click();
    await expect(consent).toHaveAttribute('aria-checked', 'false');
    await expect(s).toContainText('Off: signup and cart tests are still written');
    await page.keyboard.press('Escape');
  });

  test('the exploration disclosure spells out what Kaizen never does', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('What exploration does — and never does').click();
    await expect(s).toContainText('it never submits them');
    await expect(s).toContainText('It obeys robots.txt, stays on your domain');
    await expect(s).toContainText('Buttons that could change data — delete, pay, publish, save');
    await expect(s).toContainText('Checkout tests walk up to the payment step and stop.');
    await page.keyboard.press('Escape');
  });

  test('the exploration disclosure starts collapsed', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('What exploration does — and never does');
    await expect(s).not.toContainText('It obeys robots.txt');
    await page.keyboard.press('Escape');
  });
});

test.describe('the signed-in exploration grant', () => {
  test('is presented in the main form, not buried under Advanced', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('Signed-in exploration');
    await expect(s).toContainText('Let Kaizen sign in and explore as a user');
    await page.keyboard.press('Escape');
  });

  test('starts off with the signed-out explanation', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    const auth = s.locator('.switch').nth(1);
    await expect(auth).toHaveAttribute('aria-checked', 'false');
    await expect(s).toContainText('Off: Kaizen sees only what a signed-out visitor sees.');
    await page.keyboard.press('Escape');
  });

  test('is available to the demo user because they are the workspace owner', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s.locator('.switch').nth(1)).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('turning it on asks which test signs in', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    await page.keyboard.press('Escape');
  });

  test('an incomplete grant disables submit and explains why', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://staging.example.com');
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    // authIncomplete = authScope && !loginCaseId
    const submit = s.locator('button', { hasText: SUBMIT });
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveAttribute(
      'title', 'Pick the test that signs in, or turn signed-in exploration off',
    );
    await page.keyboard.press('Escape');
  });

  test('turning the grant back off restores the submit gate', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://staging.example.com');
    const auth = s.locator('.switch').nth(1);
    await auth.click();
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled({ timeout: 20_000 });
    await auth.click();
    await expect(auth).toHaveAttribute('aria-checked', 'false');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('with no eligible recipe it offers to write one rather than dead-ending', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://no-such-site-agent-b.example');
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    const empty = await s.innerText();
    test.skip(!/No sign-in test/.test(empty), 'this workspace has an eligible recipe for that origin');
    await expect(s).toContainText(
      /A sign-in recipe is an ordinary Kaizen test that logs in; Kaizen runs it to\s+get a session and stores no credentials of its own\./,
    );
    await expect(s.locator('button', { hasText: 'Write a sign-in test' })).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('it distinguishes "none for this site" from "none at all"', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://no-such-site-agent-b.example');
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    const text = await s.innerText();
    test.skip(!/No sign-in test for /.test(text), 'this workspace has no tests at all');
    await expect(s).toContainText(/No sign-in test for .+ yet — your other tests run against a different site\./);
    await page.keyboard.press('Escape');
  });

  test('it recommends a button flow over typing a password', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://no-such-site-agent-b.example');
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    test.skip(!/No sign-in test/.test(await s.innerText()), 'a recipe exists for that origin');
    await expect(s).toContainText(
      /A test that clicks a sign-in button beats one that types a password/,
    );
    await page.keyboard.press('Escape');
  });

  test('the visibility disclosure warns who will see the captures', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Who will be able to see what Kaizen finds', { timeout: 20_000 });
    await s.getByText('Who will be able to see what Kaizen finds').click();
    await expect(s).toContainText(
      /Everyone in this workspace — including viewers and API keys — will be able to see/,
    );
    await expect(s).toContainText(/under a no-training agreement/);
    await page.keyboard.press('Escape');
  });

  test('changing the target origin clears a previously picked recipe', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://the-internet.herokuapp.com');
    await s.locator('.switch').nth(1).click();
    await expect(s).toContainText('Which test signs in?', { timeout: 20_000 });
    const picker = s.locator('select').nth(1);
    test.skip(await picker.count() === 0, 'no eligible recipes for that origin');
    const options = await picker.locator('option').evaluateAll(
      (els) => els.map((e) => (e as HTMLOptionElement).value).filter(Boolean),
    );
    test.skip(options.length === 0, 'no selectable recipes');
    await picker.selectOption(options[0]);
    await expect(s.locator('button', { hasText: SUBMIT })).toBeEnabled();
    // A different origin must invalidate the pick, or the API would reject it.
    await s.locator(URL_FIELD).fill('https://a-different-origin-agent-b.example');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled({ timeout: 20_000 });
    await page.keyboard.press('Escape');
  });
});

test.describe('advanced options', () => {
  test('are collapsed until asked for', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await expect(s).toContainText('▸ Advanced');
    await expect(s).not.toContainText('Exploration depth');
    await page.keyboard.press('Escape');
  });

  test('expand to reveal depth, scenario count and the two checkpoints', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    await expect(s).toContainText('Exploration depth');
    await expect(s).toContainText('Tests to plan');
    await expect(s).toContainText('Pause for my approval after planning');
    await expect(s).toContainText('Prove each test with a real run');
    await page.keyboard.press('Escape');
  });

  test('offer three named exploration depths', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    await expect(s).toContainText('Quick 10');
    await expect(s).toContainText('Standard 30');
    await expect(s).toContainText('Deep 50');
    await page.keyboard.press('Escape');
  });

  test('default to Standard depth', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    await expect(s.locator('.seg button', { hasText: 'Standard 30' }))
      .toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
  });

  test('the scenario count is bounded 1 to 30 and defaults to 6', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    const number = s.locator('input[type="number"]');
    await expect(number).toHaveAttribute('min', '1');
    await expect(number).toHaveAttribute('max', '30');
    await expect(number).toHaveValue('6');
    await page.keyboard.press('Escape');
  });

  test('the scenario count is clamped above its maximum', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    const number = s.locator('input[type="number"]');
    await number.fill('999');
    await expect(number).toHaveValue('30');
    await page.keyboard.press('Escape');
  });

  test('the scenario count is clamped below its minimum', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    const number = s.locator('input[type="number"]');
    await number.fill('0');
    await expect(number).toHaveValue('1');
    await page.keyboard.press('Escape');
  });

  test('a non-numeric scenario count falls back to 1 rather than NaN', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    const number = s.locator('input[type="number"]');
    await number.fill('');
    await expect(number).toHaveValue('1');
    await page.keyboard.press('Escape');
  });

  test('plan approval and proving both default to on for a whole-app analysis', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    const review = s.locator('div').filter({ hasText: /^Pause for my approval after planning$/ })
      .locator('..').locator('.switch');
    await expect(s.locator('.switch').nth(2)).toHaveAttribute('aria-checked', 'true');
    await expect(s.locator('.switch').nth(3)).toHaveAttribute('aria-checked', 'true');
    await expect(review.or(s.locator('.switch').nth(2))).toBeTruthy();
    await page.keyboard.press('Escape');
  });

  test('Advanced collapses again on a second click', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.getByText('Advanced').click();
    await expect(s).toContainText('Exploration depth');
    await s.getByText('Advanced').click();
    await expect(s).not.toContainText('Exploration depth');
    await page.keyboard.press('Escape');
  });
});

test.describe('the submit gate (state only — never pressed)', () => {
  test('an empty URL disables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('a URL without a scheme disables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('example.com');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('a non-http scheme disables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('ftp://example.com');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('a bare scheme with nothing after it disables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeDisabled();
    await page.keyboard.press('Escape');
  });

  test('a well-formed https URL enables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://staging.example.com');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeEnabled();
    // Deliberately not pressed — see the safety rule at the top of this file.
    await page.keyboard.press('Escape');
  });

  test('a well-formed http URL also enables the submit', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('http://staging.example.com');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('surrounding whitespace is tolerated by the gate', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('   https://staging.example.com   ');
    await expect(s.locator('button', { hasText: SUBMIT })).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('dismissing the sheet never starts a job', async ({ page }) => {
    let started = false;
    page.on('request', (r) => {
      if (/\/(analyze|suggest)$/.test(r.url()) && r.method() === 'POST') started = true;
    });
    const s = await openAnalyzeSheet(page);
    await s.locator(URL_FIELD).fill('https://staging.example.com');
    await s.getByText('Advanced').click();
    await s.locator('.switch').first().click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.sheet')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(started).toBe(false);
  });
});

test.describe('inline suite creation inside the sheet', () => {
  test('the New button swaps the picker for a name field', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator('button', { hasText: /^New$/ }).click();
    await expect(s.getByPlaceholder('New suite name')).toBeVisible();
    await expect(s.locator('select')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('Create is disabled until a name is typed', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator('button', { hasText: /^New$/ }).click();
    const create = s.locator('button', { hasText: /^Create$/ });
    await expect(create).toBeDisabled();
    await s.getByPlaceholder('New suite name').fill('x');
    await expect(create).toBeEnabled();
    await page.keyboard.press('Escape');
  });

  test('Cancel restores the picker without creating anything', async ({ page }) => {
    const s = await openAnalyzeSheet(page);
    await s.locator('button', { hasText: /^New$/ }).click();
    await s.getByPlaceholder('New suite name').fill('AGENT-B never created');
    await s.locator('button', { hasText: /^Cancel$/ }).first().click();
    await expect(s.locator('select').first()).toBeVisible();
    await page.keyboard.press('Escape');
  });

  test('creating a suite here selects it and tells the rest of the app', async ({ page }) => {
    const name = uniqueName('SheetSuite');
    const s = await openAnalyzeSheet(page);
    await s.locator('button', { hasText: /^New$/ }).click();
    await s.getByPlaceholder('New suite name').fill(name);
    await s.getByPlaceholder('New suite name').press('Enter');
    await expect(s.locator('select').first()).toBeVisible({ timeout: 20_000 });
    await expect(s.locator('select').first().locator('option:checked')).toHaveText(name);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sidebar .side-item').filter({ hasText: name }))
      .toBeVisible({ timeout: 20_000 });
  });
});

test.describe('the scoped Suggest dialog', () => {
  test('Suggest tests from the author screen opens the scoped variant', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Suggest tests for this page', { timeout: 20_000 });
    await page.keyboard.press('Escape');
  });

  test('the scoped variant explains it only proposes what the suite lacks', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText(
      /proposes only tests your suite doesn.t already have/i, { timeout: 20_000 },
    );
    await page.keyboard.press('Escape');
  });

  test('the scoped variant asks for a Page URL, prefilled with the authored page', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Page URL', { timeout: 20_000 });
    await expect(s.locator(URL_FIELD)).toHaveValue('https://staging.example.com/checkout');
    await page.keyboard.press('Escape');
  });

  test('the scoped variant drops the app-description field', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Page URL', { timeout: 20_000 });
    await expect(s.locator('textarea')).toHaveCount(0);
    await page.keyboard.press('Escape');
  });

  test('the scoped variant estimates the time before you commit', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText(
      /(Checking what Kaizen already knows|Kaizen already knows this app|Kaizen hasn.t explored this app yet)/i,
      { timeout: 25_000 },
    );
    await page.keyboard.press('Escape');
  });

  test('the scoped variant caps the scenario count at 5 and offers no depth control', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Page URL', { timeout: 20_000 });
    await s.getByText('Advanced').click();
    await expect(s.locator('input[type="number"]')).toHaveAttribute('max', '5');
    // A scoped job's budget is one page; offering depth would invite a hidden crawl.
    await expect(s).not.toContainText('Exploration depth');
    await page.keyboard.press('Escape');
  });

  test('the scoped variant defaults the plan checkpoint to off', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Page URL', { timeout: 20_000 });
    await s.getByText('Advanced').click();
    await expect(s).toContainText('Pause for my approval after planning');
    // review defaults to false in suggest mode: choosing the page answers the question.
    await expect(s.locator('.switch').nth(2)).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Escape');
  });

  test('the scoped submit button is labelled Suggest tests', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://staging.example.com/checkout');
    await page.locator('.toolbar button', { hasText: 'Suggest tests' }).click();
    const s = page.locator('.sheet');
    await expect(s).toContainText('Page URL', { timeout: 20_000 });
    await expect(s.locator('button', { hasText: 'Suggest tests' })).toBeVisible();
    await expect(s.locator('button', { hasText: SUBMIT })).toHaveCount(0);
    await page.keyboard.press('Escape');
  });
});
