import { classifyScenarioSafety } from '../write/write-safety';
import type { GroundingElement, StepIntent } from '../../../types/test-writer';

/**
 * The generation-side safety split (spec §4.2). The distinction that matters:
 * recon's lexicon exists to stop a robot touching anything while exploring;
 * reusing it here would block checkout, save and confirm — exactly the journeys
 * worth testing. So: irreversible actions are blocked, record-creating actions
 * need consent, and ordinary form interaction is allowed.
 */

function element(id: string, role: string, name: string): GroundingElement {
  return {
    id, pageUrl: 'https://shop.test/', role, name, kind: 'button',
    revealedBy: null, selector: `#${id.slice(0, 4)}`,
  };
}

const PAY = element('11111111-1111-4111-8111-111111111111', 'button', 'Pay now');
const SIGNUP = element('22222222-2222-4222-8222-222222222222', 'button', 'Create account');
const TERMS = element('33333333-3333-4333-8333-333333333333', 'checkbox', 'I accept the terms');
const CHECKOUT = element('44444444-4444-4444-8444-444444444444', 'button', 'Proceed to checkout');
const SEARCH = element('55555555-5555-4555-8555-555555555555', 'button', 'Search');

const elements = new Map([PAY, SIGNUP, TERMS, CHECKOUT, SEARCH].map((e) => [e.id, e]));
const opts = { safeMode: true, stopBeforeMoney: false };

const click = (id: string): StepIntent => ({ action: 'click', target: { kind: 'element', elementId: id } });

describe('classifyScenarioSafety', () => {
  it('blocks a step that presses the money button', () => {
    const decision = classifyScenarioSafety([click(PAY.id)], elements, opts);
    expect(decision.verdict).toBe('blocked');
  });

  it('requires consent for account creation', () => {
    const decision = classifyScenarioSafety([click(SIGNUP.id)], elements, opts);
    expect(decision.verdict).toBe('needs-consent');
  });

  it('allows checking a terms box — recon\'s role rule does not apply to generated tests', () => {
    const decision = classifyScenarioSafety(
      [{ action: 'check', target: { kind: 'element', elementId: TERMS.id } }], elements, opts,
    );
    expect(decision.verdict).toBe('allowed');
  });

  it('allows walking toward checkout', () => {
    const decision = classifyScenarioSafety([click(CHECKOUT.id)], elements, opts);
    expect(decision.verdict).toBe('allowed');
  });

  it('blocks the money step inside a stop-before-money archetype', () => {
    const decision = classifyScenarioSafety(
      [click(CHECKOUT.id), click(PAY.id)], elements,
      { safeMode: false, stopBeforeMoney: true },
    );
    expect(decision.verdict).toBe('blocked');
    if (decision.verdict === 'blocked') expect(decision.reason).toContain('stop before the payment');
  });

  it('treats assertions as always safe', () => {
    const decision = classifyScenarioSafety([
      { action: 'assert_visible', target: { kind: 'element', elementId: PAY.id } },
      { action: 'assert_text', value: 'Pay now' },
    ], elements, opts);
    expect(decision.verdict).toBe('allowed');
  });

  it('allows a plain search interaction', () => {
    const decision = classifyScenarioSafety([
      { action: 'type', target: { kind: 'element', elementId: SEARCH.id }, value: 'shoes' },
      { action: 'press_key', value: 'Enter' },
    ], elements, opts);
    expect(decision.verdict).toBe('allowed');
  });

  it('flags click_random on an add-to-cart class as needing consent', () => {
    const decision = classifyScenarioSafety([
      { action: 'click_random', description: 'an add to cart button', captureAs: 'selectedItem' },
    ], elements, opts);
    expect(decision.verdict).toBe('needs-consent');
  });
});
