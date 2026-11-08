import type { SiteExpectations } from '../lib/types';

/**
 * stress v2: the "Refresh stats" control now arrives 20 SECONDS late (was
 * ~800ms) AND its id churned under the delay. Deliveries page untouched.
 *
 * CALIBRATION PENDING: whether this lands as a silent pass (engine auto-wait
 * outlasts 20s), an AdaptiveWait heal, or a re-resolve heal depends on the
 * engine's action timeout — accepted as pass-or-heal until measured, but a
 * FAILED run is always wrong.
 */
const expected: SiteExpectations = {
  site: 'stress',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'stress.deliveries.vacuous-clear',
      match: { namePattern: 'deliveries list loads with count' },
      mutation: 'none',
      outcome: 'must-fail',
      notes:
        'A VACUOUS generated draft, kept as a regression guard (2026-11-08): it clears the Search box — ' +
        'which is already empty — and then asserts the list is visible. Nothing changes, so the delta ' +
        'oracle correctly refuses it (AssertionNothingChanged): an action that did nothing cannot ' +
        'corroborate an assertion. Until the pruner stall (finding #4) was fixed this case died ' +
        'StepWatchdogTimeout at step 1 and never reached that honest verdict. It must stay red — and a ' +
        'run that PASSES it is a FALSE-PASS.',
    },
    {
      id: 'stress.refresh.delayed',
      match: { stepPattern: 'refresh stats|stats refreshed' },
      mutation: 'delayed-render',
      outcome: 'pass-or-heal',
      notes: '20s late + id churn under the delay; must not FAIL. Calibrate: expected AdaptiveWait or resolve_and_retry.',
    },
    {
      id: 'stress.kpis.control',
      match: { stepPattern: 'open deliveries|on-time|fleet in service' },
      mutation: 'unrelated-content',
      outcome: 'pass-unchanged',
      notes: 'KPI timing unchanged from v1',
    },
  ],
};

export default expected;
