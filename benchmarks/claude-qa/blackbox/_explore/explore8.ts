import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  // open run detail from test row
  await page.getByText('Sign in with valid credentials', { exact: true }).first().dblclick();
  await page.waitForTimeout(1500);

  for (const [tab, file] of [['Line', '60-run-line'], ['Activity', '61-run-activity'], ['History', '62-run-history'], ['Steps', '63-run-steps']] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(900);
    await dump(page, file);
  }

  // back to tests via Escape
  await page.keyboard.press('Escape');
  await page.waitForTimeout(700);
  console.log('after escape, on tests?', (await page.evaluate(() => document.body.innerText)).includes('TESTS ACROSS'));

  // kebab menu on a row
  const row = page.locator('.row', { hasText: 'Sign in with valid credentials' }).first();
  await row.hover();
  await page.waitForTimeout(300);
  await row.locator('button').last().click();
  await page.waitForTimeout(600);
  await dump(page, '64-row-kebab');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);

  // Settings tabs
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.waitForTimeout(1200);
  for (const [tab, file] of [['API keys', '65-api-keys'], ['Members', '66-members'], ['Appearance', '67-appearance']] as const) {
    await page.getByRole('button', { name: tab, exact: true }).click();
    await page.waitForTimeout(900);
    await dump(page, file);
  }

  await browser.close();
})();
