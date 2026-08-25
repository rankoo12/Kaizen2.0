import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  // New Test — add a step via text, empty-name save validation
  await page.getByRole('button', { name: 'New Test' }).click();
  await page.waitForTimeout(700);
  await page.getByText('Add a step', { exact: true }).click();
  await page.waitForTimeout(400);
  await dump(page, '30-newtest-addstep');

  // Save with empty name
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(800);
  await dump(page, '31-newtest-save-emptyname');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await dump(page, '32-after-escape');

  // Click a proven test row -> detail
  await page.getByText('Sign in with valid credentials', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await dump(page, '33-test-detail');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Draft row: what do Proof / Accept do visually (dump only Proof)
  await page.getByRole('button', { name: 'Proof', exact: true }).click();
  await page.waitForTimeout(1500);
  await dump(page, '34-draft-proof');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Status filters
  await page.getByRole('button', { name: 'Failing', exact: true }).click();
  await page.waitForTimeout(600);
  await dump(page, '35-filter-failing');
  await page.getByRole('button', { name: 'Drafts 1' }).click();
  await page.waitForTimeout(600);
  await dump(page, '36-filter-drafts');
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await page.waitForTimeout(400);

  // Search tests
  await page.getByPlaceholder('Search tests').fill('Checkbox');
  await page.waitForTimeout(700);
  await dump(page, '37-search-checkbox');
  await page.getByPlaceholder('Search tests').fill('');
  await page.waitForTimeout(400);

  // Sidebar suite click
  await page.getByRole('button', { name: /^Checkout smoke/ }).click();
  await page.waitForTimeout(700);
  await dump(page, '38-suite-checkout');

  await browser.close();
})();
