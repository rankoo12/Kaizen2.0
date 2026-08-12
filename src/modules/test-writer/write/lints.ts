import type { StepIntent } from '../../../types/test-writer';
import { isAssertion } from './step-intent.schema';

/**
 * Free AST lints — deterministic checks that strip the mechanical slice off the
 * judge's job. Advisory: findings ride into the judge prompt as evidence rather
 * than auto-rejecting, because a lint can be wrong about intent in a way a
 * reviewer (or the judge) can see and a regex cannot.
 *
 * Spec: docs/specs/test-writer/spec-generation-pipeline.md §4.4
 */

export type LintFinding = string;

const STATE_CHANGING = new Set([
  'click', 'double_click', 'right_click', 'type', 'select', 'check', 'uncheck',
  'clear', 'press_key', 'click_random', 'drag_and_drop', 'navigate',
]);

/** Values that drift between runs and turn an assertion into a false alarm. */
const VOLATILE = [
  /\$\s?\d/, /€\s?\d/, /£\s?\d/,           // prices
  /\b\d{1,2}:\d{2}\b/,                      // times
  /\b\d{4}-\d{2}-\d{2}\b/,                  // ISO dates
  /\b(?:today|yesterday|just now|minutes ago)\b/i,
];

export function lintScenario(steps: StepIntent[], kind: 'positive' | 'negative'): LintFinding[] {
  const findings: LintFinding[] = [];
  if (steps.length === 0) return ['scenario has no steps'];

  const lastIndex = steps.length - 1;
  const last = steps[lastIndex];

  // ── delta-assertion: the final assertion must follow something that changed
  //    state. Navigation COUNTS: arriving somewhere is a change, so asserting
  //    the destination is a genuine delta (404 pages, auth gates and journey
  //    hops are all navigate-driven and were being condemned wholesale).
  //    The vacuous case this still catches is an assertion about the page the
  //    scenario was already sitting on.
  //
  //    NOTE (2026-08-12): spec-validation-trust.md §4.4 asks for this scan to
  //    start after the LAST navigate. Implementing that verbatim re-condemns
  //    the navigation-driven tests the rule above was corrected for — proven by
  //    lints.test.ts's 404 case — and it would not have caught any of the four
  //    live false-greens, which all ran real actions (type + press_key) after
  //    their navigate. Telling "asserting the destination" apart from
  //    "asserting what was already on it" needs to know which elements the
  //    crawl observed on that page, which this function is not given. Left as
  //    the live-validated behaviour pending that decision.
  if (isAssertion(last.action)) {
    const priorActing = steps.slice(0, lastIndex).some((s) => STATE_CHANGING.has(s.action));
    if (!priorActing) {
      findings.push(
        'final assertion is not preceded by any action — it asserts the page as it ' +
        'already existed (vacuous)',
      );
    }
  } else {
    findings.push('scenario does not end on an assertion');
  }

  // ── negative-shape: Tier-1 negatives assert the PRESENCE of a rejection.
  if (kind === 'negative') {
    const endsOnPresence = last.action === 'assert_visible'
      || last.action === 'assert_text'
      || last.action === 'assert_url'
      || last.action === 'assert_title';
    if (!endsOnPresence) {
      findings.push(
        'negative scenario does not end on a positive assertion of the rejection state ' +
        '(error visible / url unchanged) — absence-of-success is a weak oracle',
      );
    }
  }

  // ── determinism
  const nonWaitSteps = steps.filter((s) => s.action !== 'wait');
  const waitSteps = steps.filter((s) => s.action === 'wait');
  if (waitSteps.length > 0 && nonWaitSteps.every((s) => !isAssertion(s.action))) {
    findings.push('uses wait as the only synchronisation');
  }
  for (const step of steps) {
    const value = 'value' in step ? step.value : undefined;
    if (typeof value === 'string' && isAssertion(step.action)
        && VOLATILE.some((re) => re.test(value))) {
      findings.push(`asserts volatile content "${value}" — prices, dates and times drift between runs`);
    }
  }

  // ── click_random must close its loop with the captured token.
  const random = steps.find((s) => s.action === 'click_random');
  if (random && random.action === 'click_random') {
    const token = `{{${random.captureAs}}}`;
    const used = steps.some((s) => 'value' in s && typeof s.value === 'string' && s.value.includes(token));
    if (!used) {
      findings.push(
        `click_random captures ${token} but no later assertion uses it — the test cannot tell ` +
        'which item it actually picked',
      );
    }
  }

  return findings;
}
