import type { SiteExpectations } from '../lib/types';

/**
 * angular-forms v2: the register submit <button> became an <a role="button">
 * with a new id (element-swap, same text); the profile success message changed
 * from "Profile saved successfully." to "Changes stored." (assertion-changed —
 * MUST-FAIL for any test asserting the old copy). Home + directory untouched.
 */
const expected: SiteExpectations = {
  site: 'angular-forms',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'angular.profile.assertion-changed',
      // The writer phrases the assert semantically ("profile save confirmation"),
      // not as the literal copy — match both shapes plus the case name.
      match: { stepPattern: 'profile save confirmation|profile saved successfully' },
      mutation: 'assertion-changed',
      outcome: 'must-fail',
      notes: 'the success copy no longer exists; green here means the engine faked an assertion. OBSERVED 2026-10-08: honest fail with all three heal strategies refusing — correct.',
    },
    {
      id: 'angular.profile.error-flow',
      match: { stepPattern: 'display name is required' },
      mutation: 'unrelated-content',
      outcome: 'pass-unchanged',
      notes: 'the error path is untouched by the success-copy change',
    },
    {
      id: 'angular.register.swap',
      match: { stepPattern: 'create account|handbook|work email' },
      mutation: 'element-swap',
      outcome: 'pass-or-heal',
      notes: 'role=button[name="Create account"] matches the anchor too; tag/id-anchored caches must heal',
    },
  ],
};

export default expected;
