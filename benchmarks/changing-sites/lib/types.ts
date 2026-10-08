/**
 * Changing-sites bench — expectation schema + evidence shapes.
 * Spec: docs/specs/bench/spec-changing-sites.md §5
 */

export type MutationClass =
  | 'cosmetic-churn' | 'label-rename' | 'dom-restructure' | 'element-swap'
  | 'element-moved' | 'decoy-added' | 'delayed-render' | 'feature-removed'
  | 'assertion-changed' | 'unrelated-content';

export type ExpectedOutcome =
  /** r2 passed, zero healing events, cache-only sources, zero resolution tokens. */
  | 'pass-unchanged'
  /** r2 healed via resolve_and_retry, cache row repointed, r3 passes from cache. */
  | 'heal-learned'
  /** r2 healed by any strategy; learned vs not-learned is sub-classified (GAP). */
  | 'heal-any'
  /** Robust selectors may survive the mutation: passed or healed both fine; failing is not. */
  | 'pass-or-heal'
  /** r2 must FAIL honestly; green = FALSE-PASS = bench hard fail. */
  | 'must-fail'
  /** r2 green AND no selector anywhere touches a decoy-marked element. */
  | 'decoy-resist';

/** All regexes, case-insensitive. Fields present are ANDed. */
export interface CaseMatcher {
  namePattern?: string;
  /** Matched against the joined rawText of the run's steps — most stable across analyze runs. */
  stepPattern?: string;
}

export interface Expectation {
  /** Stable scoreboard id, e.g. 'vanilla.login.churn'. */
  id: string;
  match: CaseMatcher;
  mutation: MutationClass;
  outcome: ExpectedOutcome;
  /** For heal outcomes: which strategies are legitimate. Omit = any. */
  allowedStrategies?: string[];
  /** Observed-reality set (calibrated): which failure classes may precede the heal. Omit = any. */
  allowedFailureClasses?: string[];
  /** decoy-resist / must-fail: substrings that mark decoy elements. */
  decoyMarkers?: string[];
  notes?: string;
}

export interface SiteExpectations {
  site: string;
  /** Cases matching NO expectation are held to this (default 'pass-unchanged') — unmatched mutated flows fail loudly. */
  defaultOutcome: ExpectedOutcome;
  expectations: Expectation[];
}

// ── Evidence shapes (what run.ts digests + snapshots) ────────────────────────

export type HealEvidence = { class: string; strategy: string; ok: boolean; old: string | null; new: string | null };

export type StepEvidence = {
  i: number; text: string | null; status: string; source: string | null;
  selector: string | null; errorType: string | null; failureClass: string | null;
  tokens: number; heals: HealEvidence[];
};

export type RunEvidence = { runId: string; caseName: string | null; status: string; steps: StepEvidence[] };

export type CacheRowEvidence = {
  content_hash: string; domain: string;
  selectors: Array<{ selector: string }>;
  confidence_score: number | string; outcome_window: unknown;
  last_verified_at: string | null; pinned_at: string | null;
};

export type SiteEvidence = {
  site: string; host: string; suiteId: string; tenantId: string;
  cases: Array<{ id: string; name: string }>;
  unvalidated: unknown[];
  r1: RunEvidence[];
  [key: `r2_${string}`]: RunEvidence[] | undefined;
  [key: `r3_${string}`]: RunEvidence[] | undefined;
  cacheAfterR1?: CacheRowEvidence[];
} & Record<string, unknown>;

// ── Verdicts ─────────────────────────────────────────────────────────────────

export type Verdict = 'PASS' | 'GAP' | 'FAIL' | 'FALSE-PASS';

export interface CaseVerdict {
  caseName: string;
  expectationId: string;
  mutation: MutationClass | 'default';
  outcome: ExpectedOutcome;
  verdict: Verdict;
  reasons: string[];
}

export interface SiteVerdict {
  site: string;
  version: string;
  verdicts: CaseVerdict[];
  negativeControlViolations: string[];
  counts: Record<Verdict, number>;
}

export const DEFAULT_DECOY_MARKERS = ['data-decoy', 'decoy-'];
