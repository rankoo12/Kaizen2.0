import { test, expect } from '@playwright/test';
import {
  signIn, waitForTestsLoaded, openAuthor, nameField, urlField, stepInputs, suiteSelect,
  readSteps, writeSteps, expectToast, uniqueName, gotoScreen,
} from './helpers';

/**
 * The author screen (new / edit test): form fields, suite creation, the "Start from"
 * templates, the step editor, verb parsing, the compile preview and every validation rule.
 *
 * White-box facts under test:
 *  - validate() checks name → url → suite → steps and returns on the FIRST failure,
 *    reporting through a toast (which auto-dismisses after 2600ms).
 *  - The URL rule is /^https?:\/\/.+/ so the initial "https://" fails it.
 *  - Save & Run is disabled when no step has non-blank text.
 *  - "Suggest tests" needs /^https?:\/\/.+\..+/i — a DOT in the host, not just a scheme.
 *  - parseStep matches a verb table by startsWith then " verb ", defaulting to Click,
 *    and NO_LOOKUP = /^(navigate|go to|open |reload|wait|scroll|press|go back)/.
 */

test.beforeEach(async ({ page }) => {
  await signIn(page);
  await waitForTestsLoaded(page);
});

test.describe('form structure', () => {
  test.beforeEach(async ({ page }) => {
    await openAuthor(page);
  });

  test('titles the screen and explains the premise', async ({ page }) => {
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
    await expect(page.locator('.toolbar-sub').first())
      .toContainText(/Write it in English — Kaizen finds the elements at run time/i);
  });

  test('offers Suggest tests, Cancel, Save and Save & Run', async ({ page }) => {
    const toolbar = page.locator('.toolbar').first();
    await expect(toolbar.locator('button', { hasText: 'Suggest tests' })).toBeVisible();
    await expect(toolbar.locator('button', { hasText: /^Cancel$/ })).toBeVisible();
    await expect(toolbar.locator('button', { hasText: /^Save$/ })).toBeVisible();
    await expect(toolbar.locator('button', { hasText: 'Save & Run' })).toBeVisible();
  });

  test('labels the three form fields', async ({ page }) => {
    const labels = await page.locator('.card .label').allInnerTexts();
    expect(labels).toContain('Test name');
    expect(labels).toContain('Suite');
    expect(labels).toContain('Target URL');
  });

  test('autofocuses the name field and leaves it empty', async ({ page }) => {
    await expect(nameField(page)).toBeFocused();
    await expect(nameField(page)).toHaveValue('');
  });

  test('prompts the name field with an example test name', async ({ page }) => {
    await expect(nameField(page)).toHaveAttribute('placeholder', 'Sign in with valid credentials');
  });

  test('seeds the URL field with a bare scheme', async ({ page }) => {
    await expect(urlField(page)).toHaveValue('https://');
  });

  test('starts with exactly one step, prefilled from the URL', async ({ page }) => {
    await expect(stepInputs(page)).toHaveCount(1);
    await expect(stepInputs(page).first()).toHaveValue('navigate to https://');
  });

  test('preselects a real suite in the picker', async ({ page }) => {
    const select = suiteSelect(page);
    await expect(select).toBeVisible();
    const value = await select.inputValue();
    expect(value).not.toBe('');
    const options = await select.locator('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain('No suites yet');
  });

  test('the suite picker lists the same suites as the sidebar', async ({ page }) => {
    const options = await suiteSelect(page).locator('option').allInnerTexts();
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    const sidebar = await page.locator('.sidebar .side-item[style*="padding-left: 26px"]')
      .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\d+$/, '').trim()));
    for (const name of options) expect(sidebar.some((s) => s.startsWith(name))).toBe(true);
  });

  test('explains the placeholder-substitution feature under the step list', async ({ page }) => {
    await expect(page.locator('.scroll').first()).toContainText('No selectors, no waits, no code.');
    await expect(page.locator('.scroll').first()).toContainText('{{name}}');
  });
});

test.describe('inline suite creation', () => {
  test('the + button swaps the picker for a name field', async ({ page }) => {
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    await expect(page.getByPlaceholder('New suite name')).toBeVisible();
    await expect(suiteSelect(page)).toHaveCount(0);
  });

  test('the confirm button is disabled until a name is typed', async ({ page }) => {
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    const confirm = page.locator('.card button[title="Create suite"]');
    await expect(confirm).toBeDisabled();
    await page.getByPlaceholder('New suite name').fill('x');
    await expect(confirm).toBeEnabled();
  });

  test('Escape abandons suite creation and restores the picker', async ({ page }) => {
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    await page.getByPlaceholder('New suite name').fill('AGENT-B abandoned');
    await page.getByPlaceholder('New suite name').press('Escape');
    await expect(page.getByPlaceholder('New suite name')).toHaveCount(0);
    await expect(suiteSelect(page)).toBeVisible();
  });

  test('the cancel icon also restores the picker', async ({ page }) => {
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    await page.locator('.card button[title="Cancel"]').click();
    await expect(page.getByPlaceholder('New suite name')).toHaveCount(0);
    await expect(suiteSelect(page)).toBeVisible();
  });

  test('creating a suite here selects it and announces it', async ({ page }) => {
    const name = uniqueName('AuthorSuite');
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    await page.getByPlaceholder('New suite name').fill(name);
    await page.getByPlaceholder('New suite name').press('Enter');
    await expectToast(page, new RegExp(`suite.*${name}.*created`, 'i'));
    await expect(suiteSelect(page)).toBeVisible();
    const selected = await suiteSelect(page).locator('option:checked').innerText();
    expect(selected).toBe(name);
  });

  test('a suite created here becomes visible to the whole app', async ({ page }) => {
    const name = uniqueName('AuthorSuite');
    await openAuthor(page);
    await page.locator('.card button[title="New suite"]').click();
    await page.getByPlaceholder('New suite name').fill(name);
    await page.getByPlaceholder('New suite name').press('Enter');
    await expect(suiteSelect(page).locator('option:checked')).toHaveText(name);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await expect(page.locator('.sidebar .side-item').filter({ hasText: name })).toBeVisible({
      timeout: 20_000,
    });
  });
});

test.describe('start-from templates', () => {
  test.beforeEach(async ({ page }) => {
    await openAuthor(page);
  });

  test('offers exactly three starters', async ({ page }) => {
    const bar = page.locator('div').filter({ hasText: /^Start from/ }).first();
    await expect(page.locator('.btn', { hasText: /^Sign-in flow$/ })).toBeVisible();
    await expect(page.locator('.btn', { hasText: /^Search a site$/ })).toBeVisible();
    await expect(page.locator('.btn', { hasText: /^Blank$/ })).toBeVisible();
    await expect(bar).toBeVisible();
  });

  test('the Sign-in flow template writes six specific steps', async ({ page }) => {
    await urlField(page).fill('https://shop.example.com');
    await page.locator('.btn', { hasText: /^Sign-in flow$/ }).click();
    await expect(stepInputs(page)).toHaveCount(6);
    expect(await readSteps(page)).toEqual([
      'navigate to https://shop.example.com',
      'dismiss the cookie banner if it appears',
      'type your email in the email field',
      'type your password in the password field',
      'click the "Sign in" button',
      'verify the page contains "Dashboard"',
    ]);
  });

  test('the Search a site template writes four specific steps', async ({ page }) => {
    await urlField(page).fill('https://shop.example.com');
    await page.locator('.btn', { hasText: /^Search a site$/ }).click();
    expect(await readSteps(page)).toEqual([
      'navigate to https://shop.example.com',
      'type "hello" in the search box',
      'press Enter',
      'verify the results list is not empty',
    ]);
  });

  test('the Blank template reduces the list to a single navigate step', async ({ page }) => {
    await urlField(page).fill('https://shop.example.com');
    await page.locator('.btn', { hasText: /^Sign-in flow$/ }).click();
    await expect(stepInputs(page)).toHaveCount(6);
    await page.locator('.btn', { hasText: /^Blank$/ }).click();
    expect(await readSteps(page)).toEqual(['navigate to https://shop.example.com']);
  });

  test('templates build off whatever URL is in the field, not a fake domain', async ({ page }) => {
    await urlField(page).fill('https://agent-b.test.internal/app');
    await page.locator('.btn', { hasText: /^Blank$/ }).click();
    expect(await readSteps(page)).toEqual(['navigate to https://agent-b.test.internal/app']);
  });

  test('an empty URL falls back to the bare scheme in the template', async ({ page }) => {
    await urlField(page).fill('');
    await page.locator('.btn', { hasText: /^Blank$/ }).click();
    expect(await readSteps(page)).toEqual(['navigate to https://']);
  });

  test('a template replaces the existing steps rather than appending to them', async ({ page }) => {
    await writeSteps(page, ['navigate to https://a.com', 'click the thing', 'verify something']);
    await expect(stepInputs(page)).toHaveCount(3);
    await urlField(page).fill('https://b.com');
    await page.locator('.btn', { hasText: /^Blank$/ }).click();
    await expect(stepInputs(page)).toHaveCount(1);
  });
});

test.describe('step editor', () => {
  test.beforeEach(async ({ page }) => {
    await openAuthor(page);
  });

  test('headers the list and counts the steps live', async ({ page }) => {
    await expect(page.locator('.list-h').first()).toContainText('STEPS · PLAIN ENGLISH, IN ORDER');
    await expect(page.locator('.list-h .num').first()).toHaveText('1');
    await page.locator('.list .row').filter({ hasText: 'Add a step' }).click();
    await expect(page.locator('.list-h .num').first()).toHaveText('2');
  });

  test('Add a step appends an empty row', async ({ page }) => {
    await page.locator('.list .row').filter({ hasText: 'Add a step' }).click();
    await expect(stepInputs(page)).toHaveCount(2);
    await expect(stepInputs(page).nth(1)).toHaveValue('');
  });

  test('Enter inside a step inserts a new empty step directly below it', async ({ page }) => {
    await writeSteps(page, ['navigate to https://a.com', 'click the button', 'verify it worked']);
    await stepInputs(page).nth(0).click();
    await stepInputs(page).nth(0).press('Enter');
    const steps = await readSteps(page);
    expect(steps).toEqual(['navigate to https://a.com', '', 'click the button', 'verify it worked']);
  });

  test('Move down swaps a step with the one after it', async ({ page }) => {
    await writeSteps(page, ['first step here', 'second step here', 'third step here']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(0).locator('button[title="Move down"]').click();
    expect(await readSteps(page)).toEqual(['second step here', 'first step here', 'third step here']);
  });

  test('Move up swaps a step with the one before it', async ({ page }) => {
    await writeSteps(page, ['first step here', 'second step here', 'third step here']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(2).locator('button[title="Move up"]').click();
    expect(await readSteps(page)).toEqual(['first step here', 'third step here', 'second step here']);
  });

  test('Move up is disabled on the first step', async ({ page }) => {
    await writeSteps(page, ['first step here', 'second step here']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await expect(rows.nth(0).locator('button[title="Move up"]')).toBeDisabled();
  });

  test('Move down is disabled on the last step', async ({ page }) => {
    await writeSteps(page, ['first step here', 'second step here']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await expect(rows.nth(1).locator('button[title="Move down"]')).toBeDisabled();
  });

  test('a single step has both move buttons disabled', async ({ page }) => {
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await expect(rows).toHaveCount(1);
    await expect(rows.nth(0).locator('button[title="Move up"]')).toBeDisabled();
    await expect(rows.nth(0).locator('button[title="Move down"]')).toBeDisabled();
  });

  test('Remove deletes exactly the step whose button was pressed', async ({ page }) => {
    await writeSteps(page, ['alpha step', 'bravo step', 'charlie step']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(1).locator('button[title="Remove"]').click();
    expect(await readSteps(page)).toEqual(['alpha step', 'charlie step']);
  });

  test('removing every step leaves an empty list and the Add row', async ({ page }) => {
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(0).locator('button[title="Remove"]').click();
    await expect(stepInputs(page)).toHaveCount(0);
    await expect(page.locator('.list .row').filter({ hasText: 'Add a step' })).toBeVisible();
  });

  test('steps are numbered from one, in order', async ({ page }) => {
    await writeSteps(page, ['alpha step', 'bravo step', 'charlie step']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await expect(rows.nth(0)).toContainText('1');
    await expect(rows.nth(1)).toContainText('2');
    await expect(rows.nth(2)).toContainText('3');
  });

  test('reordering renumbers the rows', async ({ page }) => {
    await writeSteps(page, ['alpha step', 'bravo step']);
    const rows = page.locator('.list .row').filter({ has: page.locator('input.field') });
    await rows.nth(0).locator('button[title="Move down"]').click();
    await expect(rows.nth(0).locator('input.field')).toHaveValue('bravo step');
    await expect(rows.nth(0)).toContainText('1');
  });

  test('the step input carries a worked example as its placeholder', async ({ page }) => {
    await expect(stepInputs(page).first())
      .toHaveAttribute('placeholder', /click the .Sign in. button/);
  });
});

test.describe('verb parsing and the compile preview', () => {
  // Every row here is the source VERBS table plus NO_LOOKUP, verified live.
  const cases: Array<[string, string, boolean]> = [
    ['navigate to https://example.com', 'NAVIGATE', false],
    ['go to https://example.com', 'NAVIGATE', false],
    ['open https://example.com', 'NAVIGATE', false],
    ['reload the page', 'NAVIGATE', false],
    ['go back to the previous page', 'NAVIGATE', false],
    ['click the Sign in button', 'CLICK', true],
    ['double-click the row', 'CLICK', true],
    ['right-click the item', 'CLICK', true],
    ['dismiss the cookie banner', 'CLICK', true],
    ['type hello in the search box', 'TYPE', true],
    ['enter my email address', 'TYPE', true],
    ['fill in the form', 'TYPE', true],
    ['press Enter', 'KEY', false],
    ['select the second option', 'SELECT', true],
    ['choose a country', 'SELECT', true],
    ['check the terms box', 'CHECK', true],
    ['uncheck the newsletter box', 'CHECK', true],
    ['drag the handle', 'DRAG', true],
    ['drop it on the target', 'DRAG', true],
    ['scroll to the bottom', 'SCROLL', false],
    ['wait 2 seconds', 'WAIT', false],
    ['switch to the new tab', 'TABS', true],
    ['verify the page contains "Welcome"', 'ASSERT', true],
    ['assert the total is 10', 'ASSERT', true],
    ['expect an error message', 'ASSERT', true],
    ['confirm the order shipped', 'ASSERT', true],
    ['remember the order id', 'CAPTURE', true],
    ['capture the confirmation number', 'CAPTURE', true],
  ];

  for (const [text, verb, lookup] of cases) {
    test(`"${text}" parses as ${verb} and ${lookup ? 'needs' : 'needs no'} a lookup`, async ({ page }) => {
      await openAuthor(page);
      await writeSteps(page, [text]);
      await expect(page.locator('.list .mono-chip').first()).toHaveText(verb);
      const inspector = page.locator('.inspector');
      await expect(inspector.locator('.num').first()).toHaveText(lookup ? '0' : '1');
      await expect(inspector.locator('.num').nth(1)).toHaveText(lookup ? '1' : '0');
    });
  }

  test('unrecognised text falls back to CLICK rather than refusing to parse', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['blah blah something entirely unknown']);
    await expect(page.locator('.list .mono-chip').first()).toHaveText('CLICK');
  });

  test('an empty step shows an em dash instead of a guessed verb', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['']);
    await expect(page.locator('.list .mono-chip').first()).toHaveText('—');
  });

  test('a blank step is excluded from the compiled plan', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['navigate to https://example.com', '   ', 'click the button']);
    // filled counts only non-blank steps: 1 no-lookup + 1 lookup = 2 plan cards.
    await expect(page.locator('.inspector .num').first()).toHaveText('1');
    await expect(page.locator('.inspector .num').nth(1)).toHaveText('1');
  });

  test('the compile preview tallies a mixed list correctly', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, [
      'navigate to https://example.com',   // no lookup
      'wait 2 seconds',                     // no lookup
      'press Enter',                        // no lookup
      'click the Sign in button',           // lookup
      'type hello in the box',              // lookup
      'verify the page contains "X"',       // lookup
    ]);
    await expect(page.locator('.inspector .num').first()).toHaveText('3');
    await expect(page.locator('.inspector .num').nth(1)).toHaveText('3');
  });

  test('the preview explains that only lookups can cost tokens', async ({ page }) => {
    await openAuthor(page);
    const inspector = page.locator('.inspector');
    await expect(inspector).toContainText('What Kaizen will do');
    await expect(inspector).toContainText('Only the element lookups can ever cost tokens.');
    await expect(inspector).toContainText('need no lookup');
    await expect(inspector).toContainText('find an element');
  });

  test('a no-lookup step is badged as a free known pattern in the plan', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['navigate to https://example.com']);
    const card = page.locator('.inspector').locator('div').filter({ hasText: 'navigate to https://example.com' }).last();
    await expect(page.locator('.inspector')).toContainText('PATTERN');
    await expect(page.locator('.inspector')).toContainText('0 tok');
    await expect(card).toBeVisible();
  });

  test('a lookup step is badged LOOKUP with no invented token estimate', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['click the Sign in button']);
    await expect(page.locator('.inspector')).toContainText('LOOKUP');
    await expect(page.locator('.inspector')).not.toContainText('PATTERN');
  });

  test('the compiled plan numbers steps with a zero-padded index', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['navigate to https://a.com', 'click the button']);
    await expect(page.locator('.inspector')).toContainText('01');
    await expect(page.locator('.inspector')).toContainText('02');
  });

  test('an entirely empty plan says so rather than showing an empty box', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['']);
    await expect(page.locator('.inspector')).toContainText('Write a step and it shows up here.');
  });

  test('the preview updates as the step text is edited', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['navigate to https://example.com']);
    await expect(page.locator('.inspector .num').first()).toHaveText('1');
    await stepInputs(page).first().fill('click the Sign in button');
    await expect(page.locator('.inspector .num').first()).toHaveText('0');
    await expect(page.locator('.inspector .num').nth(1)).toHaveText('1');
  });
});

test.describe('validation', () => {
  test.beforeEach(async ({ page }) => {
    await openAuthor(page);
  });

  test('an unnamed test is refused with the name message', async ({ page }) => {
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
  });

  test('a whitespace-only name counts as unnamed', async ({ page }) => {
    await nameField(page).fill('     ');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
  });

  test('the name rule is checked before the URL rule', async ({ page }) => {
    // Both are invalid; validate() returns on the first failure.
    await urlField(page).fill('not-a-url-at-all');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
  });

  test('a URL without a scheme is refused', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('example.com');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /target url needs to start with http:\/\/ or https:\/\//i);
  });

  test('a non-http scheme is refused', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('ftp://example.com');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /target url needs to start with http/i);
  });

  test('the untouched default "https://" is itself refused', async ({ page }) => {
    // The regex demands at least one character after the scheme.
    await nameField(page).fill(uniqueName('Invalid'));
    await expect(urlField(page)).toHaveValue('https://');
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /target url needs to start with http/i);
  });

  test('a plain http URL is accepted by the URL rule', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('http://example.com');
    await writeSteps(page, ['   ']);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    // Passing the URL rule means the next failure is the step rule.
    await expectToast(page, /write at least one step/i);
  });

  test('a URL is trimmed before it is validated', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('   https://example.com   ');
    await writeSteps(page, ['   ']);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /write at least one step/i);
  });

  test('a valid form with only blank steps is refused on the step rule', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('https://example.com');
    await writeSteps(page, ['  ', '   ']);
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /write at least one step/i);
  });

  test('a rejected save never leaves the author screen', async ({ page }) => {
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
  });

  test('a rejected save never posts to the API', async ({ page }) => {
    let posted = false;
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/proxy\/suites\/.+\/cases/.test(r.url())) posted = true;
    });
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
    await page.waitForTimeout(1000);
    expect(posted).toBe(false);
  });

  test('Save & Run runs the same validation as Save', async ({ page }) => {
    await nameField(page).fill(uniqueName('Invalid'));
    await urlField(page).fill('nonsense');
    await page.locator('.toolbar button', { hasText: 'Save & Run' }).click();
    await expectToast(page, /target url needs to start with http/i);
    await expect(page.locator('.toolbar-title').first()).toHaveText('New test');
  });

  test('the validation toast clears itself within a few seconds', async ({ page }) => {
    await page.locator('.toolbar button', { hasText: /^Save$/ }).click();
    await expectToast(page, /give the test a name/i);
    // showToast schedules removal at 2600ms.
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 8_000 });
  });
});

test.describe('button enable rules', () => {
  test('Save is enabled from the moment the screen opens', async ({ page }) => {
    await openAuthor(page);
    await expect(page.locator('.toolbar button', { hasText: /^Save$/ })).toBeEnabled();
  });

  test('Save & Run is disabled when every step is blank', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['   ']);
    await expect(page.locator('.toolbar button', { hasText: 'Save & Run' })).toBeDisabled();
  });

  test('Save & Run becomes enabled once a step has text', async ({ page }) => {
    await openAuthor(page);
    await writeSteps(page, ['   ']);
    await expect(page.locator('.toolbar button', { hasText: 'Save & Run' })).toBeDisabled();
    await writeSteps(page, ['navigate to https://example.com']);
    await expect(page.locator('.toolbar button', { hasText: 'Save & Run' })).toBeEnabled();
  });

  test('Suggest tests is disabled on the bare scheme and says why', async ({ page }) => {
    await openAuthor(page);
    const button = page.locator('.toolbar button', { hasText: 'Suggest tests' });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', 'Enter the page URL first');
  });

  test('Suggest tests needs a dot in the host, not merely a scheme', async ({ page }) => {
    await openAuthor(page);
    const button = page.locator('.toolbar button', { hasText: 'Suggest tests' });
    // Passes the SAVE rule (/^https?:\/\/.+/) but fails the SUGGEST rule (needs \..+).
    await urlField(page).fill('https://localhost');
    await expect(button).toBeDisabled();
    await urlField(page).fill('https://example.com');
    await expect(button).toBeEnabled();
  });

  test('Suggest tests explains its purpose once it is available', async ({ page }) => {
    await openAuthor(page);
    await urlField(page).fill('https://example.com');
    await expect(page.locator('.toolbar button', { hasText: 'Suggest tests' }))
      .toHaveAttribute('title', 'Ask Kaizen what this page is missing');
  });
});

test.describe('cancel', () => {
  test('Cancel abandons the draft and returns to the Tests list', async ({ page }) => {
    await openAuthor(page);
    await nameField(page).fill(uniqueName('Abandoned'));
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('a cancelled draft is never persisted', async ({ page }) => {
    const name = uniqueName('Abandoned');
    await openAuthor(page);
    await nameField(page).fill(name);
    await urlField(page).fill('https://example.com');
    await writeSteps(page, ['navigate to https://example.com']);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await page.getByPlaceholder('Search tests').fill(name);
    await page.waitForTimeout(600);
    await expect(page.locator('.list .row.focus-row')).toHaveCount(0);
  });

  test('the toolbar Back button behaves like Cancel', async ({ page }) => {
    await openAuthor(page);
    await page.locator('.toolbar button[title="Back"]').click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
  });

  test('reopening the author screen after a cancel starts clean', async ({ page }) => {
    await openAuthor(page);
    await nameField(page).fill(uniqueName('Abandoned'));
    await writeSteps(page, ['navigate to https://a.com', 'click the thing']);
    await page.locator('.toolbar button', { hasText: /^Cancel$/ }).click();
    await expect(page.locator('.toolbar-title').first()).toHaveText('Tests');
    await openAuthor(page);
    await expect(nameField(page)).toHaveValue('');
    await expect(stepInputs(page)).toHaveCount(1);
  });
});
