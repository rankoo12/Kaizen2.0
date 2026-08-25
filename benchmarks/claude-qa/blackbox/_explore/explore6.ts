import { login, dump } from './lib';

(async () => {
  const { browser, page } = await login();

  // Click a proven test row -> detail
  await page.getByText('Sign in with valid credentials', { exact: true }).first().click();
  await page.waitForTimeout(1500);
  await dump(page, '40-test-detail');
  // find a way back
  const back = page.getByRole('button', { name: /back|close|tests/i }).first();
  console.log('back candidates visible');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  console.log('after esc URL', page.url());
  await dump(page, '41-after-esc-detail');

  await browser.close();
})();
