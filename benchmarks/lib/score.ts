/**
 * Score a cold+warm run pair against a fixture oracle.
 *
 * Green = correct verdict (cold AND warm) + learns on warm (or within the token ceiling
 * for tracked known-limitations) + no wrong-element. Learning is measured on the WARM run:
 * resolution steps must come from a zero-token source with a non-transient selector.
 */
import type { BenchmarkTest, ColdWarm, RunResult, StepResult, TestScore, Scorecard } from './types';
import { ZERO_TOKEN_SOURCES } from './types';

const isTransient = (sel: string) => /data-kaizen-id/.test(sel);
const stepAt = (r: RunResult, i: number): StepResult | undefined => r.steps.find((s) => s.index === i);

/** A run's verdict is acceptable for the oracle (heal counts as a functional pass). */
function verdictAcceptable(test: BenchmarkTest, run: RunResult): { ok: boolean; note?: string } {
  const o = test.oracle;
  if (run.status === 'timeout' || run.infraError) return { ok: false, note: `infra: ${run.infraError ?? run.status}` };

  if (o.verdict === 'failed') {
    if (run.status !== 'failed') return { ok: false, note: `expected FAIL, got ${run.status} (false-pass risk)` };
    // Failed for the right reason: the designated must-fail step failed, everything before it passed.
    const mf = o.steps?.find((s) => s.mustFail);
    if (mf) {
      const failStep = stepAt(run, mf.index);
      if (failStep?.status !== 'failed') return { ok: false, note: `must-fail step ${mf.index} did not fail (status=${failStep?.status})` };
      const priorBad = run.steps.filter((s) => s.index < mf.index && !['passed', 'healed'].includes(s.status));
      if (priorBad.length) return { ok: false, note: `failed early at step ${priorBad[0].index}, not the intended step ${mf.index}` };
    }
    return { ok: true };
  }

  // Positive / healed oracle: passed or healed are both functional passes.
  if (run.status === 'passed') return { ok: true };
  if (run.status === 'healed') return { ok: true, note: 'passed via heal' };
  return { ok: false, note: `expected ${o.verdict}, got ${run.status}` };
}

export function scoreTest(test: BenchmarkTest, cw: ColdWarm): TestScore {
  const { cold, warm } = cw;
  const notes: string[] = [];

  // ── verdict (day-0 cold AND warm; no stale-cache regression) ──
  const cv = verdictAcceptable(test, cold);
  const wv = verdictAcceptable(test, warm);
  if (!cv.ok) notes.push(`cold verdict: ${cv.note}`);
  if (!wv.ok) notes.push(`warm verdict: ${wv.note}`);
  if (cv.note === 'passed via heal') notes.push('cold healed');
  if (wv.note === 'passed via heal') notes.push('warm healed');
  const verdictOk = cv.ok && wv.ok;

  // ── which steps actually invoked a resolver (have a source) — measured cold ──
  const resolutionIdx = cold.steps.filter((s) => s.src != null).map((s) => s.index);
  const mustLearnIdx = new Set<number>();
  if (test.oracle.mustLearnAll) resolutionIdx.forEach((i) => mustLearnIdx.add(i));
  for (const e of test.oracle.steps ?? []) if (e.mustLearn) mustLearnIdx.add(e.index);

  // ── must-learn on WARM: zero-token source, no transient selector ──
  let mustLearnOk = true;
  for (const i of mustLearnIdx) {
    const s = stepAt(warm, i);
    if (!s) { mustLearnOk = false; notes.push(`must-learn step ${i} missing on warm`); continue; }
    // "Learned cheaply" = any cache/vector source that spent ZERO LLM tokens on the warm
    // run with a stable (non-transient) selector. pgvector_step/element hits count too.
    void ZERO_TOKEN_SOURCES;
    const learned = s.src != null && s.src !== 'llm' && s.tok === 0 && !isTransient(s.sel);
    if (!learned) { mustLearnOk = false; notes.push(`step ${i} did not learn (warm src=${s.src} tok=${s.tok}${isTransient(s.sel) ? ' transient' : ''})`); }
  }

  // ── blind spots (warm transient selectors) + heals ──
  const blindSpotSteps = warm.steps.filter((s) => isTransient(s.sel)).map((s) => s.index);
  const healedOnWarm = warm.steps.filter((s) => s.status === 'healed').map((s) => s.index);

  // ── wrong-element proxies (explicit selector/capture guards; negatives handled in verdict) ──
  let wrongElement = false;
  for (const e of test.oracle.steps ?? []) {
    const s = stepAt(warm, e.index) ?? stepAt(cold, e.index);
    if (!s) continue;
    if (e.expectSelectorIncludes && !s.sel.includes(e.expectSelectorIncludes)) {
      wrongElement = true; notes.push(`step ${e.index} selector "${s.sel}" missing "${e.expectSelectorIncludes}" (wrong element)`);
    }
    if (e.expectSelectorExcludes && s.sel.includes(e.expectSelectorExcludes)) {
      notes.push(`step ${e.index} selector still contains "${e.expectSelectorExcludes}" (not learned)`);
    }
    if (e.expectCapture) {
      const cap = s.capturedValue ?? '';
      if (e.expectCapture.nonEmpty && !cap.trim()) { wrongElement = true; notes.push(`step ${e.index} captured "${e.expectCapture.name}" is empty`); }
      if (e.expectCapture.matches && !new RegExp(e.expectCapture.matches, 'i').test(cap)) { wrongElement = true; notes.push(`step ${e.index} capture "${cap}" !~ /${e.expectCapture.matches}/`); }
    }
  }

  // ── cost ceiling (only gates when a fixture sets one; state-assertions legitimately
  //    resolve no-cache every run, so normal tests rely on per-interaction must-learn) ──
  const ceiling = test.oracle.maxWarmResolutionTokens;
  const withinCost = ceiling == null || warm.resolutionTokens <= ceiling;
  if (!withinCost) notes.push(`warm tokens ${warm.resolutionTokens} > ceiling ${ceiling}`);

  // ── green ──
  // Known-limitation tests are green on verdict + cost + no-wrong-element (must-learn relaxed, tracked).
  const learnGate = test.knownLimitation ? true : mustLearnOk;
  const green = verdictOk && learnGate && withinCost && !wrongElement;

  return {
    id: test.id, category: test.category, verdictOk, mustLearnOk, wrongElement,
    blindSpotSteps, healedOnWarm, coldTokens: cold.resolutionTokens, warmTokens: warm.resolutionTokens,
    coldStatus: cold.status, warmStatus: warm.status, knownLimitation: test.knownLimitation, notes, green,
  };
}

export function aggregate(scores: TestScore[], generatedAt: string): Scorecard {
  const visualRan = scores.filter((s) => s.visual?.ran);
  const agg: Scorecard['aggregate'] = {
    total: scores.length,
    green: scores.filter((s) => s.green).length,
    verdictCorrect: scores.filter((s) => s.verdictOk).length,
    mustLearnPass: scores.filter((s) => s.mustLearnOk).length,
    wrongElement: scores.filter((s) => s.wrongElement).length,
    blindSpotSteps: scores.reduce((n, s) => n + s.blindSpotSteps.length, 0),
    coldTokens: scores.reduce((n, s) => n + s.coldTokens, 0),
    warmTokens: scores.reduce((n, s) => n + s.warmTokens, 0),
  };
  if (visualRan.length) {
    agg.visualChecked = visualRan.length;
    agg.visualPass = visualRan.filter((s) => s.visual?.pass === true).length;
    agg.visualDiverge = visualRan.filter((s) => s.visual?.diverges).length;
  }
  return { generatedAt, tests: scores, aggregate: agg };
}
