/* global React */

// ─── Mock data ───────────────────────────────────────────────────────────────
// Suite + case shapes mirror the real API but pre-loaded for the prototype.

const TEST_NAMES = [
  'Sign in with valid creds', 'Sign in rejects bad password', 'Forgot password flow',
  'Magic link arrives in inbox', 'SSO via Google succeeds', 'New tenant onboarding',
  'Invite teammate by email', 'Accept invite link', 'Cart adds item from PDP',
  'Cart updates quantity', 'Apply discount code at checkout', 'Stripe checkout completes',
  'Refund initiated from order page', 'Search returns relevant results', 'Filter by price band',
  'Filter by availability', 'Sort by newest', 'Add to wishlist',
  'Share product via link', 'Empty state on zero results', 'Profile name update persists',
  'Avatar upload accepts PNG', 'Two-factor enroll', 'Two-factor recover via SMS',
  'Theme switch updates root', 'Notification mute by category', 'Export CSV download',
  'Pagination loads next page', 'Infinite scroll loads more', 'Bulk select archive',
  'Drag reorder list items', 'Keyboard nav skips disabled rows', 'Modal traps focus',
  'Esc closes modal', 'Tooltip dismiss on blur', 'Toast auto-dismiss after 3s',
  'Idle timeout warns at 14m', 'Session refresh on focus', 'Logout clears tokens',
  'API 500 surfaces friendly error',
];

const SUITES = [
  { id: 's-auth', name: 'Authentication & Identity', description: 'Login, signup, SSO, recovery', count: 12, color: 'primary' },
  { id: 's-checkout', name: 'Checkout & Payments', description: 'Cart, discounts, Stripe', count: 9, color: 'accent' },
  { id: 's-discovery', name: 'Search & Discovery', description: 'Search, filters, sort', count: 7, color: 'primary' },
  { id: 's-account', name: 'Account & Settings', description: 'Profile, 2FA, exports', count: 8, color: 'accent' },
  { id: 's-platform', name: 'Platform Smoke', description: 'Cross-cutting baselines', count: 4, color: 'primary' },
];

// Deterministic rng so the demo grid is stable
function seedRand(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function buildCases() {
  const all = [];
  let nameI = 0;
  SUITES.forEach((suite, sIdx) => {
    const r = seedRand(sIdx * 17 + 3);
    for (let i = 0; i < suite.count; i++) {
      const id = `${suite.id}-${String(i + 1).padStart(2, '0')}`;
      const rand = r();
      let status;
      if (rand < 0.65) status = 'passed';
      else if (rand < 0.80) status = 'failed';
      else if (rand < 0.92) status = 'healed';
      else status = 'pending';
      const dur = Math.round((600 + r() * 11000));
      const tokens = Math.round(2200 + r() * 9000);
      const history = Array.from({ length: 12 }, () => {
        const v = r();
        return v < 0.7 ? 'passed' : v < 0.88 ? 'failed' : 'healed';
      });
      const name = TEST_NAMES[nameI % TEST_NAMES.length];
      nameI++;
      all.push({
        id,
        suiteId: suite.id,
        suiteName: suite.name,
        name,
        baseUrl: 'https://app.acme.io',
        status,
        durationMs: dur,
        tokens,
        history,
        runId: `run-${id}`,
        completedAgo: Math.round(r() * 720), // minutes
        steps: 6 + Math.floor(r() * 4),
        flaky: r() > 0.85,
      });
    }
  });
  return all;
}

const ALL_CASES = buildCases();
const CASES_BY_SUITE = SUITES.reduce((acc, s) => {
  acc[s.id] = ALL_CASES.filter((c) => c.suiteId === s.id);
  return acc;
}, {});

// Detail data for the test-overview demo (use first failed case)
const FOCUS_CASE = ALL_CASES.find((c) => c.status === 'failed') || ALL_CASES[2];

const FOCUS_STEPS = [
  { id: 'st1', text: 'Navigate to https://app.acme.io/login', kind: 'NAV',     status: 'passed', dur: 612, tokens: 240 },
  { id: 'st2', text: 'Type "ada@example.com" into the email field', kind: 'TYPE',  status: 'passed', dur: 380, tokens: 180 },
  { id: 'st3', text: 'Type the saved password into the password field', kind: 'TYPE', status: 'passed', dur: 410, tokens: 192, healed: true, healInfo: 'Selector drift recovered: input[name=password] → input[type=password]' },
  { id: 'st4', text: 'Click the "Sign in" button', kind: 'CLICK', status: 'passed', dur: 720, tokens: 320 },
  { id: 'st5', text: 'Wait for dashboard to load', kind: 'WAIT', status: 'passed', dur: 1840, tokens: 110 },
  { id: 'st6', text: 'Verify the user menu shows "Ada Lovelace"', kind: 'ASSERT', status: 'failed', dur: 980, tokens: 540, error: 'Expected text "Ada Lovelace" but found "ADA L."' },
  { id: 'st7', text: 'Click the user menu and choose "Sign out"', kind: 'CLICK', status: 'pending', dur: 0, tokens: 0 },
];

const FOCUS_RUNS = Array.from({ length: 14 }, (_, i) => {
  const r = seedRand(101 + i);
  const v = r();
  const status = i === 0 ? 'failed' : v < 0.7 ? 'passed' : v < 0.86 ? 'failed' : 'healed';
  return {
    id: `r-${100 - i}`,
    n: 100 - i,
    status,
    durationMs: 4500 + Math.round(r() * 3500),
    when: `${i === 0 ? 'just now' : `${i * 17 + 4}m ago`}`,
    branch: i === 0 ? 'main' : i % 3 === 0 ? 'feature/auth-rework' : 'main',
    tokens: Math.round(2100 + r() * 4000),
  };
});

const NAV_ITEMS = [
  { id: 'tests', label: 'Tests', icon: 'flask', route: '/tests' },
  { id: 'runs', label: 'Runs', icon: 'history', route: '/runs' },
  { id: 'suites', label: 'Suites', icon: 'layers', route: '/suites' },
  { id: 'environments', label: 'Environments', icon: 'globe', route: '/environments' },
  { id: 'integrations', label: 'Integrations', icon: 'link', route: '/integrations' },
];

const NAV_FOOTER = [
  { id: 'settings', label: 'Settings', icon: 'settings', route: '/settings' },
];

window.SUITES = SUITES;
window.ALL_CASES = ALL_CASES;
window.CASES_BY_SUITE = CASES_BY_SUITE;
window.FOCUS_CASE = FOCUS_CASE;
window.FOCUS_STEPS = FOCUS_STEPS;
window.FOCUS_RUNS = FOCUS_RUNS;
window.NAV_ITEMS = NAV_ITEMS;
window.NAV_FOOTER = NAV_FOOTER;
