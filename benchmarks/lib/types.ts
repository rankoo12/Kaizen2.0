/**
 * Kaizen resolution-robustness benchmark — fixture, oracle, and scorecard types.
 *
 * The oracle (expected outcome) lives here in typed fixtures, NOT in the DB —
 * the test_steps schema has no expected-result column. Each test is run twice
 * (cold, then warm) so we measure both correctness AND learning.
 */

export type Category = 'e2e-flow' | 'mid' | 'small-feature' | 'adversarial-negative';
export type RunVerdict = 'passed' | 'failed' | 'healed';

/** Resolution sources that cost ZERO LLM tokens — "learned cheaply". */
export type ZeroTokenSource = 'redis' | 'db_exact' | 'archetype';
export const ZERO_TOKEN_SOURCES: ZeroTokenSource[] = ['redis', 'db_exact', 'archetype'];

/** Steps that are known-hard today; tracked but not a regression until fixed. */
export type KnownLimitation = 'class-A-scoped-selector' | 'class-B-anomaly' | 'html5-dnd';

/** Per-step expectation. Only assert what matters for that step. */
export interface StepExpectation {
  /** 0-based step_index. */
  index: number;
  /** WARM run: must resolve via a zero-token source AND selector is not a transient kaizenId. */
  mustLearn?: boolean;
  /** Stricter: warm resolution_source must be in this allow-list. */
  mustResolveVia?: ZeroTokenSource[];
  /** Negative tests: this step MUST fail (status='failed'). */
  mustFail?: boolean;
  /** Capture guard: the run-scoped variable must exist / be non-empty / match. */
  expectCapture?: { name: string; nonEmpty?: boolean; matches?: string };
  /** Wrong-element proxy: selector_used must contain this substring. */
  expectSelectorIncludes?: string;
  /** Blind-spot / wrong-element proxy: selector_used must NOT contain this (e.g. 'data-kaizen-id'). */
  expectSelectorExcludes?: string;
}

export interface BenchmarkTest {
  /** Stable slug — the scorecard key. */
  id: string;
  name: string;
  baseUrl: string;
  /** Extra hosts to evict (multi-domain tests). baseUrl + navigate hosts are auto-derived. */
  hosts?: string[];
  category: Category;
  /** Natural-language steps (1..100; keep ≤ ~12 — stop-on-fail halts at the first unhealed fail). */
  steps: string[];
  oracle: {
    /** Expected terminal run status. */
    verdict: RunVerdict;
    /** If true, 'healed' counts as a verdict pass (still tracked as a heal). */
    healedAcceptable?: boolean;
    /** Every resolution step must be zero-token on the warm run (excludes knownLimitation steps). */
    mustLearnAll?: boolean;
    /** Ceiling on warm-run resolution tokens (llmSummary.totalTokens). Default 0. */
    maxWarmResolutionTokens?: number;
    /** Per-step expectations. */
    steps?: StepExpectation[];
  };
  /** Marks the test/steps as tracked-but-not-a-regression until the corresponding fix lands. */
  knownLimitation?: KnownLimitation;
  tags?: string[];
}

// ─── Runtime results ──────────────────────────────────────────────────────────

export interface StepResult {
  index: number;
  status: string; // passed | failed | healed | skipped
  src: string | null; // resolution_source
  tok: number; // tokens_used
  dur: number; // duration_ms
  sel: string; // selector_used
  capturedName: string | null;
  capturedValue: string | null;
  /** Stored screenshot key (gs://… or local path) for this step's "after" frame. */
  shot: string | null;
}

export interface RunResult {
  runId: string;
  status: string; // terminal run status
  /** SUM of step_results.tokens_used (accurate; from GET /runs/:id/report). */
  resolutionTokens: number;
  llmResolvedSteps: number;
  cacheResolvedSteps: number;
  steps: StepResult[];
  infraError?: string; // set when the run failed for an infra reason (retry-worthy)
}

export interface ColdWarm {
  cold: RunResult;
  warm: RunResult;
}

// ─── Scorecard ────────────────────────────────────────────────────────────────

/**
 * Screenshot-based verdict — a vision model looks at the outcome frame and judges,
 * like a human QA, whether the test's intended end state is actually on screen.
 * Layered ON TOP of the oracle: when the two DISAGREE (`diverges`), that is the
 * highest-signal finding — e.g. the app did the right thing but Kaizen's assertion
 * mis-fired (oracle red, visual green), or a false-pass (oracle green, visual red).
 */
export interface VisualVerdict {
  /** A visual check was attempted (screenshot present + validator configured). */
  ran: boolean;
  /** Model verdict: did the screenshot confirm the intended end state? null if not run. */
  pass: boolean | null;
  confidence?: number;
  /** ≤1 sentence: what the model observed on screen. */
  observed?: string;
  /** ≤1 sentence: why pass/fail. */
  reason: string;
  /** Which step's "after" frame was judged. */
  stepIndex: number | null;
  /** Set by the runner: visual verdict disagrees with the oracle's functional verdict. */
  diverges?: boolean;
  error?: string;
}

export interface TestScore {
  id: string;
  category: Category;
  verdictOk: boolean;
  mustLearnOk: boolean;
  wrongElement: boolean;
  /** Warm steps still resolving to a transient kaizenId (never learn). */
  blindSpotSteps: number[];
  healedOnWarm: number[];
  coldTokens: number;
  warmTokens: number;
  coldStatus: string;
  warmStatus: string;
  knownLimitation?: KnownLimitation;
  /** Human-readable reasons the test is not green. */
  notes: string[];
  green: boolean;
  /** Screenshot verdict (present when --visual ran). */
  visual?: VisualVerdict;
}

export interface Scorecard {
  generatedAt: string;
  tests: TestScore[];
  aggregate: {
    total: number;
    green: number;
    verdictCorrect: number;
    mustLearnPass: number;
    wrongElement: number;
    blindSpotSteps: number;
    coldTokens: number;
    warmTokens: number;
    /** Visual validation (present when --visual ran). */
    visualChecked?: number;
    visualPass?: number;
    visualDiverge?: number;
  };
}
