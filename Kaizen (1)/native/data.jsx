/* global window */
// Mock domain data mirroring the Kaizen spec (§3). Deterministic — no Math.random at render.

const rnd = (seed) => { let s = seed; return () => (s = (s * 9301 + 49297) % 233280) / 233280; };

const TENANT = {
  name: 'Acme Cloud',
  plan: 'Team',
  user: { name: 'Ada Lovelace', email: 'ada@acme.io', role: 'Owner', initials: 'AL' },
  quota: 2000000,
  used: 1284300,
  cycleEnds: 'Aug 12',
};

const SOURCES = {
  pattern: { label: 'Known pattern', short: 'PATTERN', color: 'var(--cache)', tokens: 0, note: 'Matched a structural pattern Kaizen already trusts for this kind of field.' },
  cache:   { label: 'Cached selector', short: 'CACHE', color: 'var(--cache)', tokens: 0, note: 'Exact selector recalled from this workspace’s memory of the site.' },
  vector:  { label: 'Similarity search', short: 'SIMILAR', color: 'var(--accent)', tokens: 0, note: 'Found by comparing this step to past resolutions on similar pages.' },
  global:  { label: 'Global brain', short: 'GLOBAL', color: 'var(--accent)', tokens: 0, note: 'Verified selector shared across all workspaces for this public site.' },
  llm:     { label: 'AI resolution', short: 'AI', color: 'var(--warn)', tokens: 1, note: 'No memory matched, so the model read the page and picked the element.' },
};

const SUITES = [
  { id: 's-auth', name: 'Authentication', desc: 'Login, signup, SSO, recovery', icon: 'keys' },
  { id: 's-checkout', name: 'Checkout', desc: 'Cart, discounts, payment', icon: 'bolt' },
  { id: 's-discovery', name: 'Search & Discovery', desc: 'Search, filters, sort', icon: 'search' },
  { id: 's-account', name: 'Account', desc: 'Profile, 2FA, exports', icon: 'settings' },
  { id: 's-smoke', name: 'Platform Smoke', desc: 'Cross-cutting baselines', icon: 'globe' },
];

const NAMES = {
  's-auth': ['Sign in with valid credentials', 'Sign in rejects a bad password', 'Forgot-password email sends', 'SSO via Google completes', 'Invite a teammate by email', 'Accept an invite link', 'Two-factor enrolment', 'Session survives a reload', 'Logout clears the session'],
  's-checkout': ['Add a random product to the cart', 'Cart quantity updates the total', 'Discount code applies at checkout', 'Card payment completes', 'Declined card shows a reason', 'Refund from the order page', 'Cookie banner does not block checkout', 'Empty cart shows guidance'],
  's-discovery': ['Search returns relevant results', 'Filter by price band', 'Filter by availability', 'Sort by newest', 'Zero results shows an empty state', 'Pagination loads the next page', 'Saved search persists'],
  's-account': ['Profile name update persists', 'Avatar upload accepts PNG', 'Notification mute by category', 'Export CSV downloads', 'Change email requires re-auth', 'Delete account asks twice', 'Appearance follows the system'],
  's-smoke': ['Marketing homepage loads', 'Docs search is reachable', 'Status page renders', 'Pricing toggle switches term'],
};

function buildCases() {
  const out = [];
  SUITES.forEach((suite, si) => {
    const r = rnd(si * 31 + 7);
    NAMES[suite.id].forEach((name, i) => {
      const v = r();
      const status = v < 0.62 ? 'passed' : v < 0.76 ? 'healed' : v < 0.86 ? 'failed' : 'passed';
      const runs = 9 + Math.floor(r() * 40);
      const cacheHit = Math.min(100, Math.round(58 + r() * 42));
      const firstCost = Math.round(5200 + r() * 6400);
      const lastCost = Math.max(0, Math.round(firstCost * (1 - cacheHit / 104)));
      out.push({
        id: `${suite.id}-${String(i + 1).padStart(2, '0')}`,
        suiteId: suite.id, suiteName: suite.name, name,
        baseUrl: i % 4 === 0 ? 'https://app.acme.io' : 'https://shop.acme.io',
        status, runs, cacheHit, firstCost, lastCost,
        steps: 5 + Math.floor(r() * 6),
        durationMs: Math.round(3400 + r() * 9000),
        lastRun: ['just now', '14m ago', '1h ago', '3h ago', 'yesterday', '2d ago'][Math.floor(r() * 6)],
        learned: 3 + Math.floor(r() * 9),
        author: r() > 0.5 ? 'Ada Lovelace' : 'Marcus Reid',
        ci: r() > 0.45,
      });
    });
  });
  return out;
}

const CASES = buildCases();
const BY_SUITE = SUITES.reduce((a, s) => (a[s.id] = CASES.filter((c) => c.suiteId === s.id), a), {});

// ── The focus case: a live/healed run with full per-step evidence ─────────────
const FOCUS_CASE = CASES[0];

const STEPS = [
  { i: 1, text: 'navigate to https://app.acme.io/login', verb: 'Navigate',
    status: 'passed', source: 'pattern', tokens: 0, ms: 812, selector: 'document', conf: 1,
    shot: 'login', hl: null },
  { i: 2, text: 'dismiss the cookie banner if it appears', verb: 'Click',
    status: 'passed', source: 'global', tokens: 0, ms: 604, selector: 'iframe#consent >>> button[aria-label="Accept all"]', conf: 0.97,
    shot: 'consent', hl: { x: 54, y: 72, w: 32, h: 15 }, frame: 'iframe#consent' },
  { i: 3, text: 'type "ada@acme.io" in the email field', verb: 'Type',
    status: 'passed', source: 'cache', tokens: 0, ms: 388, selector: 'input#email', conf: 0.99,
    shot: 'login', hl: { x: 22, y: 38, w: 56, h: 12 } },
  { i: 4, text: 'type the saved password in the password field', verb: 'Type',
    status: 'healed', source: 'llm', tokens: 1840, ms: 2210, selector: 'input[type="password"][name="pw"]', conf: 0.93,
    shot: 'login', hl: { x: 22, y: 56, w: 56, h: 12 },
    heal: { was: 'input#password', errorClass: 'ELEMENT_NOT_FOUND',
      why: 'The field lost its id and was renamed in the markup.',
      how: 'Re-read the form, matched the label “Password” to the only password input, and re-learned the selector.' } },
  { i: 5, text: 'click the "Sign in" button', verb: 'Click',
    status: 'passed', source: 'cache', tokens: 0, ms: 744, selector: 'button[type="submit"]', conf: 0.99,
    shot: 'login', hl: { x: 22, y: 74, w: 56, h: 12 } },
  { i: 6, text: 'wait for the dashboard to appear', verb: 'Wait',
    status: 'passed', source: 'pattern', tokens: 0, ms: 1932, selector: 'main[data-ready]', conf: 1,
    shot: 'dash', hl: null },
  { i: 7, text: 'select a random project and remember its name', verb: 'Capture',
    status: 'passed', source: 'vector', tokens: 0, ms: 1104, selector: 'ul[data-projects] > li:nth-child(3) a', conf: 0.95,
    shot: 'dash', hl: { x: 8, y: 52, w: 40, h: 11 }, captured: { key: 'project', value: 'Northwind Migration' } },
  { i: 8, text: 'verify the header contains {{project}}', verb: 'Assert',
    status: 'passed', source: 'cache', tokens: 0, ms: 402, selector: 'header h1', conf: 0.98,
    shot: 'project', hl: { x: 8, y: 22, w: 46, h: 12 }, assertion: 'contains "Northwind Migration"' },
  { i: 9, text: 'verify there is 1 item in the activity list', verb: 'Assert',
    status: 'passed', source: 'cache', tokens: 0, ms: 366, selector: '[data-activity] li', conf: 0.98,
    shot: 'project', hl: { x: 8, y: 52, w: 62, h: 22 }, assertion: 'count == 1' },
  { i: 10, text: 'verify the user menu shows "Ada Lovelace"', verb: 'Assert',
    status: 'passed', source: 'global', tokens: 0, ms: 512, selector: 'header [data-user]', conf: 0.96,
    shot: 'project', hl: { x: 74, y: 8, w: 20, h: 10 }, assertion: 'contains "Ada Lovelace"' },
];

const RUN = {
  id: 'run-1284', n: 1284, caseId: FOCUS_CASE.id,
  status: 'healed', env: 'https://app.acme.io', branch: 'main', trigger: 'CI · GitHub Actions',
  startedAt: '14:22:06', ms: 9074, tokens: 1840, cacheSteps: 9, llmSteps: 1,
  prevTokens: 4620, prevMs: 11208,
};

// Run history for the focus case — cost trending toward zero
const HISTORY = Array.from({ length: 16 }, (_, k) => {
  const i = 15 - k; const r = rnd(200 + i)();
  const st = i === 15 ? 'healed' : i > 12 ? (r < 0.5 ? 'healed' : 'passed') : i === 6 ? 'failed' : r < 0.86 ? 'passed' : 'healed';
  return {
    id: `run-${1269 + i}`, n: 1269 + i, status: st,
    tokens: Math.max(0, Math.round(6200 * Math.pow(0.82, i) + (st === 'healed' ? 1600 : 0))),
    ms: Math.round(14200 - i * 340 + r * 1200),
    when: i === 15 ? 'just now' : `${(15 - i) * 3 + 1}h ago`,
    branch: i % 5 === 0 ? 'feature/auth-rework' : 'main',
    trigger: i % 3 === 0 ? 'CI' : 'Manual',
  };
}).reverse();

// ── Global runs feed ─────────────────────────────────────────────────────────
const RUNS_FEED = (() => {
  const r = rnd(77);
  return Array.from({ length: 22 }, (_, i) => {
    const c = CASES[Math.floor(r() * CASES.length)];
    const v = r();
    const st = i === 0 ? 'running' : i === 1 ? 'queued' : v < 0.58 ? 'passed' : v < 0.76 ? 'healed' : v < 0.9 ? 'failed' : 'cancelled';
    return {
      id: `run-${1284 - i}`, n: 1284 - i, name: c.name, suite: c.suiteName, caseId: c.id,
      status: st, ms: Math.round(3200 + r() * 12000), tokens: st === 'passed' ? Math.round(r() * 600) : Math.round(900 + r() * 5200),
      when: i === 0 ? 'now' : `${i * 7 + 2}m ago`, trigger: r() > 0.5 ? 'CI' : 'Manual',
      progress: i === 0 ? 0.6 : 1,
    };
  });
})();

// ── The Brain ────────────────────────────────────────────────────────────────
const BRAIN = [
  { intent: 'the email field', site: 'app.acme.io', selector: 'input#email', conf: 0.99, scope: 'tenant', uses: 214, ok: 214, last: '2m ago', pinned: true },
  { intent: 'the password field', site: 'app.acme.io', selector: 'input[type="password"][name="pw"]', conf: 0.93, scope: 'tenant', uses: 6, ok: 6, last: '2m ago', relearned: true },
  { intent: 'the "Sign in" button', site: 'app.acme.io', selector: 'button[type="submit"]', conf: 0.99, scope: 'tenant', uses: 208, ok: 207, last: '2m ago' },
  { intent: 'cookie consent — accept', site: '*.consent-cdn.net', selector: 'iframe#consent >>> button[aria-label="Accept all"]', conf: 0.97, scope: 'global', uses: 12840, ok: 12771, last: '2m ago' },
  { intent: 'the cart icon', site: 'shop.acme.io', selector: 'a[data-cart]', conf: 0.98, scope: 'tenant', uses: 176, ok: 176, last: '18m ago' },
  { intent: 'the discount code field', site: 'shop.acme.io', selector: 'input[name="promo"]', conf: 0.88, scope: 'tenant', uses: 42, ok: 39, last: '1h ago' },
  { intent: 'the product title on a PDP', site: 'shop.acme.io', selector: 'h1[itemprop="name"]', conf: 0.96, scope: 'global', uses: 3120, ok: 3104, last: '1h ago' },
  { intent: 'the "Place order" button', site: 'shop.acme.io', selector: 'button.checkout-cta', conf: 0.72, scope: 'tenant', uses: 31, ok: 25, last: '4h ago', shaky: true },
  { intent: 'the search input', site: 'shop.acme.io', selector: 'input[role="searchbox"]', conf: 0.99, scope: 'global', uses: 8802, ok: 8790, last: '5h ago' },
  { intent: 'the avatar upload control', site: 'app.acme.io', selector: 'input[type="file"][accept*="png"]', conf: 0.91, scope: 'tenant', uses: 22, ok: 21, last: 'yesterday' },
  { intent: 'the old checkout CTA', site: 'shop.acme.io', selector: '#buy-now-legacy', conf: 0, scope: 'tenant', uses: 4, ok: 0, last: '3d ago', blocked: true },
];

// 30-day cost curve (tokens per run, tenant-wide) — the core promise, trending down
const COST_CURVE = Array.from({ length: 30 }, (_, i) => {
  const r = rnd(500 + i)();
  return { day: i, tokens: Math.round(4800 * Math.pow(0.93, i) + 120 + r * 340), runs: Math.round(28 + r * 46), cacheHit: Math.min(97, Math.round(41 + i * 1.9 + r * 4)) };
});

const API_KEYS = [
  { id: 'k1', name: 'GitHub Actions — main', prefix: 'kz_live_9f2c', scope: 'execute', created: 'Mar 4', last: '2m ago' },
  { id: 'k2', name: 'Grafana dashboard', prefix: 'kz_live_41ab', scope: 'read_only', created: 'Jan 19', last: '1h ago' },
  { id: 'k3', name: 'Ops break-glass', prefix: 'kz_live_c07d', scope: 'admin', created: 'Nov 2', last: '12d ago' },
];

const NAV = [
  { id: 'tests', label: 'Tests', icon: 'tests' },
  { id: 'runs', label: 'Runs', icon: 'runs' },
  { id: 'brain', label: 'The Brain', icon: 'brain' },
  { id: 'usage', label: 'Usage', icon: 'usage' },
];

const fmt = {
  n: (v) => v.toLocaleString('en-US'),
  k: (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(v)),
  ms: (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 2)}s` : `${v}ms`),
  pct: (v) => `${Math.round(v)}%`,
};

Object.assign(window, {
  TENANT, SOURCES, SUITES, CASES, BY_SUITE, FOCUS_CASE, STEPS, RUN, HISTORY,
  RUNS_FEED, BRAIN, COST_CURVE, API_KEYS, NAV, fmt,
});
