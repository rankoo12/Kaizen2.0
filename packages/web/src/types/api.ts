// ─── Shared API response types ────────────────────────────────────────────────
// These mirror the shapes returned by the Kaizen API routes.

export type Suite = {
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  caseCount: number;
  createdAt: string;
  updatedAt: string;
  /** Consent for generated tests that create throwaway records. Default false. */
  allowSyntheticData?: boolean;
};

// ─── Test Writer ("Kaizen as a QA engineer") ─────────────────────────────────
// Spec: docs/specs/tests-ux/spec-testwriter-ux.md

/** Where a generated test came from in its lifecycle. */
export type CaseStatus = 'active' | 'draft' | 'validating' | 'rejected' | 'archived';
export type CaseOrigin = 'user' | 'generated';

export type GenerationJobStatus =
  | 'queued' | 'running' | 'awaiting_plan_approval' | 'completed' | 'failed' | 'blocked';

export type ScenarioSource = { kind: 'catalog'; archetypeKey: string } | { kind: 'llm' };

export type PlannedScenario = {
  name: string;
  journey: string | null;
  kind: 'happy' | 'negative' | 'edge';
  priority: 'critical' | 'high' | 'normal';
  /** WHY a QA engineer would write this. */
  rationale: string;
  /** WHAT it will do — present for AI gap-fill; catalog rows render their skeleton. */
  outline?: string;
  targetPages: string[];
  source: ScenarioSource;
  requiresSyntheticData?: boolean;
};

export type ScenarioRejection = {
  name: string;
  stage: 'safety' | 'schema' | 'render' | 'compile' | 'dedup' | 'judge' | 'validation' | 'consent';
  reason: string;
  runId?: string;
};

/** Live phase counts. Absent until the phase reports — never rendered as a guess. */
export type JobProgress = {
  phase: 'recon' | 'comprehend' | 'plan' | 'write' | 'validate';
  pagesCrawled?: number;
  scenariosWritten?: number;
  scenariosTotal?: number;
  validationRunsDone?: number;
  validationRunsTotal?: number;
};

export type GenerationReport = {
  progress?: JobProgress;
  recon?: {
    pagesCrawled: number; pagesBlocked: number; probesPerformed: number;
    linksInserted?: number; urlsSkippedByBudget?: number;
  };
  comprehend?: {
    pagesClassified: number; pagesReusedFromCache: number; journeys: number;
    coverageGaps?: string[];
    journeysDropped?: Array<{ name: string; reason: string }>;
  };
  plan?: { scenariosPlanned: number; fromCatalog: number; fromLlm: number };
  write?: { attempted: number; written: number; deduped: number; survivedJudge: number };
  validate?: { proposed: number; validated: number; unvalidated: number };
  /**
   * Signed-in exploration outcome. Present only on `scope: 'authenticated'` jobs.
   * Spec: docs/specs/test-writer/spec-authenticated-scope.md §10.3
   */
  auth?: {
    /** How the session was proven. Null when the job never got that far. */
    sessionVerification: 'assertion+heuristic' | 'heuristic' | null;
    loginSteps: { total: number; passed: number };
    /** Times the session dropped mid-crawl and was restored (max 1). */
    reloginCount: number;
    /** Total sign-ins performed, capped so a flaky app can't be hammered. */
    signInCount: number;
    pagesBehindAuth: number;
    /** Tier B pages captured but never probed. */
    probesSuppressed: number;
    /** Tier A pages recorded as URL + title only — reading them IS the exposure. */
    captureSuppressed: number;
    /** Logout URLs the crawler saw and refused — the audit trail. */
    sessionEndingBlocked: number;
    endedEarly: 'session_lost' | null;
    blockedReason: 'login_failed' | 'login_challenge' | 'login_budget_exhausted' | null;
    blockedDetail: string | null;
    /**
     * True when no public crawl has ever run for this suite, so every
     * requires_auth mark is a conservative default. Render as guidance
     * ("run a public analysis to tell public pages from private ones"),
     * never as a failure.
     */
    publicPartitionUnverified?: boolean;
  };
  /** Per-phase spend, read from billing_events so it agrees with the invoice. */
  tokenUsage?: Record<string, number>;
  rejected?: ScenarioRejection[];
  harvest?: Record<string, { finalUrl: string; heading: string | null; alertText: string | null }>;
};

export type GenerationJob = {
  id: string;
  suiteId: string;
  targetUrl: string;
  scope: 'public' | 'authenticated';
  status: GenerationJobStatus;
  options: Record<string, unknown>;
  testPlan: { scenarios?: PlannedScenario[] } | null;
  report: GenerationReport | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

/** Who wrote a test. Null for cases predating migration 030 and for anything created
 *  through an API key, which has a tenant but no user behind it. Render null as nothing
 *  — an absent author is a fact about the record, not a person we failed to name. */
export type CaseAuthor = {
  id: string;
  displayName: string | null;
  email: string;
};

export type CaseSummary = {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
  createdBy: CaseAuthor | null;
  /** Draft lifecycle + provenance. Older payloads omit these; treat as active/user. */
  status?: CaseStatus;
  origin?: CaseOrigin;
  /** The run that proved a generated draft — its evidence. */
  validationRunId?: string | null;
  generationJobId?: string | null;
  archetypeKey?: string | null;
  /** Aggregates over this case's whole run history. Computed per request rather than
   *  read from a rollup — measured at ~1.1ms for a tenant, and a cached copy would be
   *  one more place for numbers to disagree with their source. */
  stats: {
    runs: number;
    passed: number;
    healed: number;
    failed: number;
    avgDurationMs: number | null;
    /** Null, not 0, when this case has never resolved an element. Zero means every
     *  lookup needed the model, which is the opposite of "nothing measured yet". */
    cacheHitPct: number | null;
    /** What learning cost, beside what it costs now. */
    firstRunTokens: number | null;
    lastRunTokens: number | null;
  };
  lastRun: {
    id: string;
    status: RunStatus;
    completedAt: string | null;
    durationMs: number | null;
    totalTokens: number | null;
  } | null;
};

export type CaseDetail = CaseSummary & {
  suiteId: string;
  steps: CaseStep[];
  recentRuns: RunSummary[];
};

export type CaseStep = {
  id: string;
  position: number;
  rawText: string;
  contentHash: string;
};

export type RunStatus =
  | 'queued'
  | 'running'
  | 'passed'
  | 'failed'
  | 'healed'
  | 'cancelled';

export type RunSummary = {
  id: string;
  caseId: string | null;
  caseName: string | null;
  suiteId: string | null;
  suiteName: string | null;
  status: RunStatus;
  /** 'testwriter' marks a proving run — Kaizen's own evidence for a draft it
   *  wants to propose. Excluded from the runs feed, reachable from the draft. */
  triggeredBy: 'web' | 'api' | 'cli' | 'schedule' | 'testwriter';
  createdAt: string;
  completedAt: string | null;
  durationMs: number | null;
  totalTokens: number | null;
  /** The URL this run executed against (`runs.environment_url`). */
  environmentUrl: string | null;
  /** Steps this run was created to execute, stamped at enqueue. Null for runs that
   *  predate migration 028 and had no step results to backfill from. Not derived from
   *  the case — an edit mid-run would move it. */
  totalSteps: number | null;
  /** Steps that have finished. Pairs with totalSteps for a live progress meter. */
  completedSteps: number;
};

export type DomCandidate = {
  kaizenId: string;
  role: string;
  name: string;
  selector: string;
  parentContext?: string;
};

/** A healing attempt against one step: what broke, what was tried, what it became. */
export type HealingEvent = {
  id: string;
  failureClass: string;
  strategyUsed: string;
  attempts: number;
  succeeded: boolean;
  /** The selector that stopped working. Null when the failure wasn't selector-related. */
  oldSelector: string | null;
  /** The selector that replaced it. Null when healing didn't succeed. */
  newSelector: string | null;
  durationMs: number | null;
};

export type StepResult = {
  id: string;
  stepId: string;
  /** Original natural-language step text. Travels with the step result so
   *  edits / step-versioning can't desync the inspector display. */
  rawText: string | null;
  status: RunStatus;
  screenshotKey: string | null;
  durationMs: number | null;
  tokens: number;
  errorType: string | null;
  failureClass: string | null;
  resolutionSource: string | null;
  selectorUsed: string | null;
  createdAt: string;
  domCandidates: DomCandidate[] | null;
  llmPickedKaizenId: string | null;
  userVerdict: 'passed' | 'failed' | null;
  /** Run-scoped variable captured by this step (null when nothing was captured). */
  capturedName: string | null;
  /** The value captured into capturedName. */
  capturedValue: string | null;
  /** Healing attempts on this step, oldest first. Empty when it never needed healing. */
  healingEvents: HealingEvent[];
  /** Cosine similarity, populated ONLY by the two vector tiers (pgvector_element,
   *  pgvector_step) — 3.4% of steps in practice. Every other tier leaves it null: an
   *  exact Redis hit matched a key, not a neighbourhood, and the model produces no
   *  similarity at all. Never render this as a blanket "confidence" column.
   *  Measured, not assumed — docs/specs/roadmap/spec-phase-0-plumbing.md §5. */
  similarityScore: number | null;
  /** The iframe this step's element was found in (origin + path), or null for the main
   *  document — which is almost every step. Set on cookie-consent banners and other
   *  third-party frames, where "the click happened on the page under test" would be
   *  the wrong story to tell. */
  frameUrl: string | null;
};

export type RunDetail = RunSummary & {
  stepResults: StepResult[];
};

export const TERMINAL_RUN_STATUSES: RunStatus[] = [
  'passed',
  'failed',
  'healed',
  'cancelled',
];
