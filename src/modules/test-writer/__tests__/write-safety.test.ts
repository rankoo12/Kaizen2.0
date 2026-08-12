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

/**
 * Authenticated scope widens the block list — spec-authenticated-scope.md §6.5.
 *
 * The base lexicon was calibrated for anonymous/throwaway scope, where "remove"
 * means "remove from cart" and nothing has an owner. Behind a login wall the
 * proving run acts as a real, possibly admin, user, and the same words act on a
 * real account.
 */
describe('classifyScenarioSafety — authenticated scope', () => {
  const REVOKE = element('66666666-6666-4666-8666-666666666666', 'button', 'Revoke');
  const REMOVE_MEMBER = element('77777777-7777-4777-8777-777777777777', 'button', 'Remove');
  const RESET = element('88888888-8888-4888-8888-888888888888', 'button', 'Reset API key');
  const REMOVE_FROM_CART = element('99999999-9999-4999-8999-999999999999', 'button', 'Remove from cart');
  const SAVE = element('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'button', 'Save changes');

  const authElements = new Map(
    [...elements.values(), REVOKE, REMOVE_MEMBER, RESET, REMOVE_FROM_CART, SAVE]
      .map((e) => [e.id, e]),
  );
  const authOpts = { safeMode: true, stopBeforeMoney: false, authenticated: true };
  const publicOpts = { safeMode: true, stopBeforeMoney: false };

  it.each([
    ['Revoke', REVOKE.id],
    ['Remove', REMOVE_MEMBER.id],
    ['Reset API key', RESET.id],
  ])('blocks "%s" when signed in as a real user', (_label, id) => {
    expect(classifyScenarioSafety([click(id)], authElements, authOpts).verdict).toBe('blocked');
  });

  it('still allows "Remove from cart" in PUBLIC scope — the base lexicon is unchanged', () => {
    expect(classifyScenarioSafety([click(REMOVE_FROM_CART.id)], authElements, publicOpts).verdict)
      .toBe('allowed');
  });

  it('blocks the same cart step under auth, erring toward the account', () => {
    // Over-blocking costs a test; under-blocking costs a customer's data.
    expect(classifyScenarioSafety([click(REMOVE_FROM_CART.id)], authElements, authOpts).verdict)
      .toBe('blocked');
  });

  it('reports a SYNTHETIC step as saving AS THE USER, not creating throwaway data', () => {
    // allow_synthetic_data was consented to as "may create disposable records".
    // Signed in, save/submit/apply overwrite the account's real settings, so the
    // reason must not claim otherwise.
    const decision = classifyScenarioSafety([click(SAVE.id)], authElements, authOpts);
    expect(decision.verdict).toBe('needs-consent');
    if (decision.verdict === 'needs-consent') {
      expect(decision.reason).toMatch(/as the signed-in user/);
    }
  });

  it('keeps the throwaway-data wording in public scope', () => {
    const decision = classifyScenarioSafety([click(SIGNUP.id)], authElements, publicOpts);
    expect(decision.verdict).toBe('needs-consent');
    if (decision.verdict === 'needs-consent') {
      expect(decision.reason).toMatch(/throwaway data/);
    }
  });

  it('leaves ordinary reading and searching allowed behind auth', () => {
    const decision = classifyScenarioSafety([
      { action: 'type', target: { kind: 'element', elementId: SEARCH.id }, value: 'shoes' },
      { action: 'press_key', value: 'Enter' },
      { action: 'assert_text', value: 'Results' },
    ], authElements, authOpts);
    expect(decision.verdict).toBe('allowed');
  });
});

/**
 * Known-entity binding: an archetype whose premise is "this thing EXISTS"
 * cannot be satisfied by a value the test invented.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §7
 */
import { checkKnownEntityBinding } from '../write/scenario-writer';
import type { PlannedScenario } from '../../../types/test-writer';

const knownEntityPlan = {
  name: 'Search for a known test',
  source: { kind: 'catalog', archetypeKey: 'search.find-known-entity' },
} as unknown as PlannedScenario;

describe('checkKnownEntityBinding', () => {
  it('rejects a seed token bound to a find-known-entity search', () => {
    // This shipped: it searched for 'Taylor', an entity the app had never heard
    // of, then asserted that text was shown — which the search box made true.
    const steps = [
      { action: 'type', target: { kind: 'element', elementId: 'x' }, value: '{{firstName}}' },
    ] as unknown as StepIntent[];

    const errors = checkKnownEntityBinding(knownEntityPlan, steps, ['firstName', 'email']);
    expect(errors.join(' ')).toContain('randomly generated value');
  });

  it('accepts a literal drawn from crawled content', () => {
    const steps = [
      { action: 'type', target: { kind: 'element', elementId: 'x' }, value: 'Checkout smoke test' },
    ] as unknown as StepIntent[];

    expect(checkKnownEntityBinding(knownEntityPlan, steps, ['firstName'])).toEqual([]);
  });

  it('leaves other archetypes alone — a seed is correct for a signup', () => {
    const signup = {
      name: 'Sign up', source: { kind: 'catalog', archetypeKey: 'auth.signup.happy' },
    } as unknown as PlannedScenario;
    const steps = [
      { action: 'type', target: { kind: 'element', elementId: 'x' }, value: '{{email}}' },
    ] as unknown as StepIntent[];

    expect(checkKnownEntityBinding(signup, steps, ['email'])).toEqual([]);
  });

  it('leaves LLM gap-fill scenarios alone — they have no archetype premise', () => {
    const llmPlan = { name: 'Something', source: { kind: 'llm' } } as unknown as PlannedScenario;
    const steps = [
      { action: 'type', target: { kind: 'element', elementId: 'x' }, value: '{{firstName}}' },
    ] as unknown as StepIntent[];

    expect(checkKnownEntityBinding(llmPlan, steps, ['firstName'])).toEqual([]);
  });
});
