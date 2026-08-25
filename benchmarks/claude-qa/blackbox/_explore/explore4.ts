import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  // --- New Test dialog deep dive ---
  await page.getByRole('button', { name: 'New Test' }).click();
  await page.waitForTimeout(800);
  await dump(page, '20-newtest-default');

  // Sign-in flow template
  await page.getByRole('button', { name: 'Sign-in flow' }).click();
  await page.waitForTimeout(500);
  await dump(page, '21-newtest-signin-template');

  // Search a site template
  await page.getByRole('button', { name: 'Search a site' }).click();
  await page.waitForTimeout(500);
  await dump(page, '22-newtest-search-template');

  // Blank
  await page.getByRole('button', { name: 'Blank', exact: true }).click();
  await page.waitForTimeout(500);
  await dump(page, '23-newtest-blank');

  // Try typing a step and see compiled plan
  const stepInput = page.getByPlaceholder(/click the/i).first();
  await stepInput.fill('navigate to https://example.com');
  await page.waitForTimeout(300);
  // Add a step
  await page.getByRole('button', { name: /add a step/i }).click();
  await page.waitForTimeout(300);
  const inputs = page.locator('input[placeholder*="click the"], input[placeholder*="step"]');
  console.log('step inputs count:', await inputs.count());
  await dump(page, '24-newtest-steps');

  // Try Save with empty name — validation?
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.waitForTimeout(600);
  await dump(page, '25-newtest-save-empty-name');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Suggest tests button
  await page.getByRole('button', { name: 'New Test' }).click();
  await page.waitForTimeout(600);
  await page.getByRole('button', { name: 'Suggest tests' }).click();
  await page.waitForTimeout(1500);
  await dump(page, '26-newtest-suggest');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // --- Click a test row (existing, not draft) ---
  await page.getByText('Sign in with valid credentials').first().click();
  await page.waitForTimeout(1200);
  await dump(page, '27-test-detail');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Draft test row
  await page.getByText('Sign-in rejects a wrong username on /login').first().click();
  await page.waitForTimeout(1200);
  await dump(page, '28-draft-detail');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  await browser.close();
})();
