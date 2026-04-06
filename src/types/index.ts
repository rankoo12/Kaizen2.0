/**
 * Kaizen — canonical shared types.
 *
 * These types are the source of truth for cross-module communication.
 * They are derived directly from the interface definitions in Section 6
 * of the master spec (docs/kaizen-spec-v2.md).
 *
 * Rule: no module imports another module's implementation.
 *       All cross-module data flows through these types.
 */

// ─── Test Compilation ────────────────────────────────────────────────────────

export type StepAction =
  | 'navigate'
  | 'click'
  | 'type'
  | 'select'
  | 'assert_visible'
  | 'wait'
  | 'press_key'
  | 'scroll';

export type StepAST = {
  action: StepAction;
  /** Natural language description of the target UI element. Null for navigate/wait. */
  targetDescription: string | null;
  /** The value to type, select, or key to press. Null when not applicable. */
  value: string | null;
  /** Target URL for navigate actions. */
  url: string | null;
  rawText: string;
  /** SHA-256(normalise(rawText)) — immutable identifier for this step version. */
  contentHash: string;
};

// ─── DOM Pruning ─────────────────────────────────────────────────────────────

export type CandidateNode = {
  /** Execution tracking ID injected directly into the live DOM for zero-guesswork location */
  kaizenId?: string;
  role: string;
  /** Accessible name from the AX tree. */
  name: string;
  cssSelector: string;
  xpath: string;
  /** Center coordinates for Playwright native clicks */
  centerPoint?: { x: number; y: number };
  /** id, class, placeholder, aria-label, data-testid, etc. */
  attributes: Record<string, string>;
  textContent: string;
  isVisible: boolean;
  /** Pre-computed string similarity score against the step's targetDescription. */
  similarityScore: number;
};

// ─── Element Resolution ───────────────────────────────────────────────────────

export type SelectorStrategy = 'css' | 'xpath' | 'aria' | 'text' | 'data-testid';

export type SelectorEntry = {
  selector: string;
  strategy: SelectorStrategy;
  confidence: number;
};

export type SelectorSet = {
  selectors: SelectorEntry[];
  fromCache: boolean;
  cacheSource: 'tenant' | 'shared' | null;
};

export type ResolutionContext = {
  tenantId: string;
  domain: string;
  /** Typed as unknown here; consuming modules import Page from playwright directly. */
  page: unknown;
};

// ─── Execution ────────────────────────────────────────────────────────────────

export type StepExecutionResult = {
  status: 'passed' | 'failed';
  selectorUsed: string | null;
  errorType: string | null;
  errorMessage: string | null;
  durationMs: number;
  screenshotKey: string | null;
  domSnapshotKey: string | null;
};

// ─── Healing ─────────────────────────────────────────────────────────────────

export type FailureClass =
  | 'ELEMENT_REMOVED'
  | 'ELEMENT_MUTATED'
  | 'ELEMENT_OBSCURED'
  | 'PAGE_NOT_LOADED'
  | 'TIMING'
  | 'LOGIC_FAILURE';

export type ClassifiedFailure = {
  stepResult: StepExecutionResult;
  /** DB id of the step_results row, if one was created for this execution. */
  stepResultId?: string;
  failureClass: FailureClass;
  step: StepAST;
  previousSelector: string;
};

export type HealingContext = {
  tenantId: string;
  runId: string;
  /** Typed as unknown here; consuming modules import Page from playwright directly. */
  page: unknown;
};

export type HealingAttempt = {
  succeeded: boolean;
  newSelector: string | null;
  durationMs: number;
};

export type HealingResult = {
  succeeded: boolean;
  strategyUsed: string;
  newSelector: string | null;
  attempts: number;
  durationMs: number;
};

// ─── LLM Gateway ─────────────────────────────────────────────────────────────

export type LLMResolutionResult = {
  selectors: SelectorEntry[];
  /** True if this response was served from the prompt hash cache — no tokens consumed. */
  fromCache: boolean;
  promptTokens: number;
  completionTokens: number;
  templateVersion: string;
};

// ─── Billing ─────────────────────────────────────────────────────────────────

export type BillingEventType =
  | 'LLM_CALL'
  | 'TEST_RUN_STARTED'
  | 'SCREENSHOT_STORED'
  | 'STORAGE_GB_DAY';

export type BillingEventInput = {
  tenantId: string;
  eventType: BillingEventType;
  quantity: number;
  unit: string;
  metadata?: Record<string, unknown>;
};

export type TenantUsage = {
  tenantId: string;
  month: string;
  llmTokens: number;
  testRuns: number;
  screenshotBytes: number;
  storageGbDays: number;
};

// ─── Observability ────────────────────────────────────────────────────────────

export type Span = {
  end(): void;
  setAttribute(key: string, value: string | number | boolean): void;
};

// ─── Database / Domain enums ──────────────────────────────────────────────────

export type PlanTier = 'starter' | 'growth' | 'enterprise';
export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'healed' | 'cancelled';
export type RunTrigger = 'web' | 'api' | 'cli' | 'schedule';
export type StepResultStatus = 'passed' | 'failed' | 'healed' | 'skipped';
export type KeyScope = 'read_only' | 'execute' | 'admin';
