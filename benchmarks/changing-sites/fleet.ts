/**
 * Changing-sites bench — the site fleet registry.
 * Spec: docs/specs/bench/spec-changing-sites.md
 *
 * Each site is served by the compose `sites` nginx under its own hostname
 * alias; the harness swaps benchmarks/sites/<dir>/live/ between versions.
 * `probes` lets the mutator verify a version is ACTUALLY being served before
 * any run starts: __version.txt plus one marker that only that version's
 * content contains.
 */

export type VersionProbe = {
  /** Path to fetch, e.g. '/login.html'. */
  path: string;
  /** Substring that must appear in the response body for this version. */
  contains: string;
};

export type SeedCase = { name: string; path: string; steps: string[] };

export type SiteDef = {
  /** Fleet id — also the directory name under benchmarks/sites/. */
  id: string;
  /** Hostname alias on the compose network (and the selector-cache domain). */
  host: string;
  /** Version dirs in mutation order; live/ starts as versions[0]. */
  versions: string[];
  /** Per-version marker probe (beyond __version.txt). */
  probes: Record<string, VersionProbe>;
  /** Brief file fed to analyze, relative to benchmarks/changing-sites/. */
  brief: string;
  /**
   * Hand-authored coverage-floor cases (bench tests the ENGINE, not the
   * writer): created active before r1 when the generated suite under-covers a
   * mutation. Names are prefixed "SEED:" so reports distinguish them.
   */
  seedCases?: SeedCase[];
};

export const FLEET: SiteDef[] = [
  {
    id: 'vanilla',
    host: 'site-vanilla',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/login.html', contains: 'id="login-submit"' },
      v2: { path: '/login.html', contains: 'id="btn-signin"' },
    },
    brief: 'briefs/brief.vanilla.txt',
  },
  {
    id: 'react-spa',
    host: 'site-react',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/app.js', contains: "'Sign in'" },
      v2: { path: '/app.js', contains: "'Log in'" },
    },
    brief: 'briefs/brief.react-spa.txt',
    seedCases: [
      {
        name: 'SEED: Account sign-in confirms identity',
        path: '/#/account',
        steps: [
          'navigate to http://site-react/#/account',
          'type "ada@example.com" in the "Email address" field',
          'click the "Sign in" button',
          'verify the text "Signed in as ada@example.com." is shown',
        ],
      },
    ],
  },
  {
    id: 'angular-forms',
    host: 'site-angular',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/register.html', contains: 'id="reg-submit"' },
      v2: { path: '/register.html', contains: 'id="reg-submit-link"' },
    },
    brief: 'briefs/brief.angular-forms.txt',
  },
  {
    id: 'vue-cart',
    host: 'site-vue',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/index.html', contains: 'verdant build v1' },
      v2: { path: '/index.html', contains: 'data-decoy' },
    },
    brief: 'briefs/brief.vue-cart.txt',
    seedCases: [
      {
        name: 'SEED: Checkout places the order',
        path: '/',
        steps: [
          'navigate to http://site-vue/',
          'click the first "Add to cart" button',
          'click the "Cart" link',
          'click the "Checkout" button',
          'verify the text "Order placed — thank you!" is shown',
        ],
      },
    ],
  },
  {
    id: 'jquery-classic',
    host: 'site-jquery',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/index.html', contains: 'id="tab-reports"' },
      v2: { path: '/index.html', contains: 'id="faq-accordion"' },
    },
    brief: 'briefs/brief.jquery-classic.txt',
    seedCases: [
      {
        name: 'SEED: Weekly report loads from the Reports tab',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Reports" tab',
          'click the "Load weekly report" button',
          'verify the text "Weekly report ready" is shown',
        ],
      },
      {
        name: 'SEED: Refund policy answer opens',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Refund policy" button',
          'verify the text "Full refund inside 30 days" is shown',
        ],
      },
      {
        name: 'SEED: Announcement modal opens and closes',
        path: '/',
        steps: [
          'navigate to http://site-jquery/',
          'click the "Open announcement" button',
          'verify the text "Scheduled maintenance" is shown',
          'click the "Got it" button',
        ],
      },
    ],
  },
  {
    id: 'stress',
    host: 'site-stress',
    versions: ['v1', 'v2'],
    probes: {
      v1: { path: '/app.js', contains: 'id="refresh-stats"' },
      v2: { path: '/app.js', contains: 'btn-refresh-kpis' },
    },
    brief: 'briefs/brief.stress.txt',
    seedCases: [
      {
        name: 'SEED: Refresh stats confirms',
        path: '/',
        steps: [
          'navigate to http://site-stress/',
          'click the "Refresh stats" button',
          'verify the text "Stats refreshed just now." is shown',
        ],
      },
    ],
  },
];

export function siteById(id: string): SiteDef {
  const site = FLEET.find((s) => s.id === id);
  if (!site) throw new Error(`unknown site '${id}' — known: ${FLEET.map((s) => s.id).join(', ')}`);
  return site;
}
