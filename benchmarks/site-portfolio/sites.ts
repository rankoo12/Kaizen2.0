/**
 * Site-portfolio bench — real-app registry.
 * Spec: docs/specs/bench/spec-site-portfolio.md §3, §7 (gate verdicts)
 *
 * URLs are the WORKER's view (compose-network aliases). Every site carries a
 * PROBE-MUSTFAIL seed — a case that must fail honestly in every phase; a
 * green probe is a FALSE-PASS and fails the leg (lib/log.ts judgeLearning).
 * Seeds are the coverage floor; the writer's generated cases ride on top.
 */
export type SeedCase = { name: string; path: string; steps: string[] };

export type PortfolioSite = {
  id: string;
  kind: 'real' | 'nightmare';
  /** Base URL as the worker resolves it. */
  url: string;
  brief: string; // relative to this dir
  analyze: { maxPages: number; maxScenarios: number };
  /** Static list, or a lazy builder for sites whose seeds embed TEMP-held
   * credentials (wp-admin) — called only when THIS site's leg runs. */
  seedCases: SeedCase[] | (() => SeedCase[]);
  /** Printed before cold runs as the operator checklist (container resets etc.). */
  preflightNote?: string;
  /**
   * Authenticated-scope leg (§5 isolation testbed): a loader (NOT a literal —
   * credentials live in TEMP, never in the repo) returning the fixed-creds
   * sign-in case the analyze route demands as loginCaseId.
   */
  auth?: { loginSeed: () => SeedCase };
};

export const PORTFOLIO: PortfolioSite[] = [
  {
    id: 'internet',
    kind: 'real',
    url: 'http://site-internet:5000',
    brief: 'briefs/brief.internet.txt',
    analyze: { maxPages: 6, maxScenarios: 8 },
    seedCases: [
      {
        name: 'SEED: Form auth logs in and out',
        path: '/login',
        steps: [
          'navigate to http://site-internet:5000/login',
          'type "tomsmith" in the "Username" field',
          'type "SuperSecretPassword!" in the "Password" field',
          'click the "Login" button',
          'verify the text "You logged into a secure area!" is shown',
          'click the "Logout" button',
          'verify the text "You logged out of the secure area!" is shown',
        ],
      },
      {
        name: 'SEED: Dynamic loading renders Hello World',
        path: '/dynamic_loading/1',
        steps: [
          'navigate to http://site-internet:5000/dynamic_loading/1',
          'click the "Start" button',
          'verify the text "Hello World!" is shown',
        ],
      },
      {
        name: 'SEED: Add and remove an element',
        path: '/add_remove_elements/',
        steps: [
          'navigate to http://site-internet:5000/add_remove_elements/',
          'click the "Add Element" button',
          'click the "Delete" button',
          'verify the text "Delete" is not shown',
        ],
      },
      {
        name: 'SEED: Dropdown selects option 2',
        path: '/dropdown',
        steps: [
          'navigate to http://site-internet:5000/dropdown',
          'select "Option 2" in the dropdown',
          'verify the dropdown contains "Option 2"',
        ],
      },
      {
        name: 'PROBE-MUSTFAIL: asserts text that never exists',
        path: '/',
        steps: [
          'navigate to http://site-internet:5000/',
          'verify the text "Kaizen portfolio impossibility marker 9c41" is shown',
        ],
      },
    ],
  },
  {
    id: 'juice',
    kind: 'real',
    url: 'http://site-juice:3000',
    brief: 'briefs/brief.juice.txt',
    analyze: { maxPages: 5, maxScenarios: 8 },
    preflightNote: 'recreate the site-juice container before a tenant leg (challenge state accumulates server-side)',
    seedCases: [
      {
        // Round-1 lesson: this version of Juice Shop has NO cookie-consent
        // banner ("Me want it!" is older-release memory; i18n has no such
        // string) — only the welcome dialog's Dismiss is real. Probe the live
        // page before authoring seeds.
        name: 'SEED: Dismiss the welcome banner and search for apple',
        path: '/#/',
        steps: [
          'navigate to http://site-juice:3000/#/',
          'click the "Dismiss" button',
          'click the search icon',
          'type "apple" in the search field',
          'press Enter',
          'verify the text "Apple Juice" is shown',
        ],
      },
      {
        name: 'SEED: Product dialog opens with details',
        path: '/#/',
        steps: [
          'navigate to http://site-juice:3000/#/',
          'click the "Dismiss" button',
          'click the "Apple Juice (1000ml)" product',
          'verify the text "The all-time classic." is shown',
        ],
      },
      {
        name: 'SEED: Wrong login shows the error',
        path: '/#/login',
        steps: [
          'navigate to http://site-juice:3000/#/login',
          'click the "Dismiss" button',
          'type "nobody@kaizen.local" in the "Email" field',
          'type "wrongpassword" in the "Password" field',
          'click the "Log in" button',
          'verify the text "Invalid email or password." is shown',
        ],
      },
      {
        name: 'PROBE-MUSTFAIL: asserts a product that does not exist',
        path: '/#/',
        steps: [
          'navigate to http://site-juice:3000/#/',
          'verify the text "Kaizen Impossible Nectar 3000ml" is shown',
        ],
      },
    ],
  },
  {
    id: 'wp-front',
    kind: 'real',
    url: 'http://site-wp',
    brief: 'briefs/brief.wp-front.txt',
    analyze: { maxPages: 4, maxScenarios: 6 },
    seedCases: [
      {
        name: 'SEED: Home shows the site title',
        path: '/',
        steps: [
          'navigate to http://site-wp/',
          'verify the text "Kaizen Bench WP" is shown',
        ],
      },
      {
        name: 'SEED: Open the Hello world post and see the comment form',
        path: '/',
        steps: [
          'navigate to http://site-wp/',
          'click the "Hello world!" link',
          'verify the text "Leave a Reply" is shown',
        ],
      },
      {
        name: 'SEED: Sample page is reachable from navigation',
        path: '/',
        steps: [
          'navigate to http://site-wp/',
          'click the "Sample Page" link',
          'verify the text "This is an example page" is shown',
        ],
      },
      {
        name: 'PROBE-MUSTFAIL: asserts a post that was never written',
        path: '/',
        steps: [
          'navigate to http://site-wp/',
          'verify the text "Kaizen ghost post 77f2 does not exist" is shown',
        ],
      },
    ],
  },
];

// ── wp-admin: the behindAuth isolation testbed (§5) ──────────────────────────
// Credentials come from the TEMP file the WP install wrote; the loader throws
// loudly if it is missing rather than minting a case with empty creds.
import { readFileSync } from 'node:fs';
import { join as pjoin } from 'node:path';

function wpAdminLoginSeed(): SeedCase {
  const file = pjoin(process.env.TEMP ?? process.env.TMPDIR ?? '/tmp', 'kaizen-bench-wp-creds.txt');
  const raw = readFileSync(file, 'utf8');
  const user = /admin_user=(.+)/.exec(raw)?.[1]?.trim();
  const pass = /admin_pass=(.+)/.exec(raw)?.[1]?.trim();
  if (!user || !pass) throw new Error(`wp admin creds unreadable in ${file}`);
  return {
    name: 'SEED-LOGIN: WordPress admin signs in',
    path: '/wp-login.php',
    steps: [
      'navigate to http://site-wp/wp-login.php',
      `type "${user}" in the "Username or Email Address" field`,
      `type "${pass}" in the "Password" field`,
      'click the "Log In" button',
      'verify the text "Dashboard" is shown',
    ],
  };
}

PORTFOLIO.push({
  id: 'wp-admin',
  kind: 'real',
  url: 'http://site-wp',
  brief: 'briefs/brief.wp-admin.txt',
  analyze: { maxPages: 4, maxScenarios: 6 },
  preflightNote: 'behindAuth leg — learning must stay tenant-scoped; the isolation checker audits shared rows for admin-surface selectors after this leg',
  auth: { loginSeed: wpAdminLoginSeed },
  // Lazy: each seed runs in a FRESH context, so every one must sign in itself
  // (round-1 lesson: bare /wp-admin/ navigations hit the login wall and the
  // seeds failed in all phases for a reason that had nothing to do with the
  // engine). The login prefix reuses the same TEMP-held credentials.
  seedCases: () => {
    const login = wpAdminLoginSeed().steps; // navigate + user + pass + Log In + Dashboard assert
    return [
      {
        name: 'SEED: Admin dashboard shows At a Glance',
        path: '/wp-login.php',
        steps: [...login, 'verify the text "At a Glance" is shown'],
      },
      {
        name: 'SEED: Posts list shows Hello world',
        path: '/wp-login.php',
        steps: [...login, 'navigate to http://site-wp/wp-admin/edit.php', 'verify the text "Hello world!" is shown'],
      },
      {
        name: 'PROBE-MUSTFAIL: asserts an admin page that does not exist',
        path: '/wp-login.php',
        steps: [...login, 'verify the text "Kaizen phantom settings panel 5a1b" is shown'],
      },
    ];
  },
});

export const portfolioSiteById = (id: string): PortfolioSite => {
  const s = PORTFOLIO.find((x) => x.id === id);
  if (!s) throw new Error(`unknown portfolio site '${id}' (have: ${PORTFOLIO.map((x) => x.id).join(', ')})`);
  return s;
};
