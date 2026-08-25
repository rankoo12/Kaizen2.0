import { chromium, Page } from 'playwright';

async function dump(page: Page, label: string) {
  console.log(`\n===== ${label} =====`);
  console.log('URL:', page.url());
  const text = await page.evaluate(() => document.body.innerText);
  console.log(text.slice(0, 5000));
  const buttons = await page.$$eval('button', (bs) => bs.map(b => (b.textContent || '').trim().slice(0, 80)).filter(Boolean));
  console.log('--- BUTTONS ---', JSON.stringify(buttons));
  const inputs = await page.$$eval('input, textarea, select', (els) => els.map((e: any) => ({ tag: e.tagName, type: e.type, name: e.name, placeholder: e.placeholder, value: (e.value||'').slice(0,40) })));
  console.log('--- INPUTS ---', JSON.stringify(inputs));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3001/login');
  await page.getByRole('button', { name: /demo user/i }).click();
  await page.waitForURL('**/tests**', { timeout: 15000 });
  await page.waitForTimeout(1000);

  for (const nav of ['Runs', 'Analyses', 'The Brain', 'Usage', 'Settings']) {
    await page.getByRole('button', { name: nav, exact: false }).first().click();
    await page.waitForTimeout(1500);
    await dump(page, 'NAV: ' + nav);
  }

  // back to Tests
  await page.getByRole('button', { name: /^Tests/ }).first().click();
  await page.waitForTimeout(1000);

  // menus
  for (const menu of ['File', 'View', 'Account', 'Help']) {
    await page.getByRole('button', { name: menu, exact: true }).click();
    await page.waitForTimeout(600);
    await dump(page, 'MENU: ' + menu);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }

  // New Test dialog
  await page.getByRole('button', { name: 'New Test' }).click();
  await page.waitForTimeout(1000);
  await dump(page, 'NEW TEST DIALOG');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Analyze dialog
  await page.getByRole('button', { name: 'Analyze', exact: true }).click();
  await page.waitForTimeout(1000);
  await dump(page, 'ANALYZE DIALOG');
  await page.keyboard.press('Escape');

  await browser.close();
})();
