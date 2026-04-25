import type { StepAST } from '../types';

/**
 * Spec ref: docs/specs/workers/spec-worker-stop-on-step-failure.md
 *
 * Pure orchestration of the per-step loop, extracted so it can be unit-tested
 * without booting BullMQ, Playwright, Postgres, or Redis. The worker passes in
 * concrete implementations of each side-effect (cancel check, executeStep,
 * skip recorder, observability hooks); this function decides ordering and
 * stop-on-fail behavior.
 */

export type StepLoopStatus = 'passed' | 'failed';

export type StepLoopDeps = {
  isCancelled: (runId: string) => Promise<boolean>;
  executeStep: (
    step: StepAST,
    stepIndex: number,
    previousAfterPng: Buffer | null,
  ) => Promise<{ status: StepLoopStatus; healed: boolean; afterPng: Buffer | null }>;
  recordSkippedSteps: (
    compiledSteps: StepAST[],
    startIndex: number,
    reason: 'prior_step_failed',
  ) => Promise<void>;
  onStepFailed?: (stepIndex: number, step: StepAST) => void;
  onCancelled?: (stepsCompleted: number) => void;
};

export type StepLoopResult = {
  runPassed: boolean;
  anyHealed: boolean;
  cancelled: boolean;
  /** Number of steps that fully executed (excluding skipped tail). */
  stepsExecuted: number;
};

export async function runStepLoop(
  runId: string,
  compiledSteps: StepAST[],
  deps: StepLoopDeps,
): Promise<StepLoopResult> {
  let runPassed = true;
  let anyHealed = false;
  let cancelled = false;
  let stepsExecuted = 0;
  let previousAfterPng: Buffer | null = null;

  for (let i = 0; i < compiledSteps.length; i++) {
    if (await deps.isCancelled(runId)) {
      cancelled = true;
      deps.onCancelled?.(i);
      break;
    }

    const step = compiledSteps[i];
    const { status, healed, afterPng } = await deps.executeStep(step, i, previousAfterPng);
    previousAfterPng = afterPng;
    stepsExecuted = i + 1;

    if (status === 'failed') {
      runPassed = false;
      deps.onStepFailed?.(i, step);
      // Stop-on-fail: subsequent steps can't meaningfully execute against a
      // page state the failed step left behind. Record the remainder as skipped.
      await deps.recordSkippedSteps(compiledSteps, i + 1, 'prior_step_failed');
      break;
    } else if (healed) {
      anyHealed = true;
    }
  }

  return { runPassed, anyHealed, cancelled, stepsExecuted };
}
