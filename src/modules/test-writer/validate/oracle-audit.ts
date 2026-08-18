import type { StepAST } from '../../../types';
import { isAssertion } from '../write/step-intent.schema';

/**
 * Post-run oracle audit — deterministic, zero tokens, zero browser minutes.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §2, §5
 *
 * A green run proves the resolver found SOME element for every step and nothing
 * threw. It does not prove the assertion checked what it claims to check. This
 * module closes that gap by comparing what each assertion RESOLVED TO against
 * what it CLAIMS, using only what the run already recorded.
 *
 * The four live false-greens this exists to catch:
 *   - "verify the no-results message is visible" → role=button[name="File"]
 *     (x3 runs) — an always-visible menubar button standing in for the oracle.
 *   - "verify the text {{firstName}} is shown" → input.field — the search box
 *     the test had just typed that value into, which the engine reads by
 *     scanning input values, so it cannot fail.
 */

/** What the scenario said it would do — one entry per step, prefix included. */
export type AuditStep = Pick<StepAST, 'action' | 'targetDescription' | 'value'>;

/** What the run actually did — from step_results. */
export type AuditObservation = {
  stepIndex: number;
  selectorUsed: string | null;
  resolutionSource: string | null;
  healed: boolean;
};

export type OracleAuditVerdict = {
  /** False ⇒ the case must NOT be promoted. */
  ok: boolean;
  /** Set when ok=false. */
  rule?: 'oracle_self_echo' | 'oracle_unfaithful';
  reason?: string;
  /** Terminal oracle anchored by the least-constrained resolver (L5). */
  weakOracle: boolean;
  /** The run never demonstrably reached the signed-in app (§5). */
  unprovenSignin: boolean;
  /** Human-readable notes for the job report, including skipped-rule reasons. */
  findings: string[];
};

/**
 * Identity of a resolved element, when the selector carries one.
 *
 * Playwright role selectors (`role=button[name="File"]`) name the element;
 * opaque CSS (`input.field`, `#dropdown`, `[data-test="…"]`) does not. Judging
 * faithfulness against an opaque selector would reject legitimate resolutions
 * — a real "Sign in" button genuinely resolved as `#login-submit` shares no
 * tokens with its description — so those are skipped rather than guessed at.
 * Spec §2 anticipates this: the rule tightens when §8 records role+name
 * directly on the assert event.
 */
export function parseSelectorIdentity(selector: string): { role: string; name: string } | null {
  const match = /^role=([a-zA-Z]+)(?:\[name="([^"]*)"\])?/.exec(selector.trim());
  if (!match) return null;
  return { role: match[1].toLowerCase(), name: (match[2] ?? '').trim() };
}

/** Selectors that address a value-bearing field, where self-echo is possible. */
export function resolvesToInput(selector: string): boolean {
  const s = selector.trim();
  const identity = parseSelectorIdentity(s);
  if (identity) {
    return ['textbox', 'searchbox', 'combobox', 'spinbutton'].includes(identity.role);
  }
  // CSS: the tag must be the subject, not a substring of a class name.
  return /(^|[\s>+~(,])(input|textarea|select)\b/i.test(s);
}

/**
 * Words carrying no discriminating power. Kept deliberately short: every word
 * removed here makes a rejection MORE likely, and a wrongly rejected test is a
 * real cost. These are only the ones that would otherwise let any description
 * match any element.
 */
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'its', 'are', 'was', 'has']);

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length >= 3 && !STOPWORDS.has(raw)) tokens.add(raw);
  }
  return tokens;
}

function shareToken(a: Set<string>, b: Set<string>): boolean {
  for (const token of a) if (b.has(token)) return true;
  return false;
}

/**
 * Which body steps a vacuity probe keeps: everything that POSITIONS the
 * assertion, nothing that PERFORMS the scenario.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §3
 *
 * Returns null when the scenario cannot be probed — no terminal assertion, or
 * nothing droppable, in which case there is no counterfactual to run.
 *
 * Dropping every click, keystroke and drag is also what makes the probe safe to
 * run without consent: what remains cannot submit a form or create a record.
 */
export function planVacuityProbe(
  actions: string[],
): { keptBodyIndexes: number[]; terminalIndex: number } | null {
  const terminalIndex = actions.length - 1;
  if (terminalIndex < 0 || !actions[terminalIndex].startsWith('assert_')) return null;

  // Keep the navigations AND every assertion; drop only the actions. The
  // question is the spec's own — "would the test stay green with the feature
  // removed?" — and it is answered by the whole run, not by the last line. The
  // first version kept only the terminal assertion and called every round-trip
  // test vacuous: check → verify checked → uncheck → verify not checked ends
  // where it started, so its LAST check is true before anything ran, while the
  // one in the middle is the oracle. Fourteen of seventeen "needs review" labels
  // in bench run 5 were this.
  const keptBodyIndexes: number[] = [];
  for (let i = 0; i < terminalIndex; i++) {
    if (actions[i] === 'navigate' || actions[i].startsWith('assert_')) keptBodyIndexes.push(i);
  }
  // Nothing was dropped, so the "probe" is just the scenario again.
  if (keptBodyIndexes.length === terminalIndex) return null;
  return { keptBodyIndexes, terminalIndex };
}

/**
 * A scenario that performs no action cannot be PROVEN by running it.
 *
 * "Hover Interaction" shipped as `navigate → verify the text 'Hover over the
 * image' is shown`, ran green and was labelled PROVEN — while hovering
 * nothing. Its green run proves the page loads and nothing else; the vacuity
 * probe cannot catch it because there are no actions to remove. The one
 * exception is a test ABOUT the navigation: "navigate to /secure → verify the
 * url contains /login" is a real redirect check whose whole point is that
 * arriving is the action.
 * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2.2
 */
export function isPageLoadOnly(actions: string[]): boolean {
  const body = actions.filter((a) => a !== 'wait' && a !== 'scroll');
  if (body.length === 0) return false;
  const interacts = body.some((a) => !a.startsWith('assert_') && a !== 'navigate' && a !== 'reload'
    && a !== 'go_back' && a !== 'go_forward' && a !== 'switch_tab' && a !== 'close_tab');
  if (interacts) return false;
  // Navigation-driven oracles: the destination is the observation.
  const aboutTheTrip = body.some((a) => a === 'assert_url' || a === 'assert_title');
  return !aboutTheTrip;
}

/** Compare an assertion's claim against the element it actually resolved to. */
function isUnfaithful(targetDescription: string, selector: string): boolean {
  const identity = parseSelectorIdentity(selector);
  if (!identity) return false;               // opaque selector — not judgeable
  const claimed = tokenize(targetDescription);
  if (claimed.size === 0) return false;      // nothing to compare
  const resolved = tokenize(`${identity.role} ${identity.name}`);
  return !shareToken(claimed, resolved);
}

/**
 * Audit one run. `prefixLength` is how many leading steps are the sign-in
 * recipe — those are audited too, but their failures mean "we cannot vouch for
 * the sign-in", not "the scenario is wrong" (§5).
 */
export function auditRunOracles(
  steps: AuditStep[],
  observations: AuditObservation[],
  prefixLength = 0,
): OracleAuditVerdict {
  const byIndex = new Map(observations.map((o) => [o.stepIndex, o]));
  const findings: string[] = [];
  let weakOracle = false;
  let unprovenSignin = false;

  // Every value typed before step i, paired with where it was typed. Both
  // clauses of the self-echo rule need this: the selector match catches an
  // assertion re-reading the same element, the value match catches it reading a
  // different handle on the same field (input.field vs role=textbox[…]).
  const typedBefore: Array<{ index: number; value: string; selector: string | null }> = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const observation = byIndex.get(i);
    const isPrefix = i < prefixLength;

    // `select` deliberately excluded (same reasoning as the schema gate):
    // reading back the option you chose IS the dropdown's oracle.
    if (step.action === 'type') {
      if (step.value) {
        typedBefore.push({ index: i, value: step.value, selector: observation?.selectorUsed ?? null });
      }
      continue;
    }

    if (!isAssertion(step.action)) continue;

    const selector = observation?.selectorUsed?.trim() ?? '';

    // ── Rule 1: self-echo ────────────────────────────────────────────────────
    if (selector) {
      const sameElement = typedBefore.find((t) => t.selector && t.selector.trim() === selector);
      if (sameElement) {
        return {
          ok: false,
          rule: 'oracle_self_echo',
          reason:
            `step ${i + 1} asserts on the same element step ${sameElement.index + 1} typed into ` +
            `(${selector}) — it can only confirm the test's own input`,
          weakOracle, unprovenSignin, findings,
        };
      }
    }
    if (step.value && selector && resolvesToInput(selector)) {
      const echoed = typedBefore.find(
        (t) => t.value.trim().toLowerCase() === String(step.value).trim().toLowerCase(),
      );
      if (echoed) {
        return {
          ok: false,
          rule: 'oracle_self_echo',
          reason:
            `step ${i + 1} asserts the value step ${echoed.index + 1} typed ("${step.value}") and ` +
            `resolved to a field (${selector}) — it reads back the test's own input`,
          weakOracle, unprovenSignin, findings,
        };
      }
    }

    // ── Rule 2: faithfulness ────────────────────────────────────────────────
    if (step.targetDescription && selector && isUnfaithful(step.targetDescription, selector)) {
      if (isPrefix) {
        // A sign-in step that verified the wrong element cannot vouch for the
        // sign-in — but the scenario itself may be perfectly good (§5).
        unprovenSignin = true;
        findings.push(
          `sign-in step ${i + 1} verified "${step.targetDescription}" but resolved to ${selector}`,
        );
      } else {
        return {
          ok: false,
          rule: 'oracle_unfaithful',
          reason:
            `step ${i + 1} claims to check "${step.targetDescription}" but resolved to ${selector} — ` +
            'the element it verified is not the one it names',
          weakOracle, unprovenSignin, findings,
        };
      }
    }

    // ── Rule 3: fragile terminal resolve ────────────────────────────────────
    const isTerminal = i === steps.length - 1;
    if (isTerminal && observation?.resolutionSource === 'llm') {
      weakOracle = true;
      findings.push(
        `the terminal assertion's element was chosen by the LLM resolver, not by cache or archetype`,
      );
    }
  }

  // ── Rule 4: prefix integrity ──────────────────────────────────────────────
  for (let i = 0; i < Math.min(prefixLength, steps.length); i++) {
    if (byIndex.get(i)?.healed) {
      unprovenSignin = true;
      findings.push(
        `sign-in step ${i + 1} healed onto a different element — the run may never have signed in`,
      );
    }
  }

  return { ok: true, weakOracle, unprovenSignin, findings };
}
