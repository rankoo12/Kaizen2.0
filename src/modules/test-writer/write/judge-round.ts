import type { IObservability } from '../../observability/interfaces';
import type { JudgeVerdict, ScenarioRejection } from '../../../types/test-writer';
import type { WrittenScenario, WriteOutcome } from './scenario-writer';

/**
 * JUDGE with one repair round.
 * Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.2
 *
 * The judge is the gate that reasons about VALUE, and until now it was the only
 * gate with no path to improve what it read — schema failures got a repair
 * round, judge failures got deleted. So "Sort product listing → verify the url
 * contains 'inventory'" (good task, weak oracle) died with a reason that was a
 * precise rewrite instruction nobody acted on.
 *
 * Now: PROPOSE survives; everything else is rewritten ONCE with the judge's
 * own reasons and re-judged in one batched call. A REVISE whose rewrite does not
 * reach PROPOSE falls back to the original (proposed with findings, as before —
 * validation still guards it); a REJECT whose rewrite does not reach PROPOSE is
 * rejected, with both verdicts on the report and the steps of what was tried.
 *
 * Extracted from the pipeline so it can be tested with fakes: the DB, the
 * crawler and the browser have nothing to do with this decision.
 */

export type JudgeRoundDeps = {
  judge: (batch: WrittenScenario[]) => Promise<JudgeVerdict[]>;
  rewrite: (scenario: WrittenScenario, feedback: string[]) => Promise<WriteOutcome>;
  obs: IObservability;
};

export type JudgeRoundResult = {
  survivors: WrittenScenario[];
  rejected: ScenarioRejection[];
  /** Non-PROPOSE scenarios sent for a rewrite. */
  repairAttempted: number;
  /** Of those, how many came back PROPOSE after the rewrite. */
  repaired: number;
};

const failedReasons = (v: JudgeVerdict | undefined): string[] =>
  (v?.dimensions ?? []).filter((d) => !d.pass).map((d) => `${d.dimension}: ${d.reason}`);

const stepsOf = (w: WrittenScenario): string[] => w.steps.map((s) => s.text);

export async function judgeWithRepair(
  scenarios: WrittenScenario[],
  deps: JudgeRoundDeps,
): Promise<JudgeRoundResult> {
  const result: JudgeRoundResult = { survivors: [], rejected: [], repairAttempted: 0, repaired: 0 };
  if (scenarios.length === 0) return result;

  let first: Map<string, JudgeVerdict>;
  try {
    const verdicts = await deps.judge(scenarios);
    first = new Map(verdicts.map((v) => [v.planRef, v]));
  } catch (err) {
    // A judge outage must not block the pipeline — validation still guards
    // executability; only the value filter is missing for this job.
    deps.obs.log('warn', 'testwriter.judge_failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    result.survivors = scenarios;
    return result;
  }

  type Pending = { original: WrittenScenario; verdict: 'REVISE' | 'REJECT'; reasons: string[] };
  const pending: Pending[] = [];
  for (const w of scenarios) {
    const v = first.get(w.plan.name);
    if (!v || v.verdict === 'PROPOSE') { result.survivors.push(w); continue; }
    pending.push({
      original: w,
      verdict: v.verdict === 'REVISE' ? 'REVISE' : 'REJECT',
      reasons: failedReasons(v),
    });
  }
  if (pending.length === 0) return result;

  // ── One rewrite each, with the judge's reasons as the instruction.
  const candidates: Array<{ from: Pending; rewritten: WrittenScenario }> = [];
  for (const p of pending) {
    result.repairAttempted++;
    deps.obs.increment('testwriter.judge_repair_attempted', { verdict: p.verdict });
    const feedback = p.reasons.length ? p.reasons : ['did not meet the quality bar'];
    let outcome: WriteOutcome;
    try {
      outcome = await deps.rewrite(p.original, feedback);
    } catch (err) {
      outcome = {
        ok: false,
        failure: { plan: p.original.plan, stage: 'schema', reason: err instanceof Error ? err.message : String(err) },
      };
    }
    if (outcome.ok) {
      candidates.push({ from: p, rewritten: outcome.scenario });
      continue;
    }
    settleUnrescued(p, `rewrite failed: ${outcome.failure.reason}`, outcome.failure.steps ?? stepsOf(p.original));
  }

  // ── Re-judge the rewrites in one batch.
  if (candidates.length > 0) {
    let second: Map<string, JudgeVerdict> | null = null;
    try {
      const verdicts = await deps.judge(candidates.map((c) => c.rewritten));
      second = new Map(verdicts.map((v) => [v.planRef, v]));
    } catch (err) {
      deps.obs.log('warn', 'testwriter.judge_failed', {
        error: err instanceof Error ? err.message : String(err), round: 2,
      });
    }
    for (const c of candidates) {
      const v = second?.get(c.rewritten.plan.name);
      // No verdict (outage) reads as PROPOSE, same as round one.
      if (!second || !v || v.verdict === 'PROPOSE') {
        result.repaired++;
        deps.obs.increment('testwriter.judge_repair_rescued', { verdict: c.from.verdict });
        result.survivors.push(c.rewritten);
        continue;
      }
      settleUnrescued(c.from, `after one rewrite: ${failedReasons(v).join('; ') || v.verdict}`, stepsOf(c.rewritten));
    }
  }

  return result;

  /** The rewrite did not rescue it: REVISE keeps its original, REJECT is out. */
  function settleUnrescued(p: Pending, tail: string, steps: string[]): void {
    if (p.verdict === 'REVISE') {
      // Proposed with findings on the report, as REVISE always was.
      result.survivors.push(p.original);
      return;
    }
    result.rejected.push({
      name: p.original.name,
      stage: 'judge',
      reason: `${p.reasons.join('; ') || 'rejected by the quality judge'}; ${tail}`,
      steps,
    });
  }
}
