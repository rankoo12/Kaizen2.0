/**
 * Changing-sites bench — the judge. All honesty guarantees live here.
 * Spec: docs/specs/bench/spec-changing-sites.md §7
 *
 * Input: one site's raw evidence (r1/r2/r3 digests + cache snapshots) and its
 * expectations. Output: a verdict per case plus fleet-wide negative controls.
 *
 *   PASS       — the case did exactly what its expectation demands
 *   GAP        — healed, but by a strategy that persists nothing: the next run
 *                re-heals (a real engine gap the bench REPORTS, not fails)
 *   FAIL       — wrong outcome (didn't heal, broke where it shouldn't, …)
 *   FALSE-PASS — a must-fail case went green, or a heal grabbed a decoy —
 *                the worst defect a test product can have; hard bench failure
 */
import {
  type CaseVerdict, type Expectation, type ExpectedOutcome, type RunEvidence,
  type SiteEvidence, type SiteExpectations, type SiteVerdict, type StepEvidence,
  type Verdict, DEFAULT_DECOY_MARKERS,
} from './types';

const CACHE_SOURCES = new Set(['redis', 'db_exact']);
/** Strategies that persist the healed selector into selector_cache. */
const LEARNING_STRATEGIES = new Set(['ResolveAndRetryStrategy', 'resolve_and_retry']);

const matches = (pattern: string | undefined, hay: string): boolean =>
  !pattern || new RegExp(pattern, 'i').test(hay);

function findExpectation(exps: SiteExpectations, run: RunEvidence): Expectation | null {
  const name = run.caseName ?? '';
  const joined = run.steps.map((s) => s.text ?? '').join(' | ');
  for (const e of exps.expectations) {
    if (matches(e.match.namePattern, name) && matches(e.match.stepPattern, joined)) return e;
  }
  return null;
}

const succeededHeals = (run: RunEvidence) => run.steps.flatMap((s) => s.heals).filter((h) => h.ok);
const healsOf = (run: RunEvidence) => run.steps.flatMap((s) => s.heals);

function selectorsTouched(run: RunEvidence): string[] {
  const out: string[] = [];
  for (const s of run.steps) {
    if (s.selector) out.push(s.selector);
    for (const h of s.heals) { if (h.new) out.push(h.new); }
  }
  return out;
}

function decoyHit(run: RunEvidence, markers: string[]): string | null {
  for (const sel of selectorsTouched(run)) {
    for (const m of markers) if (sel.includes(m)) return sel;
  }
  return null;
}

/** Resolution tokens only — heals legitimately spend; pass-unchanged must not. */
const resolutionTokens = (run: RunEvidence) =>
  run.steps.filter((s) => s.heals.length === 0).reduce((n, s) => n + (s.tokens || 0), 0);

function judgeCase(
  exp: Expectation | { id: string; mutation: 'default'; outcome: ExpectedOutcome; allowedStrategies?: string[]; allowedFailureClasses?: string[]; decoyMarkers?: string[] },
  r2: RunEvidence,
  r3: RunEvidence | null,
): CaseVerdict {
  const reasons: string[] = [];
  let verdict: Verdict = 'PASS';
  const fail = (why: string, v: Verdict = 'FAIL') => { reasons.push(why); if (verdict !== 'FALSE-PASS') verdict = v; };

  const heals = succeededHeals(r2);
  const green = r2.status === 'passed' || r2.status === 'healed';

  switch (exp.outcome) {
    case 'pass-unchanged': {
      if (r2.status !== 'passed') fail(`expected clean pass, got ${r2.status}`);
      if (healsOf(r2).length > 0) fail(`expected zero healing events, saw ${healsOf(r2).length}`);
      const toks = resolutionTokens(r2);
      if (toks > 0) fail(`expected zero resolution tokens, spent ${toks}`);
      break;
    }

    case 'pass-or-heal': {
      if (!green) fail(`expected pass or heal, got ${r2.status}`);
      break;
    }

    case 'heal-any':
    case 'heal-learned': {
      // Drift can be absorbed one layer EARLIER than healing: when the stale
      // cache entry dies, the waterfall re-resolves fresh and L5 picks the
      // renamed control by intent (observed: react seed, "Sign in" → the model
      // chose role=button[name="Log in"], outcome verified). For heal-any that
      // adaptation is a legitimate green — demanding a literal heal event
      // would punish the engine for recovering cheaply.
      if (exp.outcome === 'heal-any' && r2.status === 'passed') {
        const adapted = r2.steps.some((s) => s.source === 'llm' && (s.tokens || 0) >= 0 && !s.heals.length && s.status === 'passed');
        if (adapted) { reasons.push('adapted at resolution (fresh L5 re-pick, no heal needed)'); break; }
      }
      if (r2.status !== 'healed') { fail(`expected a healed run, got ${r2.status}`); break; }
      if (heals.length === 0) { fail('run is healed but no succeeded healing event recorded'); break; }
      if (exp.allowedStrategies?.length && !heals.some((h) => exp.allowedStrategies!.includes(h.strategy))) {
        fail(`no heal used an allowed strategy (saw ${heals.map((h) => h.strategy).join(', ')})`);
      }
      if (exp.allowedFailureClasses?.length && !heals.some((h) => exp.allowedFailureClasses!.includes(h.class))) {
        fail(`no heal had an allowed failure class (saw ${heals.map((h) => h.class).join(', ')})`);
      }
      const learned = heals.some((h) => LEARNING_STRATEGIES.has(h.strategy));
      if (exp.outcome === 'heal-learned' && !learned) {
        fail(`expected a LEARNING heal (resolve_and_retry), saw ${heals.map((h) => h.strategy).join(', ')}`);
      }
      if (learned) {
        // r3 is the proof the learning stuck: cache-served, token-free, heal-free.
        if (!r3) fail('no r3 run to prove the heal persisted');
        else if (r3.status !== 'passed') fail(`r3 after a learning heal should pass clean, got ${r3.status}`);
        else if (healsOf(r3).length > 0) fail('r3 re-healed — the "learned" selector did not stick');
      } else if (exp.outcome === 'heal-any') {
        // Healed but nothing persisted: the documented engine gap.
        reasons.push('healed-not-learned: strategy persists nothing; next run re-heals');
        if (verdict === 'PASS') verdict = 'GAP';
      }
      break;
    }

    case 'must-fail': {
      if (green) fail(`MUST-FAIL case is ${r2.status} — the engine faked success on a removed/changed feature`, 'FALSE-PASS');
      if (r3 && (r3.status === 'passed' || r3.status === 'healed')) {
        fail(`must-fail case went ${r3.status} on r3 — late false-pass`, 'FALSE-PASS');
      }
      break;
    }

    case 'decoy-resist': {
      if (!green) fail(`expected green (decoy resisted), got ${r2.status}`);
      const markers = exp.decoyMarkers ?? DEFAULT_DECOY_MARKERS;
      const hit = decoyHit(r2, markers) ?? (r3 ? decoyHit(r3, markers) : null);
      if (hit) fail(`a selector touched a decoy element: ${hit}`, 'FALSE-PASS');
      break;
    }
  }

  return {
    caseName: r2.caseName ?? '(unnamed)',
    expectationId: exp.id,
    mutation: exp.mutation,
    outcome: exp.outcome,
    verdict,
    reasons,
  };
}

/** Fleet-wide negative controls — apply to EVERY green run regardless of expectation. */
function negativeControls(runs: RunEvidence[], markers: string[]): string[] {
  const violations: string[] = [];
  for (const r of runs) {
    const green = r.status === 'passed' || r.status === 'healed';
    if (!green) continue;
    for (const s of r.steps) {
      if (s.errorType === 'AssertionHealedOntoDifferentElement') {
        violations.push(`${r.caseName ?? r.runId}: green run carries AssertionHealedOntoDifferentElement on step #${s.i}`);
      }
    }
    const hit = decoyHit(r, markers);
    if (hit) violations.push(`${r.caseName ?? r.runId}: green run touched decoy selector ${hit}`);
  }
  return violations;
}

export function judgeSite(evidence: SiteEvidence, exps: SiteExpectations, version: string): SiteVerdict {
  const r2 = (evidence[`r2_${version}`] ?? []) as RunEvidence[];
  const r3 = (evidence[`r3_${version}`] ?? []) as RunEvidence[];
  const r3ByCase = new Map(r3.map((r) => [r.caseName ?? r.runId, r]));

  const verdicts: CaseVerdict[] = r2.map((run) => {
    const exp = findExpectation(exps, run)
      ?? { id: `${exps.site}.default`, mutation: 'default' as const, outcome: exps.defaultOutcome };
    return judgeCase(exp, run, r3ByCase.get(run.caseName ?? run.runId) ?? null);
  });

  const allMarkers = [
    ...new Set(exps.expectations.flatMap((e) => e.decoyMarkers ?? [])),
    ...DEFAULT_DECOY_MARKERS,
  ];
  const negativeControlViolations = negativeControls([...r2, ...r3], allMarkers);

  const counts: Record<Verdict, number> = { 'PASS': 0, 'GAP': 0, 'FAIL': 0, 'FALSE-PASS': 0 };
  for (const v of verdicts) counts[v.verdict]++;

  return { site: exps.site, version, verdicts, negativeControlViolations, counts };
}
