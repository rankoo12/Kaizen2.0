/**
 * Mock audit — walks every screen and fails if any of the design's fixture content
 * reaches the DOM.
 *
 * The design shipped a full set of sample data (Acme Cloud, Ada Lovelace, shop.acme.io,
 * "Northwind Migration", …). Screens were wired to live data one at a time, and the risk
 * the whole way was a fixture quietly surviving as a fallback — which is exactly what
 * happened: the sidebar fell back to TENANT.user, so a real signed-in workspace could
 * flash "Ada Lovelace". Greping the source is not enough, because a fallback only shows
 * under conditions (null user, empty list) that source review reads straight past.
 *
 *   node scripts/audit-mock.mjs
 *   KZ_EMAIL=… KZ_PASS=… node scripts/audit-mock.mjs
 *
 * Anything intentionally placeholder must carry the MOCK badge from
 * components/design/mock.tsx — this script reports those separately rather than failing,
 * since a labelled placeholder is honest.
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');

const WEB = process.env.KZ_WEB ?? 'http://localhost:4000';
const EMAIL = process.env.KZ_EMAIL ?? 'dev@kaizen.test';
const PASS = process.env.KZ_PASS ?? 'kaizen1234';

/** Strings that only exist in the design's fixtures. Any hit is fabricated content. */
const FIXTURE_STRINGS = [
  'Acme Cloud', 'Ada Lovelace', 'ada@acme.io', 'Marcus Reid',
  'app.acme.io', 'shop.acme.io', 'acme.io',
  'Northwind Migration', 'consent-cdn.net',
  'GitHub Actions — main', 'Grafana dashboard', 'Ops break-glass',
  'kz_live_9f2c', 'kz_live_41ab', 'kz_live_c07d',
  // fixture case names
  'Sign in with valid credentials', 'Sign in rejects a bad password',
  'Add a random product to the cart', 'Discount code applies at checkout',
  'Search returns relevant results', 'Marketing homepage loads',
  // fixture suite names paired with fixture descriptions
  'Login, signup, SSO, recovery', 'Cart, discounts, payment', 'Cross-cutting baselines',
];

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 940 } })).newPage();

const hits = [];
const labelled = [];

async function scan(where) {
  const found = await page.evaluate((needles) => {
    const text = document.body.innerText || '';
    const out = needles.filter((n) => text.includes(n));
    const badges = [...document.querySelectorAll('.badge')]
      .filter((b) => b.textContent.trim() === 'MOCK')
      .map((b) => (b.closest('[style]')?.textContent || b.parentElement?.textContent || '').trim().slice(0, 60));
    return { out, badges };
  }, FIXTURE_STRINGS);
  for (const f of found.out) hits.push({ where, text: f });
  for (const b of found.badges) labelled.push({ where, near: b });
  const state = found.out.length ? `${found.out.length} FIXTURE HIT(S)` : 'clean';
  console.log(`  ${where}: ${state}${found.badges.length ? ` · ${found.badges.length} labelled MOCK` : ''}`);
}

// Public surfaces — checked before sign-in, when user is null and fallbacks show.
for (const [name, url] of [['login', '/login'], ['signup', '/signup']]) {
  await page.goto(WEB + url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"]', { timeout: 60000 });
  await page.waitForTimeout(1000);
  await scan(name);
}

// Sign in and catch the first paint, where an identity fallback would appear.
await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="email"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForSelector('.win', { timeout: 90000 });
await scan('app first paint');
await page.waitForTimeout(2500);

for (const [name, nav] of [['tests', 'Tests'], ['runs', 'Runs'], ['brain', 'The Brain'], ['usage', 'Usage']]) {
  await page.click(`.sidebar .side-item:has-text("${nav}")`);
  await page.waitForTimeout(1600);
  await scan(name);
}

// Usage sub-tabs hold the fixture API keys and members.
await page.click('.sidebar .side-item:has-text("Usage")');
await page.waitForTimeout(1200);
for (const t of ['Members', 'Appearance']) {
  const tab = page.locator(`.seg button:has-text("${t}")`);
  if (await tab.count()) { await tab.click(); await page.waitForTimeout(1000); await scan(`usage · ${t}`); }
}

await page.click('.sidebar .side-item:has-text("Tests")');
await page.waitForTimeout(1200);
await page.click('button:has-text("New Test")');
await page.waitForTimeout(1500);
await scan('author');
await page.click('.toolbar button:has-text("Cancel")');
await page.waitForTimeout(1200);

const row = page.locator('.list .row.focus-row').first();
if (await row.count()) {
  await row.dblclick();
  await page.waitForTimeout(3000);
  await scan('run detail · steps');
  const line = page.locator('.seg button:has-text("Line")');
  if (await line.count()) { await line.click(); await page.waitForTimeout(1500); await scan('run detail · line'); }
  for (const t of ['Activity', 'History']) {
    const tab = page.locator(`.seg button:has-text("${t}")`);
    if (await tab.count()) { await tab.click(); await page.waitForTimeout(1200); await scan(`run detail · ${t}`); }
  }
}

await browser.close();

console.log(`\n${labelled.length} element(s) explicitly labelled MOCK`);
for (const l of labelled) console.log(`  [${l.where}] ${l.near}`);

if (hits.length) {
  console.error(`\nFAIL — design fixture content is reaching the UI:`);
  for (const h of hits) console.error(`  [${h.where}] "${h.text}"`);
  process.exit(1);
}
console.log('\nPASS — no fixture content anywhere. Every screen is on live data.');
