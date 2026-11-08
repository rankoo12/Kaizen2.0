/**
 * Playwright accessible-name contract check.
 *
 *   npx tsx scripts/playwright-aria-contract.ts --write-golden   # record
 *   npx tsx scripts/playwright-aria-contract.ts --check          # compare (exit 1 on drift)
 *
 * Run it INSIDE the worker container (`docker exec kaizen20-worker-1 npx tsx
 * scripts/playwright-aria-contract.ts --check`) — that is where the browsers
 * for the pinned Playwright version live.
 *
 * Why this exists: the DOM pruner patches every candidate's accessible name from
 * the first line of `locator.ariaSnapshot()` (parseAriaSnapshotName), and the
 * selector cache stores `role=X[name="Y"]` strings built from it. If a Playwright
 * upgrade changes the snapshot format OR how names are computed, cached selectors
 * silently stop matching — hot runs degrade into re-resolution, and nothing fails
 * loudly. So before any Playwright bump we compare, per tricky element:
 *   (1) the raw first snapshot line,
 *   (2) the name our parser extracts from it,
 *   (3) whether `role=<role>[name="<name>"]` still resolves to exactly that element.
 * The golden file is the behavior the cached rows in selector_cache were minted under.
 *
 * Spec: docs/specs/roadmap/spec-research-adoption-2026-11.md §S2b
 */
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseAriaSnapshotName } from '../src/modules/dom-pruner/playwright.dom-pruner';

const GOLDEN = join(__dirname, 'fixtures', 'aria-contract.golden.json');

// Mirrors escapeAttr in playwright.dom-pruner.ts (not exported there).
const escapeAttr = (v: string) => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Each case: an id, the markup under test, and why it is in the contract. */
const CASES: Array<{ id: string; html: string; why: string }> = [
  { id: 'plain-button', html: '<button>Sign in</button>', why: 'baseline' },
  { id: 'leading-space-link', html: '<a href="/login"> Signup / Login</a>', why: 'whitespace preserved inside the quotes — the reason ariaSnapshot is used at all' },
  { id: 'inner-newlines-link', html: '<a href="/p">  Pricing\n   page  </a>', why: 'whitespace normalization of inline text' },
  { id: 'img-escaped-quotes', html: '<img src="x.png" alt=\'User avatar "Ada Lovelace"\'>', why: 'escaped quotes inside the name' },
  { id: 'quotes-and-backslash', html: '<button>Say "hi" \\ there</button>', why: 'backslash + quote escaping round-trip' },
  { id: 'aria-label-button', html: '<button aria-label="Close dialog">×</button>', why: 'aria-label wins over content' },
  { id: 'labelled-textbox', html: '<label for="em">Email</label><input id="em" type="text">', why: 'name from <label for>' },
  { id: 'aria-label-textbox', html: '<input type="text" aria-label="Search">', why: 'name from aria-label on an input' },
  { id: 'placeholder-only-textbox', html: '<input type="text" placeholder="Your name">', why: 'no label: does the name fall back to placeholder?' },
  { id: 'wrapped-checkbox', html: '<label><input type="checkbox"> Remember me</label>', why: 'name from a wrapping label' },
  { id: 'css-before-content', html: '<style>.p::before{content:"New: "}</style><button class="p">Save</button>', why: 'CSS ::before content is part of the AX name (pruner comment)' },
  { id: 'combobox', html: '<select aria-label="Role"><option>Student</option><option>Teacher</option></select>', why: 'select → combobox role' },
  { id: 'div-soup-button', html: '<div role="button" tabindex="0" aria-label="Engage reactor">⚡</div>', why: 'ARIA role on a div (nightmare site pattern)' },
  { id: 'icon-only-button', html: '<button><svg width="8" height="8"><circle cx="4" cy="4" r="3"/></svg></button>', why: 'no name → parser must return null' },
  { id: 'hidden-child-text', html: '<button>Buy<span style="display:none">hidden</span></button>', why: 'display:none text excluded from the name' },
  { id: 'heading', html: '<h2>Reactor controls</h2>', why: 'non-interactive role with a name' },
  { id: 'closed-details-text', html: '<details id="d"><summary>More</summary>Secret text</details>', why: 'unrendered text in a closed <details> — Playwright 1.65 changes this; baseline must be recorded before any move past 1.64' },
  { id: 'unassigned-slot-text', html: '<div id="host"><template shadowrootmode="open"><button><slot name="x"></slot>Go</button></template>stray light text</div>', why: 'text not assigned to a slot — also changed in Playwright 1.65' },
];

type Entry = { id: string; rawFirstLine: string; parsedName: string | null; roleSelectorCount: number | null };

async function collect(): Promise<{ playwright: string; chromium: string; entries: Entry[] }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const entries: Entry[] = [];
    for (const c of CASES) {
      await page.setContent(`<!doctype html><html><body><main id="t">${c.html}</main></body></html>`);
      // The candidate under test is the first interactive/named element inside <main>.
      const target = page.locator('#t').locator(':is(button,a,img,input,select,h2,[role="button"],details,#host)').first();
      let snap = '';
      try { snap = (await target.ariaSnapshot()) ?? ''; } catch { snap = '<<ariaSnapshot threw>>'; }
      const rawFirstLine = snap.split('\n', 1)[0] ?? '';
      const parsedName = parseAriaSnapshotName(snap);
      const role = /^-\s+([\w-]+)/.exec(rawFirstLine)?.[1] ?? null;
      let roleSelectorCount: number | null = null;
      if (role && parsedName !== null) {
        roleSelectorCount = await page.locator(`role=${role}[name="${escapeAttr(parsedName)}"]`).count().catch(() => -1);
      }
      entries.push({ id: c.id, rawFirstLine, parsedName, roleSelectorCount });
    }
    return { playwright: require('playwright/package.json').version, chromium: browser.version(), entries };
  } finally {
    await browser.close();
  }
}

async function main() {
  const mode = process.argv.includes('--write-golden') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
  const now = await collect();
  console.log(`playwright ${now.playwright} | chromium ${now.chromium} | ${now.entries.length} cases`);

  if (mode === 'print' || mode === 'write') {
    for (const e of now.entries) {
      console.log(`  ${e.id.padEnd(26)} first="${e.rawFirstLine}"  name=${JSON.stringify(e.parsedName)}  roleSel#=${e.roleSelectorCount}`);
    }
  }

  if (mode === 'write') {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, JSON.stringify({
      note: 'Recorded by scripts/playwright-aria-contract.ts --write-golden. Behavior the cached role= selectors were minted under; re-record deliberately, never to make a check pass.',
      recordedWith: { playwright: now.playwright, chromium: now.chromium },
      entries: now.entries,
    }, null, 2) + '\n');
    console.log(`golden written: ${GOLDEN}`);
    return;
  }

  if (mode === 'check') {
    if (!existsSync(GOLDEN)) { console.error('no golden file — run --write-golden on the CURRENT pinned version first'); process.exit(2); }
    const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as { recordedWith: { playwright: string; chromium: string }; entries: Entry[] };
    console.log(`golden recorded with playwright ${golden.recordedWith.playwright} | chromium ${golden.recordedWith.chromium}`);
    let drift = 0;
    for (const e of now.entries) {
      const g = golden.entries.find((x) => x.id === e.id);
      if (!g) { console.log(`  NEW   ${e.id}`); drift++; continue; }
      const same = g.rawFirstLine === e.rawFirstLine && g.parsedName === e.parsedName && g.roleSelectorCount === e.roleSelectorCount;
      if (same) { console.log(`  same  ${e.id}`); continue; }
      drift++;
      console.log(`  DRIFT ${e.id}`);
      console.log(`        was  first="${g.rawFirstLine}" name=${JSON.stringify(g.parsedName)} roleSel#=${g.roleSelectorCount}`);
      console.log(`        now  first="${e.rawFirstLine}" name=${JSON.stringify(e.parsedName)} roleSel#=${e.roleSelectorCount}`);
    }
    console.log(drift === 0 ? 'CONTRACT HOLDS — no accessible-name drift' : `CONTRACT BROKEN — ${drift} case(s) drifted`);
    process.exit(drift === 0 ? 0 : 1);
  }
}

main().catch((e) => { console.error(e); process.exit(2); });
