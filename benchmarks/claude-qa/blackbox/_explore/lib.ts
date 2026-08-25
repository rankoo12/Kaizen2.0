import { chromium, Page, Browser } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

export const OUT = 'C:/Users/Ranko/AppData/Local/Temp/claude/c--Programming-Projects-Kaizen-Kaizen2-0/06f66ec4-c242-4806-994f-c471eac205ec/scratchpad/explore/out';

export async function login(): Promise<{ browser: Browser; page: Page }> {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await page.goto('http://localhost:3001/login');
  await page.getByRole('button', { name: /demo user/i }).click();
  await page.waitForURL('**/tests**', { timeout: 20000 });
  await page.waitForTimeout(1200);
  return { browser, page };
}

export async function dump(page: Page, name: string) {
  fs.mkdirSync(OUT, { recursive: true });
  const text = await page.evaluate(() => document.body.innerText);
  const buttons = await page.$$eval('button', (bs) => bs.map(b => ({ t: (b.textContent || '').trim().slice(0, 90), disabled: (b as HTMLButtonElement).disabled })).filter(b => b.t));
  const inputs = await page.$$eval('input, textarea, select', (els) => els.map((e: any) => ({
    tag: e.tagName, type: e.type, placeholder: e.placeholder, value: (e.value || '').slice(0, 60),
    options: e.tagName === 'SELECT' ? Array.from(e.options).map((o: any) => o.textContent.trim()) : undefined,
  })));
  const out = `URL: ${page.url()}\n\n--- TEXT ---\n${text}\n\n--- BUTTONS ---\n${JSON.stringify(buttons, null, 1)}\n\n--- INPUTS ---\n${JSON.stringify(inputs, null, 1)}\n`;
  fs.writeFileSync(path.join(OUT, name + '.txt'), out);
  console.log('dumped', name, 'textlen', text.length);
}
