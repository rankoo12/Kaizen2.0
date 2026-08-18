/**
 * Test Writer domain types — COMPREHEND / PLAN / WRITE / VALIDATE.
 *
 * Spec refs:
 *   docs/specs/test-writer/spec-comprehension-knowledge-model.md §2, §3
 *   docs/specs/test-writer/spec-generation-pipeline.md §2, §3
 *
 * These are the contracts the LLM gateway returns and the pipeline consumes.
 * Kept in src/types (global shared interfaces) so the gateway never has to
 * import from a feature module.
 */

// ─── COMPREHEND ──────────────────────────────────────────────────────────────

/** Coarse page purpose enum — mirrors site_pages.purpose_tag (migration 029). */
export type PagePurposeTag =
  | 'landing' | 'auth' | 'listing' | 'detail' | 'form' | 'checkout'
  | 'dashboard' | 'settings' | 'search' | 'content' | 'error' | 'other';

export type PageClassifyInput = {
  urlNormalized: string;
  title: string;
  headings: string[];
  /** "login form: email, password, [Sign in]" */
  formSummaries: string[];
  /** Top surveyed elements as `role: "name"` lines. */
  elementDigest: string[];
  /** States discovered by safe-reveal probing. */
  revealedDigest: string[];
};

export type PageClassification = {
  purpose: string;              // "login page", "product listing", "checkout step 2"
  purposeTag: PagePurposeTag;
  capabilities: string[];       // "user can search products"
  entities: string[];           // "product", "cart", "order"
};

/** A user journey as an ordered path of pages — verified against page_links. */
export type Journey = {
  name: string;
  description: string;
  pagePath: string[];           // urlNormalized values, consecutive pairs must have edges
  requiresAuth: boolean;
  priority: 'critical' | 'high' | 'normal';
};

export type AppBrief = {
  appType: string;              // "e-commerce storefront", "SaaS project tracker"
  summary: string;
  coreEntities: string[];
  journeys: Journey[];
};

export type AppBriefInput = {
  pages: Array<{
    urlNormalized: string;
    title: string;
    purpose: string;
    purposeTag: PagePurposeTag;
    capabilities: string[];
    requiresAuth: boolean;
  }>;
  /** Adjacency list: urlNormalized → urlNormalized[] */
  links: Record<string, string[]>;
  tenantBrief: TenantBrief | null;
};

/**
 * The distilled Init Brief — what the tenant told us about their app.
 * Tenant-scoped proprietary data (service spec §12/§13): never shared, never
 * cross-tenant, secret-scrubbed on intake.
 */
export type TenantBrief = {
  purpose: string;
  roles: string[];
  criticalFlows: string[];
  businessRules: string[];
  priorities: string[];
  cautions: string[];           // "never touch the billing page", etc.
  /**
   * URL paths the team said to skip or leave alone ("/billing", "/basic_auth").
   * Extracted as its own field because a summary of the caution loses the verb:
   * "/download involves files; skip it" was distilled to "/download involves
   * files, which Kaizen cannot open" — true, and no longer an instruction.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.4
   */
  excludedPaths?: string[];
};

// ─── PLAN ────────────────────────────────────────────────────────────────────

export type ScenarioSource =
  | { kind: 'catalog'; archetypeKey: string }
  | { kind: 'llm' }
  /** Fired by element shape alone, no model call. Spec: spec-planner-per-page.md §1.3 */
  | { kind: 'repertoire'; ruleKey: string };

export type PlannedScenario = {
  name: string;
  journey: string | null;
  kind: 'happy' | 'negative' | 'edge';
  priority: 'critical' | 'high' | 'normal';
  /** WHY a QA engineer would write this. */
  rationale: string;
  /**
   * The observable change the test must see: "a Delete button appears that
   * was not there before", "the flash reads 'Your username is invalid!'". The
   * missing half of a plan — without it PLAN says "verify the content is
   * dynamic", WRITE invents "verify the ever-evolving nature of content is
   * visible", and no stage can tell that is meaningless. WRITE renders it as
   * the oracle instruction; the judge asks whether the steps prove it; the
   * delta oracle scores its pick against it.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.2
   */
  expectedOutcome?: string;
  /**
   * WHAT it will do — one sentence of approach, so a reviewer can approve
   * knowingly before any steps exist. Catalog scenarios render their archetype
   * skeleton instead; this carries the gap-fill ones (spec §2.2).
   */
  outline: string;
  targetPages: string[];        // urlNormalized values
  source: ScenarioSource;
  /**
   * 1 for the approved plan; 2 or 3 for scenarios a fill round added to reach
   * the requested count. Shown so a reviewer knows which they did not approve.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.5
   */
  round?: number;
  /** Set when the scenario needs synthetic-data consent to be validated. */
  requiresSyntheticData?: boolean;
  /**
   * When the first target page is a screen reached by clicking rather than by
   * URL: the clicks that get there, prepended to the test after the navigate.
   * Spec: docs/specs/test-writer/spec-screen-discovery.md §1.5
   */
  reachedBy?: Array<{ role: string; name: string }>;
};

/**
 * Everything the planner needs to know about ONE page to plan tests for it —
 * the page as an engineer would read it, not a one-line summary of it.
 * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.1
 */
export type PageDossier = {
  /** The URL a test navigates to (observed form, trailing slash kept). */
  url: string;
  /** Identity — what site_pages / page_elements are keyed by. */
  urlNormalized: string;
  title: string;
  headings: string[];
  /** Opening stretch of visible text, scrubbed. */
  pageText: string;
  purpose: string;
  capabilities: string[];
  /** Page-specific interactive elements: nav/footer chrome excluded. `revealedBy`
   *  names the control that has to be clicked first for this one to exist. */
  elements: Array<{ role: string; name: string; kind: string; opensNewTab?: boolean; revealedBy?: string }>;
  /** "login form: username, password, [Login]" */
  forms: string[];
  requiresAuth: boolean;
  /** Set when a brief caution names this page — never planned. */
  excludedBy?: string;
  /** A page that is only links to other pages: navigation, not a subject. */
  isIndex?: boolean;
  /** A screen: the clicks that reach it from `url`. Spec: spec-screen-discovery.md §1.3 */
  reachedBy?: Array<{ role: string; name: string }>;
};

export type PlanBatchInput = {
  pages: PageDossier[];
  tenantBrief: TenantBrief | null;
  appSummary: string;
  /** Scenarios the deterministic repertoire already produced for these pages. */
  repertoire: Array<{ page: string; name: string; outline: string }>;
  /** Fill round: what has already been delivered / rejected per page. */
  ledger?: Array<{ page: string; delivered: string[]; rejected: Array<{ name: string; reason: string }> }>;
  perPage: number;
  scope: 'public' | 'authenticated';
  syntheticDataConsent: boolean;
  existingCaseNames: string[];
};

export type PlanInput = {
  appBrief: AppBrief;
  tenantBrief: TenantBrief | null;
  capabilitiesByPage: Record<string, string[]>;
  existingCaseNames: string[];
  scope: 'public' | 'authenticated';
  syntheticDataConsent: boolean;
  maxScenarios: number;
  /**
   * Scoped Suggest: the ONE page the plan is about. The rest of the site model
   * stays in the prompt as context — a scenario about the cart still needs to
   * know the catalogue exists — but every scenario must target this page.
   * Absent on a whole-app analyze.
   * Spec: docs/specs/test-writer/spec-scoped-suggest.md §4
   */
  focusUrl?: string;
  /**
   * Rendered archetype catalog (catalog-v1.md §3) — the static prompt prefix.
   * Supplied by the caller so the gateway never imports a feature module.
   */
  catalogBlock: string;
};

// ─── WRITE (structured intents) ──────────────────────────────────────────────

/**
 * A step's target. `element` MUST reference a page_elements.id observed by the
 * crawler — that is what makes hallucinated elements a schema error rather than
 * a runtime surprise. `description` is the narrow exemption (generation spec
 * §3): only for click_random group semantics and discover oracles (post-submit
 * states the crawler can never observe, because recon never submits forms).
 */
export type StepIntentTarget =
  | { kind: 'element'; elementId: string }
  | { kind: 'description'; description: string };

export type StepIntent =
  // ── Page-level navigation ──
  | { action: 'navigate'; url: string }
  | { action: 'go_back' | 'go_forward' | 'reload' | 'close_tab' }
  | { action: 'switch_tab'; value: string }
  // ── Pointer / form interactions (element-targeted) ──
  | { action: 'click' | 'double_click' | 'right_click' | 'hover' | 'check' | 'uncheck' | 'clear';
      target: StepIntentTarget }
  | { action: 'type' | 'select'; target: StepIntentTarget; value: string }
  | { action: 'drag_and_drop'; target: StepIntentTarget; destination: StepIntentTarget }
  // ── Group semantics: pick one of many, capture what was picked ──
  | { action: 'click_random'; description: string; captureAs: string }
  // ── Assertions ──
  | { action: 'assert_visible' | 'assert_not_visible' | 'assert_enabled' | 'assert_disabled'
      | 'assert_checked' | 'assert_not_checked';
      target: StepIntentTarget }
  | { action: 'assert_text' | 'assert_not_text'; value: string; target?: StepIntentTarget }
  | { action: 'assert_url' | 'assert_title'; value: string }
  | { action: 'assert_attribute'; target: StepIntentTarget; attribute: string; expected: string }
  // ── Timing / keyboard / scroll ──
  | { action: 'press_key'; value: string }
  | { action: 'wait'; value: string }
  | { action: 'scroll'; target?: StepIntentTarget };

export type ScenarioExpectation =
  | { outcome: 'pass' }
  | { outcome: 'fail'; failStepIndex: number; reason: string };

export type GeneratedScenario = {
  planRef: string;              // PlannedScenario.name
  name: string;
  kind: 'positive' | 'negative';
  steps: StepIntent[];
  expectation: ScenarioExpectation;
  rationale: string;
};

/** One element the writer is allowed to reference, as shown in the prompt. */
export type GroundingElement = {
  id: string;                   // page_elements.id — what the intent must cite
  pageUrl: string;
  role: string;
  name: string;
  kind: string;
  /** Non-null when the element only appears after a safe-reveal probe. */
  revealedBy: string | null;
  /**
   * The selector recon observed. NEVER sent to the model — the prompt builder
   * emits id/role/name/kind/page only, because a test must bind to meaning, not
   * to a selector. Carried here solely to pre-seed the tenant's selector cache
   * (spec-generation-pipeline.md §5.2). Null for probe-revealed elements.
   */
  selector: string | null;
  /**
   * `target="_blank"` was observed on this link: clicking it opens a NEW TAB,
   * and any assertion about the destination must switch to it first. Three
   * saucedemo social-link tests asserted the old tab's title and failed.
   */
  opensNewTab?: boolean;
  /**
   * This element appears on most pages of the site — a nav bar, a footer link.
   * It is CONTEXT, not the subject of any one page's tests. A scenario planned
   * for /inputs that ends up clicking the footer's "Elemental Selenium" link has
   * drifted, however green it runs.
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
   */
  chrome?: boolean;
};

export type WriteInput = {
  plan: PlannedScenario;
  /** Elements from the plan's target pages — the ONLY citable elements. */
  grounding: GroundingElement[];
  /** "signup form: email, password, [Create account]" per target page. */
  formSummaries: string[];
  /**
   * What a visitor reads on the target pages. The only material a page with no
   * controls offers — and the difference between "unwritable" and "navigate
   * there and verify the text is shown".
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
   */
  pageText?: string[];
  /** Ordered page path from page_links, when the plan spans pages. */
  pagePath: string[];
  /** Seed tokens available for typed values ({{email}}, {{password}}, …). */
  seedTokens: string[];
  /** Catalog entry text for catalog-sourced scenarios (skeleton + oracle ladder). */
  archetype: string | null;
  /** Human steering notes captured at plan approval — UNTRUSTED text. */
  steeringNotes: string | null;
  /**
   * Accounts the brief names ("username tomsmith, password SuperSecretPassword!").
   * A sign-in test types these; the seed-token rule is for NEW identities.
   * Spec: docs/specs/test-writer/spec-planner-per-page.md §1.7
   */
  knownAccounts?: string[];
  /**
   * The page has no URL of its own: after navigating, these clicks reach it.
   * The writer is told; the pipeline prepends them.
   * Spec: docs/specs/test-writer/spec-screen-discovery.md §1.5
   */
  reachedBy?: Array<{ role: string; name: string }>;
  maxSteps: number;
  /** Compile/lint errors from a previous attempt — set on the single repair round. */
  repairErrors?: string[];
  /**
   * What the target pages do NOT offer ("there is no typeable field here"),
   * derived deterministically from `grounding`. Spec: spec-judge-repair-loop.md §2.4
   */
  groundingNotes?: string[];
  /**
   * Which model answers. First drafts are mini; every repair attempt (schema
   * round 2, judge rewrite) is frontier — the second draft is the last one.
   * Spec: spec-judge-repair-loop.md §2.3
   */
  tier?: 'mini' | 'frontier';
  /**
   * The quality judge's failed dimensions, when this is a REWRITE of a scenario
   * it did not pass. Rendered with `previousSteps` so the model edits the
   * oracle rather than reinventing the scenario. Spec §2.2
   */
  judgeFeedback?: string[];
  previousSteps?: string[];
};

// ─── JUDGE ───────────────────────────────────────────────────────────────────

export type JudgeDimension =
  | 'meaningful_oracle'   // HARD — the pre-state test
  | 'negative_sharpness'  // HARD
  | 'plan_fidelity'       // HARD — does it do what the plan said, on that page?
  | 'realism'             // SOFT
  | 'marginal_value';     // SOFT

export type JudgeVerdict = {
  planRef: string;
  verdict: 'PROPOSE' | 'REVISE' | 'REJECT';
  dimensions: Array<{ dimension: JudgeDimension; pass: boolean; reason: string }>;
};

export type JudgeInput = {
  scenarios: Array<{
    planRef: string;
    name: string;
    kind: 'positive' | 'negative';
    /** Rendered canonical NL — what a human would read. */
    steps: string[];
    rationale: string;
    /**
     * What the plan said this scenario would do, and where. Without it the judge
     * can only ask "is this a good test?" and never "is this the test that was
     * approved?" — which is how a scenario planned for /inputs shipped as a
     * click on the site-wide footer link.
     * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
     */
    outline?: string;
    expectedOutcome?: string;
    targetPages?: string[];
  }>;
  /** Advisory lint findings, per scenario planRef — the judge weighs them. */
  lintFindings: Record<string, string[]>;
};

// ─── Reporting ───────────────────────────────────────────────────────────────

/** Post-action state observed during a validation run — hardens discover oracles. */
export type OracleHarvest = {
  finalUrl: string;
  heading: string | null;
  alertText: string | null;
  /**
   * What the page was complaining about underneath a green run. A test can pass
   * every step while the console throws and requests 500 — evidence a QA
   * engineer would report and the pipeline used to discard.
   * Spec: docs/specs/test-writer/spec-validation-trust.md §8
   */
  consoleErrorCount?: number;
  httpErrorCount?: number;
};

/**
 * Something worth telling the customer that is NOT a test.
 * Spec: docs/specs/test-writer/spec-findings-and-coverage.md §1
 *
 * A QA engineer who spends a day on your app and writes no tests has still had a
 * useful day — they hand you what they found. The pipeline already observes all
 * of this (broken pages, unlabelled controls, an unverified auth boundary) and
 * has been discarding it, so a job that proposed nothing returned nothing.
 */
export type FindingKind =
  | 'crawl_error_page'
  | 'empty_accessible_name'
  | 'possible_app_defect'
  | 'unverified_auth_partition'
  | 'console_or_network_errors'
  | 'broken_link'
  | 'requires_http_auth';

export type Finding = {
  kind: FindingKind;
  severity: 'info' | 'low' | 'medium' | 'high';
  /** Customer-facing and specific. Names what a person recognises. */
  title: string;
  /** What and where, carrying the technical precision the title leaves out. */
  detail: string;
  /** Enough to reconstruct the observation — never hand-wavy. */
  evidence: {
    url?: string;
    elementRef?: string;
    runId?: string;
    /** Lets the UI open the run under its real name rather than a generic one. */
    caseId?: string;
    repro?: string[];
  };
  source: 'recon' | 'comprehend' | 'validate';
};

export type ScenarioRejection = {
  name: string;
  stage: 'safety' | 'schema' | 'render' | 'compile' | 'dedup' | 'judge' | 'validation' | 'consent';
  reason: string;
  runId?: string;
  /**
   * The rendered steps at the moment of rejection, when there were any. A
   * verdict without the work it judged cannot be checked by anyone — the user
   * reading "Kaizen shows its work", or us calibrating a gate.
   * Spec: spec-judge-repair-loop.md §2.5
   */
  steps?: string[];
};
