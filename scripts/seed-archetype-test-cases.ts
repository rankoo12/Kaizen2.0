/**
 * Smart Brain L0 — Archetype Verification Test Cases
 * Spec ref: spec-smart-brain-layer0.md
 *
 * Seeds two test suites into Kaizen for a given user email:
 *
 *   Suite 1 — Original verification (github, slack, wikipedia baseline)
 *   Suite 2 — Extended coverage (wildcard patterns, auto-learning, multi-site)
 *
 * What to look for after running each case:
 *   - step_results.resolution_source = 'archetype'  ← resolved by L0, zero tokens
 *   - step_results.tokens_used       = 0
 *   - step_results.resolution_source = 'llm'        ← fell through to LLM, tokens > 0
 *
 * AUTO-LEARN CASES: some cases are intentionally marked [LLM→ARCHETYPE].
 * Run them once (LLM resolves, tokens > 0, pattern is auto-learned).
 * Run them a second time (archetype resolves, tokens = 0).
 * This validates the automatic archetype learning pipeline end-to-end.
 *
 * Usage:
 *   npm run seed:archetype-tests -- --email raneck7@gmail.com
 *   npm run seed:archetype-tests -- --email raneck7@gmail.com --dry-run
 */

import dotenv from 'dotenv';
dotenv.config();

import { createHash } from 'crypto';
import pino from 'pino';
import { getPool, closePool } from '../src/db/pool';

const logger = pino({ level: 'info', transport: { target: 'pino-pretty' } });

function contentHash(rawText: string): string {
  return createHash('sha256').update(rawText.toLowerCase().trim()).digest('hex');
}

// ─── Test Suite Definition ────────────────────────────────────────────────────
//
// Each case targets a public URL where the named element archetype exists.
// The step text is written so that word-overlap picks the right DOM candidate,
// and that candidate's accessible name matches an archetype name_pattern exactly.
//
// Archetype → site → accessible name:
//   login_button   → github.com/login     → "Sign in"      (matches 'sign in')
//   password_input → github.com/login     → "Password"     (matches 'password')
//   email_input    → slack.com/signin     → "Email Address"(matches 'email address')
//   submit_button  → slack.com/signin     → "Continue"     (matches 'continue')
//   search_input   → en.wikipedia.org     → "Search"       (matches 'search')
//   signup_button  → github.com           → "Sign up for GitHub" (no match — LLM fallback expected)

type TestCase = {
  name: string;
  baseUrl: string;
  steps: { text: string; expectedArchetype: string | null }[];
};

// ─── Suite 1 — Original baseline cases ───────────────────────────────────────

const SUITE_V1 = {
  name: 'Smart Brain L0 — Archetype Verification',
  description:
    'Verifies that the Layer 0 archetype resolver resolves common UI elements ' +
    'with zero LLM calls and zero tokens. After running each case, check ' +
    'step_results: resolution_source should be "archetype" and tokens_used = 0 ' +
    'for the steps marked [ARCHETYPE].',
  tags: ['archetype', 'l0', 'brain', 'verification'],
};

const CASES: TestCase[] = [
  // ── Case 1: Single archetype — login button ────────────────────────────────
  {
    name: 'L0 — Login Button (github.com/login)',
    baseUrl: 'https://github.com/login',
    steps: [
      {
        text: 'click the sign in button',
        // GitHub renders: role=button, name="Sign in"
        // normalise("Sign in") = "sign in" → matches login_button.name_patterns ✓
        expectedArchetype: 'login_button',
      },
    ],
  },

  // ── Case 2: Single archetype — password input ──────────────────────────────
  {
    name: 'L0 — Password Input (github.com/login)',
    baseUrl: 'https://github.com/login',
    steps: [
      {
        text: "type 'TestPassword123' in the password field",
        // GitHub renders: role=textbox, name="Password"
        // normalise("Password") = "password" → matches password_input.name_patterns ✓
        expectedArchetype: 'password_input',
      },
    ],
  },

  // ── Case 3: Two archetypes in one flow — email + continue ─────────────────
  {
    name: 'L0 — Email Input + Continue Button (slack.com)',
    baseUrl: 'https://slack.com/signin#/signin',
    steps: [
      {
        text: "type 'raneck7@gmail.com' in the email address field",
        // Slack renders: role=textbox, name="Email Address"
        // normalise("Email Address") = "email address" → matches email_input.name_patterns ✓
        expectedArchetype: 'email_input',
      },
      {
        text: 'click the continue button',
        // Slack renders: role=button, name="Continue"
        // normalise("Continue") = "continue" → matches submit_button.name_patterns ✓
        expectedArchetype: 'submit_button',
      },
    ],
  },

  // ── Case 4: Search input archetype ────────────────────────────────────────
  {
    name: 'L0 — Search Input (wikipedia.org)',
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    steps: [
      {
        text: "type 'archetype resolver' in the search field",
        // Wikipedia renders: role=searchbox OR role=textbox, name="Search"
        // normalise("Search") = "search" → matches search_input.name_patterns ✓
        expectedArchetype: 'search_input',
      },
    ],
  },

  // ── Case 5: Mixed — some archetype, some LLM ──────────────────────────────
  // This case intentionally mixes archetype-resolvable steps with a step that
  // falls through to LLM, so you can compare resolution_source across steps.
  {
    name: 'L0 — Mixed Resolution: Archetype + LLM (github.com/login)',
    baseUrl: 'https://github.com/login',
    steps: [
      {
        text: "type 'raneck7@gmail.com' in the username or email address field",
        // GitHub renders: role=textbox, name="Username or email address"
        // normalise = "username or email address" — NOT in email_input.name_patterns
        // → falls through to LLM. Expected: resolution_source = 'llm' or cache layer.
        expectedArchetype: null,
      },
      {
        text: "type 'TestPassword123' in the password field",
        // role=textbox, name="Password" → matches password_input ✓
        expectedArchetype: 'password_input',
      },
      {
        text: 'click the sign in button',
        // role=button, name="Sign in" → matches login_button ✓
        expectedArchetype: 'login_button',
      },
    ],
  },
];

// ─── Suite 2 — Extended coverage (new fixes + auto-learning) ─────────────────

const SUITE_V2 = {
  name: 'Smart Brain L0 — Extended Coverage',
  description:
    'Tests the fixes shipped after the initial L0 implementation: ' +
    'Slack "Enter your email address" and "Sign In With Email" patterns, ' +
    'Wikipedia search via search* wildcard, Google search, and the ' +
    'auto-learn pipeline (run each [LLM→ARCHETYPE] case twice — first run ' +
    'uses the LLM and teaches the pattern; second run resolves via archetype ' +
    'with tokens_used = 0).',
  tags: ['archetype', 'l0', 'brain', 'extended', 'auto-learn'],
};

const CASES_V2: TestCase[] = [
  // ── Case 1: Slack email input (fixed in migration 016) ─────────────────────
  {
    name: 'L0 — Slack Email Input (enter your email address)',
    baseUrl: 'https://slack.com/signin#/signin',
    steps: [
      {
        text: "type 'raneck7@gmail.com' in the email address field",
        // Slack renders: role=textbox, name="Enter your email address"
        // normalise = "enter your email address" → added in migration 016 ✓
        expectedArchetype: 'email_input',
      },
    ],
  },

  // ── Case 2: Slack sign-in button (fixed in migration 016) ──────────────────
  {
    name: 'L0 — Slack Sign In With Email Button',
    baseUrl: 'https://slack.com/signin#/signin',
    steps: [
      {
        text: "type 'raneck7@gmail.com' in the email address field",
        expectedArchetype: 'email_input',
      },
      {
        text: 'click the sign in with email button',
        // Slack renders: role=button, name="Sign In With Email"
        // normalise = "sign in with email" → added to login_button in migration 016 ✓
        expectedArchetype: 'login_button',
      },
    ],
  },

  // ── Case 3: Wikipedia search via wildcard (fixed in migration 017) ─────────
  {
    name: 'L0 — Wikipedia Search (search* wildcard + searchbox role fix)',
    baseUrl: 'https://en.wikipedia.org/wiki/Main_Page',
    steps: [
      {
        text: "type 'self-healing tests' in the search box",
        // Wikipedia renders: input[type="search"] → role=searchbox (dom-pruner fix),
        // name="Search Wikipedia"
        // normalise = "search wikipedia" → matches 'search*' wildcard ✓
        expectedArchetype: 'search_input',
      },
    ],
  },

  // ── Case 4: Google search (combobox role) ─────────────────────────────────
  {
    name: 'L0 — Google Search Input',
    baseUrl: 'https://www.google.com',
    steps: [
      {
        text: "type 'playwright automation' in the search field",
        // Google renders: <textarea role="combobox" aria-label="Search">
        // normalise = "search" → matches search_input_combobox exactly ✓
        // (migration 018 adds this archetype)
        expectedArchetype: 'search_input_combobox',
      },
    ],
  },

  // ── Case 5: Auto-learn — GitHub "Username or email address" ────────────────
  // [LLM→ARCHETYPE] Run this case TWICE.
  //   Run 1: "username or email address" is NOT in email_input patterns.
  //          LLM resolves the field. Auto-learn fires → adds the pattern to the DB.
  //          Expect: resolution_source='llm', tokens_used > 0.
  //   Run 2: Pattern is now in the DB. Archetype resolves the field.
  //          Expect: resolution_source='archetype', tokens_used = 0.
  {
    name: 'L0 — Auto-Learn: GitHub Username Field [RUN TWICE]',
    baseUrl: 'https://github.com/login',
    steps: [
      {
        text: "type 'raneck7@gmail.com' in the username or email address field",
        // GitHub renders: role=textbox, name="Username or email address"
        // First run: NOT in patterns → LLM → auto-learns → null
        // Second run: pattern learned → archetype → 'email_input'
        expectedArchetype: null,
      },
      {
        text: "type 'TestPassword123' in the password field",
        // Should always resolve via archetype on every run.
        expectedArchetype: 'password_input',
      },
      {
        text: 'click the sign in button',
        expectedArchetype: 'login_button',
      },
    ],
  },

  // ── Case 6: Stack Overflow login button ────────────────────────────────────
  {
    name: 'L0 — Stack Overflow Login Button',
    baseUrl: 'https://stackoverflow.com/users/login',
    steps: [
      {
        text: 'click the log in button',
        // Stack Overflow renders: role=button, name="Log in"
        // normalise = "log in" → matches login_button.name_patterns ✓
        expectedArchetype: 'login_button',
      },
    ],
  },

  // ── Case 7: Stack Overflow search ──────────────────────────────────────────
  {
    name: 'L0 — Stack Overflow Search Input',
    baseUrl: 'https://stackoverflow.com',
    steps: [
      {
        text: "type 'playwright automation' in the search field",
        // Stack Overflow renders: input with placeholder/aria-label "Search..."
        // normalise = "search..." → matches search_input_textbox exactly ✓
        expectedArchetype: 'search_input_textbox',
      },
    ],
  },
];

// ─── Suite 3 — Multi-site expansion ──────────────────────────────────────────

const SUITE_V3 = {
  name: 'Smart Brain L0 — Multi-Site Expansion',
  description:
    'Extends L0 coverage to five additional public websites. ' +
    'Validates the combobox search archetype (YouTube), wildcard matching ' +
    'on different domains (DuckDuckGo, MDN, Tailwind), and auth flows on ' +
    'GitLab. All steps should resolve via archetype with tokens_used = 0.',
  tags: ['archetype', 'l0', 'brain', 'multi-site'],
};

const CASES_V3: TestCase[] = [
  // ── Case 1: YouTube search — validates search_input_combobox ───────────────
  {
    name: 'L0 — YouTube Search Input (combobox)',
    baseUrl: 'https://www.youtube.com',
    steps: [
      {
        text: "type 'playwright testing tutorial' in the search field",
        // YouTube renders: <input role="combobox" aria-label="Search">
        // normalise("Search") = "search" → matches search_input_combobox exactly ✓
        // (same combobox archetype added for Google — migration 018)
        expectedArchetype: 'search_input_combobox',
      },
    ],
  },

  // ── Case 2: DuckDuckGo search — wildcard "search the web" ──────────────────
  {
    name: 'L0 — DuckDuckGo Search Input (wildcard)',
    baseUrl: 'https://duckduckgo.com',
    steps: [
      {
        text: "type 'selenium vs playwright' in the search field",
        // DuckDuckGo renders: <input name="q" aria-label="Search the web">
        // normalise("Search the web") = "search the web"
        // "search the web".startsWith("search") → matches 'search*' in search_input_textbox ✓
        expectedArchetype: 'search_input_textbox',
      },
    ],
  },

  // ── Case 3: GitLab login flow ───────────────────────────────────────────────
  {
    name: 'L0 — GitLab Login Flow',
    baseUrl: 'https://gitlab.com/users/sign_in',
    steps: [
      {
        text: "type 'TestPassword123' in the password field",
        // GitLab renders: role=textbox, name="Password"
        // normalise("Password") = "password" → matches password_input ✓
        expectedArchetype: 'password_input',
      },
      {
        text: 'click the sign in button',
        // GitLab renders: role=button, name="Sign in"
        // normalise("Sign in") = "sign in" → matches login_button ✓
        expectedArchetype: 'login_button',
      },
    ],
  },

  // ── Case 4: PyPI search — wildcard "search pypi" ──────────────────────────
  // PyPI has a directly accessible <input aria-label="Search PyPI"> in the page header.
  // No modal, no button-click required.
  {
    name: 'L0 — PyPI Package Search (wildcard)',
    baseUrl: 'https://pypi.org',
    steps: [
      {
        text: "type 'playwright' in the search field",
        // PyPI renders: <input id="search" name="q" aria-label="Search PyPI">
        // role=textbox (input[type="text"]), name="Search PyPI"
        // normalise("Search PyPI") = "search pypi"
        // "search pypi".startsWith("search") → matches 'search*' in search_input_textbox ✓
        expectedArchetype: 'search_input_textbox',
      },
    ],
  },

  // ── Case 5: npm search — wildcard ─────────────────────────────────────────
  // npm homepage has a directly accessible search input in the header.
  {
    name: 'L0 — npm Package Search (wildcard)',
    baseUrl: 'https://www.npmjs.com',
    steps: [
      {
        text: "type 'playwright' in the search field",
        // npm renders: <input type="search" ...> with aria-label or placeholder "Search packages"
        // role=searchbox (input[type="search"]), name starts with "search"
        // matches 'search*' in search_input ✓
        expectedArchetype: 'search_input',
      },
    ],
  },
];

// ─── Shared seeding logic ─────────────────────────────────────────────────────

type SuiteDef = { name: string; description: string; tags: string[] };

async function seedSuite(suite: SuiteDef, cases: TestCase[], tenantId: string): Promise<void> {
  const { rows: suiteRows } = await getPool().query<{ id: string }>(
    `INSERT INTO test_suites (tenant_id, name, description, tags)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [tenantId, suite.name, suite.description, suite.tags],
  );
  const suiteId = suiteRows[0].id;
  logger.info({ event: 'suite_created', suiteId, name: suite.name });

  for (const tc of cases) {
    const { rows: caseRows } = await getPool().query<{ id: string }>(
      `INSERT INTO test_cases (tenant_id, suite_id, name, base_url)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [tenantId, suiteId, tc.name, tc.baseUrl],
    );
    const caseId = caseRows[0].id;

    for (let pos = 0; pos < tc.steps.length; pos++) {
      const rawText = tc.steps[pos].text;
      const hash    = contentHash(rawText);

      const { rows: stepRows } = await getPool().query<{ id: string }>(
        `INSERT INTO test_steps (tenant_id, case_id, position, raw_text, content_hash)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id`,
        [tenantId, caseId, pos, rawText, hash],
      );
      const stepId = stepRows[0].id;

      await getPool().query(
        `INSERT INTO test_case_steps (tenant_id, case_id, step_id, position, is_active)
         VALUES ($1, $2, $3, $4, true)`,
        [tenantId, caseId, stepId, pos],
      );
    }

    logger.info({
      event: 'case_created',
      caseId,
      name: tc.name,
      url: tc.baseUrl,
      steps: tc.steps.map((s) => ({
        text: s.text,
        expectedArchetype: s.expectedArchetype ?? 'LLM fallback',
      })),
    });
  }

  logger.info({
    event: 'suite_seeded',
    suite: suite.name,
    cases: cases.length,
    totalSteps: cases.reduce((n, c) => n + c.steps.length, 0),
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args   = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  const emailArg = args.find((a) => a.startsWith('--email=')) ?? args[args.indexOf('--email') + 1];
  const email    = emailArg?.replace('--email=', '').trim();

  if (!email) {
    logger.error({ event: 'missing_arg' }, 'Usage: npm run seed:archetype-tests -- --email <email>');
    process.exit(1);
  }

  if (dryRun) logger.info({ event: 'dry_run' }, 'DRY RUN — no DB writes');

  // ── Resolve user → tenant ──────────────────────────────────────────────────
  const { rows: userRows } = await getPool().query<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM users WHERE email = $1 AND deleted_at IS NULL LIMIT 1`,
    [email],
  );

  if (userRows.length === 0) {
    logger.error({ event: 'user_not_found', email }, 'No active user found with that email');
    process.exit(1);
  }
  const user = userRows[0];

  const { rows: memberRows } = await getPool().query<{ tenant_id: string; tenant_name: string }>(
    `SELECT m.tenant_id, t.name AS tenant_name
     FROM memberships m
     JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = $1
       AND m.role = 'owner'
       AND m.deleted_at IS NULL
       AND t.deleted_at IS NULL
     LIMIT 1`,
    [user.id],
  );

  if (memberRows.length === 0) {
    logger.error({ event: 'tenant_not_found', email }, 'No owner-level tenant found for this user');
    process.exit(1);
  }
  const { tenant_id: tenantId, tenant_name: tenantName } = memberRows[0];

  logger.info({ event: 'user_resolved', email, userId: user.id, tenantId, tenantName });

  const allSuites = [
    { suite: SUITE_V1, cases: CASES },
    { suite: SUITE_V2, cases: CASES_V2 },
    { suite: SUITE_V3, cases: CASES_V3 },
  ];

  if (dryRun) {
    for (const { suite, cases } of allSuites) {
      logger.info({ event: 'dry_run_plan', suite: suite.name, caseCount: cases.length });
      for (const c of cases) {
        logger.info({ event: 'case_plan', name: c.name, steps: c.steps.length, url: c.baseUrl });
      }
    }
    await closePool();
    return;
  }

  for (const { suite, cases } of allSuites) {
    await seedSuite(suite, cases, tenantId);
  }

  const allCases = [...CASES, ...CASES_V2, ...CASES_V3];
  const totalCases = allCases.length;
  const totalSteps = allCases.reduce((n, c) => n + c.steps.length, 0);
  logger.info({ event: 'seed_complete', suites: 3, cases: totalCases, totalSteps, tenantId, tenantName });

  await closePool();
}

main().catch((e) => {
  logger.error({ event: 'seed_failed', error: e.message });
  process.exit(1);
});
