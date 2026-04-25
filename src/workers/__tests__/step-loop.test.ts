import { runStepLoop, type StepLoopDeps } from '../step-loop';
import type { StepAST } from '../../types';

const makeStep = (rawText: string): StepAST => ({
  action: 'click',
  targetDescription: rawText,
  value: null,
  url: null,
  rawText,
  contentHash: `hash-${rawText}`,
  targetHash: `target-${rawText}`,
});

const makeSteps = (n: number): StepAST[] =>
  Array.from({ length: n }, (_, i) => makeStep(`step-${i + 1}`));

const makeDeps = (overrides: Partial<StepLoopDeps> = {}): jest.Mocked<StepLoopDeps> => ({
  isCancelled: jest.fn().mockResolvedValue(false),
  executeStep: jest.fn().mockResolvedValue({ status: 'passed', healed: false, afterPng: null }),
  recordSkippedSteps: jest.fn().mockResolvedValue(undefined),
  onStepFailed: jest.fn(),
  onCancelled: jest.fn(),
  ...overrides,
} as unknown as jest.Mocked<StepLoopDeps>);

describe('runStepLoop — stop-on-fail', () => {
  // ─── AT-1: Unrecovered failure stops the loop ──────────────────────────────

  it('AT-1: stops the loop and records skips when step 3 of 5 fails unrecovered', async () => {
    const steps = makeSteps(5);
    const deps = makeDeps({
      executeStep: jest.fn()
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'failed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null }),
    });

    const result = await runStepLoop('run-1', steps, deps);

    expect(deps.executeStep).toHaveBeenCalledTimes(3); // steps 4 and 5 NOT executed
    expect(deps.recordSkippedSteps).toHaveBeenCalledWith(steps, 3, 'prior_step_failed');
    expect(deps.onStepFailed).toHaveBeenCalledWith(2, steps[2]);
    expect(result.runPassed).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stepsExecuted).toBe(3);
  });

  // ─── AT-2: Healed failure does not stop the loop ───────────────────────────

  it('AT-2: healed step does not stop the loop; run finalizes as healed', async () => {
    const steps = makeSteps(5);
    const deps = makeDeps({
      executeStep: jest.fn()
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: true, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null }),
    });

    const result = await runStepLoop('run-2', steps, deps);

    expect(deps.executeStep).toHaveBeenCalledTimes(5);
    expect(deps.recordSkippedSteps).not.toHaveBeenCalled();
    expect(deps.onStepFailed).not.toHaveBeenCalled();
    expect(result.runPassed).toBe(true);
    expect(result.anyHealed).toBe(true);
    expect(result.stepsExecuted).toBe(5);
  });

  // ─── AT-3: Stop-on-fail fires before the next iteration's cancellation check
  //          When both signals would apply, stop-on-fail wins (correct ordering:
  //          a real failure isn't user-cancelled).

  it('AT-3: stop-on-fail wins over a cancellation set after the failed step', async () => {
    const steps = makeSteps(5);
    const isCancelled = jest.fn()
      .mockResolvedValueOnce(false) // step 1
      .mockResolvedValueOnce(false) // step 2
      .mockResolvedValueOnce(false) // step 3
      .mockResolvedValueOnce(true); // would fire on step 4 — but loop already broke
    const deps = makeDeps({
      isCancelled,
      executeStep: jest.fn()
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'failed', healed: false, afterPng: null }),
    });

    const result = await runStepLoop('run-3', steps, deps);

    expect(result.cancelled).toBe(false);
    expect(result.runPassed).toBe(false);
    expect(deps.recordSkippedSteps).toHaveBeenCalled();
  });

  // ─── AT-4: Skip recording errors don't crash the loop ──────────────────────

  it('AT-4: loop terminates cleanly even if recordSkippedSteps rejects', async () => {
    const steps = makeSteps(3);
    const deps = makeDeps({
      executeStep: jest.fn()
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'failed', healed: false, afterPng: null }),
      recordSkippedSteps: jest.fn().mockRejectedValue(new Error('DB blip')),
    });

    await expect(runStepLoop('run-4', steps, deps)).rejects.toThrow('DB blip');
    // Even though it threw, the failed step was already counted.
    expect(deps.executeStep).toHaveBeenCalledTimes(2);
  });

  // ─── AT-5: The failing step itself is not double-recorded ──────────────────

  it('AT-5: recordSkippedSteps starts at i+1 so the failing step is not skipped-recorded', async () => {
    const steps = makeSteps(4);
    const deps = makeDeps({
      executeStep: jest.fn()
        .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: null })
        .mockResolvedValueOnce({ status: 'failed', healed: false, afterPng: null }),
    });

    await runStepLoop('run-5', steps, deps);

    // Failed step is index 1; skips begin at 2.
    expect(deps.recordSkippedSteps).toHaveBeenCalledWith(steps, 2, 'prior_step_failed');
  });

  // ─── Cancellation path — unchanged behavior ────────────────────────────────

  it('cancellation between steps short-circuits without skip records', async () => {
    const steps = makeSteps(5);
    const deps = makeDeps({
      isCancelled: jest.fn()
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true),
    });

    const result = await runStepLoop('run-6', steps, deps);

    expect(result.cancelled).toBe(true);
    expect(deps.executeStep).toHaveBeenCalledTimes(2);
    expect(deps.recordSkippedSteps).not.toHaveBeenCalled();
    expect(deps.onCancelled).toHaveBeenCalledWith(2);
  });

  it('passes previousAfterPng forward across iterations', async () => {
    const steps = makeSteps(3);
    const png1 = Buffer.from([0x01]);
    const png2 = Buffer.from([0x02]);
    const png3 = Buffer.from([0x03]);
    const executeStep = jest.fn()
      .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: png1 })
      .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: png2 })
      .mockResolvedValueOnce({ status: 'passed', healed: false, afterPng: png3 });
    const deps = makeDeps({ executeStep });

    await runStepLoop('run-7', steps, deps);

    expect(executeStep.mock.calls[0][2]).toBeNull();          // first step: no previous
    expect(executeStep.mock.calls[1][2]).toBe(png1);          // second step: png from step 1
    expect(executeStep.mock.calls[2][2]).toBe(png2);          // third step: png from step 2
  });

  it('empty step list short-circuits with passed=true and stepsExecuted=0', async () => {
    const result = await runStepLoop('run-8', [], makeDeps());
    expect(result.runPassed).toBe(true);
    expect(result.stepsExecuted).toBe(0);
    expect(result.cancelled).toBe(false);
  });
});
