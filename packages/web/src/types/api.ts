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
};

export type CaseSummary = {
  id: string;
  name: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
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
  triggeredBy: 'web' | 'api' | 'cli' | 'schedule';
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
