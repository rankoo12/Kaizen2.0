/**
 * Contrast audit — walks every visible text node on every surface of the web app,
 * resolves the effective background, and reports anything unreadable.
 *
 * Written after a white-on-white regression: `text-white` sat on <body> from the old
 * dark theme, so any element that didn't set its own colour inherited it and became
 * invisible once the ground went light. A single reported instance is never the only
 * one, so this measures every surface instead of patching where it was noticed.
 *
 *   node scripts/audit-contrast.mjs                 # fails the run below --fail-under
 *   KZ_EMAIL=… KZ_PASS=… node scripts/audit-contrast.mjs --fail-under 1.6
 *
 * Thresholds: 1.6 catches genuinely invisible text (the bug class). 3.0 is the WCAG
 * floor for large text; 4.5 is AA for body text. The design's tertiary grey sits near
 * 2.5-2.8 by intent, so the default gate is deliberately set at "invisible", not "AA" —
 * raise it once the tertiary token is darkened.
 */
import { createRequire } from 'module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');

const WEB = process.env.KZ_WEB ?? 'http://localhost:4000';
const EMAIL = process.env.KZ_EMAIL ?? 'dev@kaizen.test';
const PASS = process.env.KZ_PASS ?? 'kaizen1234';
/** Every appearance the app ships, so a new skin can't smuggle in unreadable text. */
const APPEARANCES = ['aperture', 'light', 'dark'];
const failUnder = Number(
  process.argv.includes('--fail-under') ? process.argv[process.argv.indexOf('--fail-under') + 1] : 1.6,
);
const report = Number(
  process.argv.includes('--report-under') ? process.argv[process.argv.indexOf('--report-under') + 1] : 3.0,
);

/** Runs in the page. Returns every text/placeholder whose contrast is below `limit`. */
const AUDIT = (limit) => {
  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const rgb = (c) => `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
  /** Nearest ancestor with an opaque background — what the text actually sits on. */
  const bgOf = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const st = getComputedStyle(n);
      const c = parse(st.backgroundColor);
      if (c && c.a > 0.92) return c;
      // The desktop wallpaper is a gradient, so backgroundColor is transparent.
      // Take its darkest stop — assuming white here reported every light-on-wallpaper
      // label (the menu bar in dark mode) as invisible when it reads at ~13:1.
      if (st.backgroundImage && st.backgroundImage !== 'none') {
        const stops = [...st.backgroundImage.matchAll(/rgba?\([^)]+\)/g)].map((m) => parse(m[0])).filter(Boolean);
        if (stops.length) return stops.reduce((a, b) => (lum(a) <= lum(b) ? a : b));
      }
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const path = (el) => {
    const bits = [];
    let n = el;
    for (let i = 0; n && i < 4; i++) {
      let s = n.tagName.toLowerCase();
      if (n.className && typeof n.className === 'string') {
        s += '.' + n.className.trim().split(/\s+/).slice(0, 3).join('.');
      }
      bits.unshift(s);
      n = n.parentElement;
    }
    return bits.join(' > ');
  };

  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('*')) {
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity) < 0.15) continue;
    const box = el.getBoundingClientRect();
    if (!box.width || !box.height) continue;

    const own = [...el.childNodes].filter((n) => n.nodeType === 3)
      .map((n) => n.textContent.trim()).join(' ').trim();
    const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
    if (!own && !isField) continue;

    const bg = bgOf(el);
    const checks = [];
    const fg = parse(st.color);
    if (fg) checks.push({ kind: isField && !own ? 'input text' : 'text', c: over(fg, bg) });
    if (isField) {
      const ph = parse(getComputedStyle(el, '::placeholder').color);
      if (ph) checks.push({ kind: 'placeholder', c: over(ph, bg) });
    }
    for (const ch of checks) {
      const cr = ratio(ch.c, bg);
      if (cr >= limit) continue;
      const key = `${ch.kind}|${path(el)}|${own.slice(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        kind: ch.kind,
        ratio: Math.round(cr * 100) / 100,
        text: (own || el.getAttribute('placeholder') || '(field)').slice(0, 46),
        fg: rgb(ch.c),
        bg: rgb(bg),
        where: path(el),
      });
    }
  }
  return out.sort((a, b) => a.ratio - b.ratio);
};

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1500, height: 940 } })).newPage();
const failures = [];
let reported = 0;

async function check(label) {
  const found = await page.evaluate(AUDIT, report);
  const bad = found.filter((f) => f.ratio < failUnder);
  failures.push(...bad.map((f) => ({ ...f, label })));
  reported += found.length;
  if (!found.length) { console.log(`  ${label}: clean`); return; }
  console.log(`  ${label}: ${found.length} below ${report}:1${bad.length ? `  (${bad.length} INVISIBLE)` : ''}`);
  for (const f of found.slice(0, 8)) {
    const flag = f.ratio < failUnder ? ' ✗' : '';
    console.log(`     ${String(f.ratio).padStart(5)}:1${flag} [${f.kind}] "${f.text}"  ${f.fg} on ${f.bg}`);
  }
}

async function setAppearance(a) {
  await page.evaluate((v) => document.documentElement.setAttribute('data-appearance', v), a);
  await page.waitForTimeout(250);
}

for (const appearance of APPEARANCES) {
  console.log(`\n### ${appearance} — public`);
  for (const [name, url] of [['login', '/login'], ['signup', '/signup']]) {
    await page.goto(WEB + url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('input[type="email"]', { timeout: 60000 });
    await page.waitForTimeout(1200);
    await setAppearance(appearance);
    // Type real text: an empty box hides a foreground/background collision.
    for (const sel of ['input[type="text"]', 'input[type="email"]', 'input[type="password"]']) {
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) await page.locator(sel).nth(i).fill('Sample text 123').catch(() => {});
    }
    await check(`${name} (${appearance})`);
  }
}

await page.goto(`${WEB}/login`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('input[type="email"]', { timeout: 60000 });
await page.waitForTimeout(1500);
await page.fill('input[type="email"]', EMAIL);
await page.fill('input[type="password"]', PASS);
await page.click('button[type="submit"]');
await page.waitForSelector('.win', { timeout: 90000 });
await page.waitForTimeout(2500);

for (const appearance of APPEARANCES) {
  console.log(`\n### ${appearance} — app`);
  await setAppearance(appearance);
  for (const [name, nav] of [['tests', 'Tests'], ['runs', 'Runs'], ['brain', 'The Brain'], ['usage', 'Usage']]) {
    await page.click(`.sidebar .side-item:has-text("${nav}")`);
    await page.waitForTimeout(1600);
    await check(`${name} (${appearance})`);
  }
  await page.click('.sidebar .side-item:has-text("Tests")');
  await page.waitForTimeout(1000);
  await page.click('button:has-text("New Test")');
  await page.waitForTimeout(1400);
  await page.locator('.list input.field').first().fill('navigate to https://example.com').catch(() => {});
  await check(`author (${appearance})`);
  await page.click('.toolbar button:has-text("Cancel")');
  await page.waitForTimeout(1000);
  const row = page.locator('.list .row.focus-row').first();
  if (await row.count()) {
    await row.dblclick();
    await page.waitForTimeout(2500);
    await check(`run detail (${appearance})`);
    await page.click('.toolbar button[title="Back"]').catch(() => {});
    await page.waitForTimeout(900);
  }
}

await browser.close();

console.log(`\n${reported} findings below ${report}:1 · ${failures.length} below ${failUnder}:1`);
if (failures.length) {
  console.error(`\nFAIL — unreadable text:`);
  for (const f of failures) console.error(`  [${f.label}] "${f.text}"  ${f.ratio}:1  ${f.fg} on ${f.bg}\n    ${f.where}`);
  process.exit(1);
}
console.log('PASS — nothing unreadable.');
