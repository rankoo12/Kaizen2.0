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

    if (step.action === 'type' || step.action === 'select') {
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
