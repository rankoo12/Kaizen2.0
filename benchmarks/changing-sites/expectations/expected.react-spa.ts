import type { SiteExpectations } from '../lib/types';

/**
 * react-spa v2: the Account button "Sign in" is renamed "Log in" (same element,
 * same behavior, same outcome text); nav + product grid restructured inside new
 * wrapper containers with identical accessible names.
 */
const expected: SiteExpectations = {
  site: 'react-spa',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'react.account.assert-old-name',
      // ORDER MATTERS: this narrower matcher must precede the click-flow one.
      match: { stepPattern: 'sign in button is visible|"Sign in" button is visible' },
      mutation: 'label-rename',
      outcome: 'must-fail',
      notes: 'FINDING 2026-10-08: this PASSED via a delta-sourced resolution — the worker\'s name-fidelity gate exempts delta, so a visibility assert of a RENAMED control went green. Bench catch #1; engine backlog.',
    },
    {
      id: 'react.account.rename',
      match: { stepPattern: 'click the "Sign in"|press the "Sign in"' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      notes: 'the cached name-anchored selector is dead; the heal must land on the renamed "Log in" button. Learned vs not-learned sub-classified.',
    },
    {
      id: 'react.account.flow',
      match: { stepPattern: 'signed in as|email address' },
      mutation: 'label-rename',
      outcome: 'heal-any',
      notes: 'same flow matched by its outcome/field steps in case the writer avoided quoting the button',
    },
    {
      id: 'react.products.restructure',
      match: { stepPattern: 'wishlist|browse products' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
      notes: 'wrappers added around nav and grid; names unchanged',
    },
    {
      id: 'react.nav.restructure',
      match: { stepPattern: 'products|account|home' },
      mutation: 'dom-restructure',
      outcome: 'pass-or-heal',
    },
  ],
};

export default expected;
