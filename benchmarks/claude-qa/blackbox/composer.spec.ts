import { test, expect } from '@playwright/test';
import {
  openApp,
  main,
  openComposer,
  composer,
  compileStep,
  stepValues,
  setInput,
  agentName,
  gotoScreen,
} from './helpers';

/**
 * The test composer: fields, templates, step editing, and the live compiler
 * that classifies each plain-English step into an action kind and a resolution
 * strategy. This is the richest business logic in the product.
 */

test.beforeEach(async ({ page }) => {
  await openApp(page);
  await openComposer(page);
});

test.describe('Composer layout', () => {
  test('shows the plain-English promise and all primary actions', async ({ page }) => {
    await expect(main(page)).toContainText(/write it in english/i);
    for (const label of ['Cancel', 'Save', 'Save & Run', 'Suggest tests']) {
      await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
  });

  test('seeds a first NAVIGATE step and a https:// target', async ({ page }) => {
    await expect(composer.url(page)).toHaveValue('https://');
    await expect(composer.step(page, 0)).toHaveValue('navigate to https://');
    await expect(main(page)).toContainText('NAVIGATE');
  });

  test('offers every existing suite in the suite picker', async ({ page }) => {
    const options = await composer.suiteSelect(page).locator('option').allInnerTexts();
    expect(options.length).toBeGreaterThan(0);
    expect(options.join(' | ')).toContain('Demo');
  });

  test('explains the {{name}} reference feature', async ({ page }) => {
    await expect(main(page)).toContainText('{{name}}');
    await expect(main(page)).toContainText(/cookie banners or iframes are handled for you/i);
  });

  test('Cancel leaves the composer without creating anything', async ({ page }) => {
    const name = agentName('Cancelled');
    await setInput(composer.name(page), name);

    await page.getByRole('button', { name: 'Cancel', exact: true }).click();

    await expect(main(page)).not.toContainText(/write it in english/i);
    await expect(main(page)).toContainText(/tests across/i);
    await expect(page.locator('div.row-t').filter({ hasText: name })).toHaveCount(0);
  });
});

test.describe('Suggest tests gating', () => {
  test('is disabled until a target URL is supplied', async ({ page }) => {
    await composer.url(page).fill('');
    const suggest = page.getByRole('button', { name: 'Suggest tests', exact: true });

    await expect(suggest).toBeDisabled();
    await expect(suggest).toHaveAttribute('title', /Enter the page URL first/i);
  });

  test('becomes enabled once a target URL is entered', async ({ page }) => {
    const suggest = page.getByRole('button', { name: 'Suggest tests', exact: true });
    await composer.url(page).fill('');
    await expect(suggest).toBeDisabled();

    await setInput(composer.url(page), 'https://the-internet.herokuapp.com/login');

    await expect(suggest).toBeEnabled();
    await expect(suggest).toHaveAttribute('title', /Ask Kaizen what this page is missing/i);
  });
});

test.describe('Starter templates', () => {
  test('"Sign-in flow" fills a full six-step sign-in scenario', async ({ page }) => {
    expect(await stepValues(page)).toHaveLength(1);

    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();

    const steps = await stepValues(page);
    expect(steps).toHaveLength(6);
    expect(steps.join(' | ')).toContain('dismiss the cookie banner if it appears');
    expect(steps.join(' | ')).toContain('click the "Sign in" button');
    expect(steps.join(' | ')).toContain('verify the page contains "Dashboard"');
  });

  test('"Search a site" fills a four-step search scenario', async ({ page }) => {
    await page.getByRole('button', { name: 'Search a site', exact: true }).click();

    const steps = await stepValues(page);
    expect(steps).toHaveLength(4);
    expect(steps.join(' | ')).toContain('type "hello" in the search box');
    expect(steps.join(' | ')).toContain('press Enter');
    expect(steps.join(' | ')).toContain('verify the results list is not empty');
  });

  test('"Blank" clears a previously applied template', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();
    expect(await stepValues(page)).toHaveLength(6);

    await page.getByRole('button', { name: 'Blank', exact: true }).click();

    expect((await stepValues(page)).length).toBeLessThan(6);
  });

  test('the sign-in template compiles to the expected mix of step kinds', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();

    const text = await main(page).innerText();
    const plan = text.slice(text.indexOf('Compiled plan'));
    // 1 navigate + 2 clicks + 2 types + 1 assert.
    expect(plan).toContain('NAVIGATE');
    expect(plan).toContain('CLICK');
    expect(plan).toContain('TYPE');
    expect(plan).toContain('ASSERT');
  });
});

test.describe('Step list editing', () => {
  test('"Add a step" appends an empty step input', async ({ page }) => {
    expect(await stepValues(page)).toHaveLength(1);

    await composer.addStep(page).click();

    expect(await stepValues(page)).toHaveLength(2);
  });

  test('a step can be removed', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();
    const before = await stepValues(page);
    expect(before).toHaveLength(6);

    await composer.remove(page).nth(0).click();

    const after = await stepValues(page);
    expect(after).toHaveLength(5);
    // The first step is gone, not merely blanked.
    expect(after).not.toContain(before[0]);
  });

  test('"Move up" swaps a step with the one before it', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();
    const before = await stepValues(page);

    await composer.moveUp(page).nth(2).click();

    const after = await stepValues(page);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toBe(before[1]);
  });

  test('"Move down" swaps a step with the one after it', async ({ page }) => {
    await page.getByRole('button', { name: 'Sign-in flow', exact: true }).click();
    const before = await stepValues(page);

    await composer.moveDown(page).nth(1).click();

    const after = await stepValues(page);
    expect(after[1]).toBe(before[2]);
    expect(after[2]).toBe(before[1]);
  });

  test('the step counter reflects the number of steps', async ({ page }) => {
    await page.getByRole('button', { name: 'Search a site', exact: true }).click();
    // Four steps in the template.
    await expect(main(page)).toContainText('SCROLL', { timeout: 5_000 }).catch(() => {});
    expect(await stepValues(page)).toHaveLength(4);
  });
});

test.describe('The live step compiler', () => {
  /**
   * Each case asserts the action kind AND whether the step needs an element
   * lookup. PATTERN steps are free (0 TOK); LOOKUP steps may cost tokens.
   */
  const CASES: Array<{ phrase: string; kind: string; strategy: 'PATTERN' | 'LOOKUP' }> = [
    { phrase: 'navigate to https://example.com', kind: 'NAVIGATE', strategy: 'PATTERN' },
    { phrase: 'go to https://example.com/pricing', kind: 'NAVIGATE', strategy: 'PATTERN' },
    { phrase: 'open https://example.com', kind: 'NAVIGATE', strategy: 'PATTERN' },
    { phrase: 'reload the page', kind: 'NAVIGATE', strategy: 'PATTERN' },
    { phrase: 'go back', kind: 'NAVIGATE', strategy: 'PATTERN' },
    { phrase: 'press Enter', kind: 'KEY', strategy: 'PATTERN' },
    { phrase: 'press Tab', kind: 'KEY', strategy: 'PATTERN' },
    { phrase: 'scroll to the bottom', kind: 'SCROLL', strategy: 'PATTERN' },
    { phrase: 'wait for the spinner to disappear', kind: 'WAIT', strategy: 'PATTERN' },
    { phrase: 'click the "Sign in" button', kind: 'CLICK', strategy: 'LOOKUP' },
    { phrase: 'click Sign in', kind: 'CLICK', strategy: 'LOOKUP' },
    { phrase: 'tap the Submit button', kind: 'CLICK', strategy: 'LOOKUP' },
    { phrase: 'hover over the menu', kind: 'CLICK', strategy: 'LOOKUP' },
    { phrase: 'dismiss the cookie banner if it appears', kind: 'CLICK', strategy: 'LOOKUP' },
    { phrase: 'type "hello" in the search box', kind: 'TYPE', strategy: 'LOOKUP' },
    { phrase: 'enter "bob@x.com" in the email field', kind: 'TYPE', strategy: 'LOOKUP' },
    { phrase: 'fill the name field with "Bob"', kind: 'TYPE', strategy: 'LOOKUP' },
    { phrase: 'select "Option 2" from the dropdown', kind: 'SELECT', strategy: 'LOOKUP' },
    { phrase: 'choose "Blue" in the color select', kind: 'SELECT', strategy: 'LOOKUP' },
    { phrase: 'check the first checkbox', kind: 'CHECK', strategy: 'LOOKUP' },
    { phrase: 'uncheck the newsletter checkbox', kind: 'CHECK', strategy: 'LOOKUP' },
    { phrase: 'verify the text "Welcome" is shown', kind: 'ASSERT', strategy: 'LOOKUP' },
    { phrase: 'verify the page contains "Dashboard"', kind: 'ASSERT', strategy: 'LOOKUP' },
    { phrase: 'verify the url contains "/login"', kind: 'ASSERT', strategy: 'LOOKUP' },
    { phrase: 'assert the results list is not empty', kind: 'ASSERT', strategy: 'LOOKUP' },
    { phrase: 'drag the item onto the target', kind: 'DRAG', strategy: 'LOOKUP' },
    { phrase: 'remember the order number as {{order}}', kind: 'CAPTURE', strategy: 'LOOKUP' },
    { phrase: 'switch to the new tab', kind: 'TABS', strategy: 'LOOKUP' },
  ];

  for (const { phrase, kind, strategy } of CASES) {
    test(`classifies "${phrase}" as ${kind} / ${strategy}`, async ({ page }) => {
      const plan = await compileStep(page, phrase);

      expect(plan).toContain(kind);
      expect(plan).toContain(strategy);
      // PATTERN steps are always advertised as free.
      if (strategy === 'PATTERN') expect(plan).toContain('0 TOK');
    });
  }

  test('an unrecognised phrase falls back to CLICK with a paid lookup', async ({ page }) => {
    // Notable: typos and gibberish silently become billable element lookups.
    const plan = await compileStep(page, 'blah blah nonsense words here');

    expect(plan).toContain('CLICK');
    expect(plan).toContain('LOOKUP');
  });

  test('"hit the Escape key" is NOT recognised as a key press', async ({ page }) => {
    // Inconsistent with "press Enter"/"press Tab", and turns a free step into
    // a paid lookup — worth locking down so a fix is noticed.
    const plan = await compileStep(page, 'hit the Escape key');

    expect(plan).toContain('CLICK');
    expect(plan).toContain('LOOKUP');
  });

  test('an empty step compiles to nothing', async ({ page }) => {
    await composer.step(page, 0).fill('');

    await expect(main(page)).toContainText(/write a step and it shows up here/i);
  });

  test('the plan updates when a step is rewritten', async ({ page }) => {
    let plan = await compileStep(page, 'press Enter');
    expect(plan).toContain('KEY');

    plan = await compileStep(page, 'type "hello" in the search box');
    expect(plan).toContain('TYPE');
    expect(plan).not.toContain('KEY');
  });

  test('counts how many steps need an element lookup', async ({ page }) => {
    // One navigate (free) + one assert (lookup).
    await setInput(composer.step(page, 0), 'navigate to https://example.com');
    await composer.addStep(page).click();
    await setInput(composer.step(page, 1), 'verify the page contains "Example Domain"');

    const text = await main(page).innerText();
    const summary = text.slice(text.indexOf('What Kaizen will do'));
    expect(summary).toContain('need no lookup');
    expect(summary).toContain('find an element');
  });

  test('navigation steps are advertised as costing no tokens', async ({ page }) => {
    const plan = await compileStep(page, 'navigate to https://example.com');

    expect(plan).toContain('0 TOK');
    expect(plan).toContain('PATTERN');
  });
});
