import type { SiteExpectations } from '../lib/types';

/**
 * vanilla v2: cosmetic id/class churn on login + contact; a new testimonial
 * section on home (unrelated-content); pricing byte-identical.
 *
 * CALIBRATED 2026-10-08 (first live loop): the engine's cached selectors for
 * labeled controls are role/name-shaped, so pure id/class churn was invisible —
 * r2 passed 5/5 with zero heals. Churn is therefore pass-or-heal, not a heal
 * guarantee.
 */
const expected: SiteExpectations = {
  site: 'vanilla',
  defaultOutcome: 'pass-unchanged',
  expectations: [
    {
      id: 'vanilla.login.churn',
      match: { stepPattern: 'sign in|login|username|password' },
      mutation: 'cosmetic-churn',
      outcome: 'pass-or-heal',
      notes: 'ids/classes renamed under identical labels; role-shaped cache survives, css-shaped must heal',
    },
    {
      id: 'vanilla.contact.churn',
      match: { stepPattern: 'send message|contact|every field' },
      mutation: 'cosmetic-churn',
      outcome: 'pass-or-heal',
      notes: 'same churn contract as login',
    },
    {
      id: 'vanilla.home.control',
      match: { stepPattern: 'get started|notes your whole team' },
      mutation: 'unrelated-content',
      outcome: 'pass-unchanged',
      notes: 'new testimonial section added below — nothing the tests touch changed',
    },
  ],
};

export default expected;
