import { chromium } from 'playwright';

async function dump(page: any, label: string) {
  console.log(`\n===== ${label} =====`);
  console.log('URL:', page.url());
  console.log('TITLE:', await page.title());
  // Accessibility-ish dump: all visible text of body, trimmed
  const text = await page.evaluate(() => document.body.innerText);
  console.log('--- TEXT ---');
  console.log(text.slice(0, 4000));
  // links
  const links = await page.$$eval('a', (as: any[]) => as.map(a => ({ href: a.getAttribute('href'), text: (a.textContent||'').trim().slice(0,60) })));
  console.log('--- LINKS ---');
  console.log(JSON.stringify(links, null, 1).slice(0, 3000));
  const buttons = await page.$$eval('button', (bs: any[]) => bs.map(b => (b.textContent||'').trim().slice(0,60)).filter(Boolean));
  console.log('--- BUTTONS ---');
  console.log(JSON.stringify(buttons));
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://localhost:3001/login', { waitUntil: 'networkidle' });
  await dump(page, 'LOGIN PAGE');

  await page.getByRole('button', { name: /demo user/i }).click();
  await page.waitForURL('**/tests**', { timeout: 15000 });
  await page.waitForLoadState('networkidle');
  await dump(page, 'TESTS PAGE (after demo login)');

  // Enumerate nav links and visit each
  const navLinks: string[] = await page.$$eval('a', (as: any[]) => as.map(a => a.getAttribute('href')).filter((h: any) => h && h.startsWith('/')));
  const uniq = [...new Set(navLinks)];
  console.log('\nUNIQUE INTERNAL LINKS:', uniq);

  for (const href of uniq) {
    try {
      await page.goto('http://localhost:3001' + href, { waitUntil: 'networkidle', timeout: 15000 });
      await dump(page, 'PAGE ' + href);
    } catch (e: any) {
      console.log('FAILED to visit', href, e.message);
    }
  }

  await browser.close();
})();
