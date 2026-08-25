import { login, dump, OUT } from './lib';
import * as fs from 'fs';

(async () => {
  const { browser, page } = await login();

  // Inspect a test row DOM
  const rowHtml = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll('tr, [role="row"], li, div')).find(e => (e.textContent || '').includes('Sign in with valid credentials') && (e.textContent || '').length < 400);
    return el ? el.outerHTML.slice(0, 3000) : 'NOT FOUND';
  });
  fs.writeFileSync(OUT + '/50-row-html.txt', rowHtml);

  // Try double click on the row
  await page.getByText('Sign in with valid credentials', { exact: true }).first().dblclick();
  await page.waitForTimeout(1500);
  await dump(page, '51-after-dblclick');

  // Try keyboard: ArrowDown then Enter
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(200);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await dump(page, '52-after-enter');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Runs screen: click a run row
  await page.getByRole('button', { name: 'Runs' }).first().click();
  await page.waitForTimeout(1500);
  await page.getByText('#4ed322cb').first().click();
  await page.waitForTimeout(1500);
  await dump(page, '53-run-detail');

  await browser.close();
})();
