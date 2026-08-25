import type { RunContext, StepAST } from '../types';
import { createRunContext } from './run-context';

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
    runContext: RunContext,
  ) => Promise<{ status: StepLoopStatus; healed: boolean; afterPng: Buffer | null }>;
  recordSkippedSteps: (
    compiledSteps: StepAST[],
    startIndex: number,
    reason: 'prior_step_failed',
  ) => Promise<void>;
  onStepFailed?: (stepIndex: number, step: StepAST) => void;
  onCancelled?: (stepsCompleted: number) => void;
  /** Per-step ceiling in ms; a step that outlives it fails the run. */
  stepWatchdogMs?: number;
};

/**
 * A Playwright call with no timeout of its own (run 30: post-Save navigation
 * wait) can wedge a worker slot forever. The watchdog fails the step — and so
 * the run — instead; the orphaned call is abandoned to the browser context's
 * eventual teardown.
 */
const STEP_WATCHDOG_MS = 60_000;

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
  seedVariables?: Record<string, string>,
): Promise<StepLoopResult> {
  let runPassed = true;
  let anyHealed = false;
  let cancelled = false;
  let stepsExecuted = 0;
  let previousAfterPng: Buffer | null = null;
  // Run-scoped variable memory: steps capture values into it and reference them
  // in later steps via {{name}} tokens. Seeded with generated form data (if any)
  // so {{email}} etc. resolve from the first step. Lives for this loop only.
  const runContext = createRunContext(seedVariables);

  for (let i = 0; i < compiledSteps.length; i++) {
    if (await deps.isCancelled(runId)) {
      cancelled = true;
      deps.onCancelled?.(i);
      break;
    }

    const step = compiledSteps[i];
    const execution = deps.executeStep(step, i, previousAfterPng, runContext);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const timedOut = Symbol('step watchdog');
    const raced = await Promise.race([
      execution,
      new Promise<typeof timedOut>((resolve) => {
        watchdog = setTimeout(() => resolve(timedOut), deps.stepWatchdogMs ?? STEP_WATCHDOG_MS);
      }),
    ]).finally(() => clearTimeout(watchdog));
    if (raced === timedOut) {
      // The abandoned call settles (or never does) against a run already over.
      execution.catch(() => {});
      runPassed = false;
      stepsExecuted = i;
      deps.onStepFailed?.(i, step);
      await deps.recordSkippedSteps(compiledSteps, i + 1, 'prior_step_failed');
      break;
    }
    const { status, healed, afterPng } = raced;
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
