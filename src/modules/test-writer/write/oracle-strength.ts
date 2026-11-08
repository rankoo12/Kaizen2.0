import type { StepIntent } from '../../../types/test-writer';
import { isAssertion } from './step-intent.schema';

/**
 * Oracle strength — a deterministic, zero-token read of how much an assertion can
 * actually tell us.
 * Spec: docs/specs/roadmap/spec-research-adoption-2026-11.md §S3 (research
 * backfill §3.6; arXiv 2606.18168 found 80% of agent-written tests carry weak or
 * no oracles, and 2605.01471 found repair agents "converge" by deleting or
 * weakening assertions).
 *
 * A test whose only assertions are "is visible" passes when the app is wrong in
 * every way that matters — it proves an element exists, not that the app did the
 * right thing. This module ranks assertions so two gates can act on it without a
 * model:
 *   - a LINT that flags a scenario whose every assertion is weak (advisory: the
 *     finding rides into the judge's prompt, like the other lints);
 *   - a GUARD that blocks an LLM repair which weakens the test it was asked to fix.
 */

export type OracleStrength = 'weak' | 'moderate' | 'strong';

const RANK: Record<OracleStrength, number> = { weak: 1, moderate: 2, strong: 3 };

/**
 * Strength of one step as an oracle, or null when it is not an assertion.
 *   strong   — compares against a concrete value: text, count, attribute.
 *   moderate — informative but easy to satisfy: URL / title (where we are, not
 *              what is there) and absence of text (nothing proves the right
 *              thing is present instead).
 *   weak     — boolean-only: visible / enabled / checked and their negations.
 */
export function oracleStrength(step: StepIntent): OracleStrength | null {
  const action: string = step.action;
  if (!isAssertion(action)) return null;
  const s = step as unknown as { value?: unknown; expected?: unknown };
  switch (action) {
    case 'assert_text':
      return typeof s.value === 'string' && s.value.trim() ? 'strong' : 'weak';
    case 'assert_count':
      return 'strong';
    case 'assert_attribute':
      return typeof s.expected === 'string' && s.expected.trim() ? 'strong' : 'weak';
    case 'assert_url':
    case 'assert_title':
    case 'assert_not_text':
      return 'moderate';
    default:
      return 'weak';
  }
}

export type OracleProfile = {
  assertions: number;
  strong: number;
  moderate: number;
  weak: number;
  /** Sum of per-assertion ranks — drops when an assertion is removed OR weakened. */
  score: number;
  /** The strongest assertion present, or null when there are none. */
  best: OracleStrength | null;
};

export function oracleProfile(steps: StepIntent[]): OracleProfile {
  const p: OracleProfile = { assertions: 0, strong: 0, moderate: 0, weak: 0, score: 0, best: null };
  for (const step of steps) {
    const strength = oracleStrength(step);
    if (!strength) continue;
    p.assertions++;
    p[strength]++;
    p.score += RANK[strength];
    if (!p.best || RANK[strength] > RANK[p.best]) p.best = strength;
  }
  return p;
}

const describeProfile = (p: OracleProfile): string =>
  `${p.assertions} assertion${p.assertions === 1 ? '' : 's'}: ${p.strong} strong / ${p.moderate} moderate / ${p.weak} weak`;

/**
 * Did a rewrite make the test's oracle weaker than the original's? Returns the
 * reason, or null when it did not (or when the original asserted nothing, so
 * there was nothing to weaken). Blocks both removal (fewer assertions) and
 * dilution (same count, lower total strength — e.g. a text check swapped for a
 * visibility check). Replacing a flagged assertion with an equally strong one is
 * allowed. Deliberately conservative: a rewrite that merely DELETES an assertion
 * is blocked even if the deleted one was wrong — the caller falls back to the
 * original, which is exactly what happened before repairs existed.
 */
export function assertionWeakening(before: StepIntent[], after: StepIntent[]): string | null {
  const b = oracleProfile(before);
  if (b.assertions === 0) return null;
  const a = oracleProfile(after);
  if (a.assertions < b.assertions) {
    return `the rewrite has fewer assertions than the original (${describeProfile(b)} → ${describeProfile(a)})`;
  }
  if (a.score < b.score) {
    return `the rewrite asserts less than the original (${describeProfile(b)} → ${describeProfile(a)})`;
  }
  return null;
}
