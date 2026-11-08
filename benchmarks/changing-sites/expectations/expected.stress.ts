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
