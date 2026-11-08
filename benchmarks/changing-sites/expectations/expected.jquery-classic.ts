import type { SiteExpectations } from '../lib/types';

/**
 * jquery-classic v2: the Reports tab AND its pane are REMOVED (feature-removed,
 * MUST-FAIL); the accordion is reordered and wrapped in new frame divs
 * (dom-restructure, same headings/answers). Modal + activity untouched.
 */
const expected: SiteExpectations = {
  site: 'jquery-classic',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'jquery.reports.removed',
      match: { stepPattern: 'reports|weekly report' },
      mutation: 'feature-removed',
      outcome: 'must-fail',
      notes: 'the product killed the feature; a green run here healed the click onto some other tab — false-pass',
    },
    {
      id: 'jquery.accordion.restructure',
      match: { stepPattern: 'refund policy|support hours|escalation path' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'reordered + wrapped, same accessible names',
    },
  ],
};

export default expected;
