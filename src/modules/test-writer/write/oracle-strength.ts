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
 * A test whose only assertion is "is visible" passes when the app is wrong in
 * every way that matters — it proves an element exists, not that the app did the
 * right thing. This module ranks assertions so two gates can act on it without a
 * model:
 *   - a LINT that flags a scenario whose every assertion is merely "visible"
 *     (advisory: the finding rides into the judge's prompt, like the other lints);
 *   - a GUARD that blocks an LLM repair which weakens the test it was asked to fix.
 *
 * CORRECTED 2026-11-08 after looking at real generated tests. The first cut
 * called every boolean-only assertion weak, which flagged legitimate
 * state-transition tests — "toggle the checkbox, verify it is checked", "click ×,
 * verify the notification is gone" — where the state IS the outcome. The paper's
 * own definition counts "state relative to a prior step" as strong. So now:
 * only plain `assert_visible` (an element merely EXISTS) is weak.
 */

export type OracleStrength = 'weak' | 'moderate' | 'strong';

const RANK: Record<OracleStrength, number> = { weak: 1, moderate: 2, strong: 3 };

/** Assertions about a control's STATE or disappearance — informative, but binary. */
const STATE_ASSERTIONS = new Set([
  'assert_checked', 'assert_not_checked', 'assert_enabled', 'assert_disabled', 'assert_not_visible',
]);

/** Steps that act on a target (so a later state assertion on it is a TRANSITION). */
const ACTS_ON_TARGET = new Set([
  'click', 'double_click', 'right_click', 'type', 'select', 'check', 'uncheck', 'clear',
  'hover', 'drag_and_drop', 'upload',
]);

/** A comparable identity for a step's target, or null when it has none. */
function targetKey(step: StepIntent): string | null {
  const t = (step as unknown as { target?: { kind?: string; elementId?: string; description?: string } }).target;
  if (!t) return null;
  if (t.kind === 'element' && t.elementId) return `el:${t.elementId}`;
  if (t.kind === 'description' && t.description) return `desc:${t.description.trim().toLowerCase()}`;
  return null;
}

/**
 * Strength of one step as an oracle, ignoring context; null when it is not an
 * assertion.
 *   strong   — compares against a concrete value: text, count, attribute.
 *   moderate — informative but easy to satisfy: where we are (URL / title),
 *              absence of text, and a control's state or disappearance
 *              (checked / enabled / not-visible).
 *   weak     — `assert_visible`: the element merely exists.
 * Context can PROMOTE a state assertion to strong — see {@link oracleStrengthAt}.
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
    case 'assert_visible':
      return 'weak';
    default:
      return STATE_ASSERTIONS.has(action) ? 'moderate' : 'weak';
  }
}

/**
 * Strength of `steps[index]` in context. A state assertion on a target an EARLIER
 * step acted on is a transition — the checkbox the test just toggled is now
 * checked, the notification it just closed is gone — and the research counts
 * "state relative to a prior step" as strong. `assert_visible` is never promoted:
 * an element the test just clicked still being visible proves nothing.
 */
export function oracleStrengthAt(steps: StepIntent[], index: number): OracleStrength | null {
  const base = oracleStrength(steps[index]);
  if (base !== 'moderate' || !STATE_ASSERTIONS.has(steps[index].action)) return base;
  const key = targetKey(steps[index]);
  if (!key) return base;
  const actedOn = steps.slice(0, index).some((s) => ACTS_ON_TARGET.has(s.action) && targetKey(s) === key);
  return actedOn ? 'strong' : base;
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
  steps.forEach((_, i) => {
    const strength = oracleStrengthAt(steps, i);
    if (!strength) return;
    p.assertions++;
    p[strength]++;
    p.score += RANK[strength];
    if (!p.best || RANK[strength] > RANK[p.best]) p.best = strength;
  });
  return p;
}

const describeProfile = (p: OracleProfile): string =>
  `${p.assertions} assertion${p.assertions === 1 ? '' : 's'}: ${p.strong} strong / ${p.moderate} moderate / ${p.weak} weak`;

/**
 * Did a rewrite make the test's oracle weaker than the original's? Returns the
 * reason, or null when it did not (or when the original asserted nothing, so
 * there was nothing to weaken). Blocks both removal (fewer assertions) and
 * dilution (same count, lower total strength — e.g. a text check, or a checked
 * state, swapped for a bare visibility check). Replacing a flagged assertion with
 * an equally strong one is allowed. Deliberately conservative: a rewrite that
 * merely DELETES an assertion is blocked even if the deleted one was wrong — the
 * caller falls back to the original, which is exactly what happened before
 * repairs existed.
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
