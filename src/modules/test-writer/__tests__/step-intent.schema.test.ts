import { runSchemaGate } from '../write/step-intent.schema';

/**
 * The schema/reference gate is what makes hallucinated elements structurally
 * impossible rather than a runtime surprise (spec-generation-pipeline §4.1).
 */

const ELEMENT_A = '11111111-1111-4111-8111-111111111111';
const ELEMENT_B = '22222222-2222-4222-8222-222222222222';
const UNKNOWN = '33333333-3333-4333-8333-333333333333';
const valid = new Set([ELEMENT_A, ELEMENT_B]);

describe('runSchemaGate — grounding', () => {
  it('accepts a scenario whose element targets were all observed', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://shop.test/login' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{email}}' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_url', value: '/dashboard' },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('rejects an elementId the crawler never observed', () => {
    const result = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: UNKNOWN } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('never observed');
  });

  it('rejects a malformed intent', () => {
    const result = runSchemaGate([{ action: 'click' }], valid, 10);
    expect(result.ok).toBe(false);
  });

  // Calibration finding: whole scenarios were dying because the model omitted
  // `kind` on an otherwise perfectly grounded target. Shape is inferable;
  // grounding is not, and stays fatal.
  it('infers a missing discriminator when the target names a real element', () => {
    const result = runSchemaGate([
      { action: 'click', target: { elementId: ELEMENT_A } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('infers a description target from a bare description', () => {
    const result = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'assert_visible', target: { description: 'the error message' } },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('accepts a bare string target, routed by whether it is an id', () => {
    const result = runSchemaGate([
      { action: 'click', target: ELEMENT_A },
      { action: 'assert_visible', target: 'the confirmation banner' },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('still rejects an inferred target whose element was never observed', () => {
    const result = runSchemaGate([
      { action: 'click', target: { elementId: UNKNOWN } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('never observed');
  });
});

describe('runSchemaGate — description-variant exemptions', () => {
  it('allows a description target for click_random', () => {
    const result = runSchemaGate([
      { action: 'click_random', description: 'an add to cart button', captureAs: 'selectedItem' },
      { action: 'assert_text', value: '{{selectedItem}}' },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  // the-internet /hovers, 2026-08-18: the caption under an avatar exists only
  // while the pointer is over it. Treating hover as inert made every page whose
  // whole subject is hover unwritable.
  // Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
  it('treats hover as a state change, so what it reveals can be asserted', () => {
    const result = runSchemaGate([
      { action: 'hover', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'assert_visible', target: { kind: 'description', description: 'the caption for the first user' } },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('allows a discover oracle directly after a state-changing action', () => {
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: 'not-an-email' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_visible', target: { kind: 'description', description: 'the error message' } },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  // saucedemo, 2026-08-17: "click Remove → verify the item is gone → verify the
  // empty-cart message" died twice because the second assertion's nearest
  // neighbour was an assertion, not the click. The whole assertion block after
  // an action follows that action.
  it('allows a run of discover oracles after one state-changing action', () => {
    const result = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_not_text', value: '{{selectedItem}}' },
      { action: 'assert_url', value: 'cart' },
      { action: 'assert_visible', target: { kind: 'description', description: 'the empty-cart message' } },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('recovers an elementId the model truncated to a unique prefix, and only then', () => {
    const ok = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: '11111111-1111-4111' } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect((ok.steps[0] as { target: { elementId: string } }).target.elementId).toBe(ELEMENT_A);

    // Too short to be a claim about anything.
    const short = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: '1111' } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(short.ok).toBe(false);

    // Ambiguous between two real ids: leave it, let grounding fail it.
    const amb = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: 'aaaaaaaa-1' } },
      { action: 'assert_url', value: '/x' },
    ], new Set(['aaaaaaaa-1111-4111-8111-111111111111', 'aaaaaaaa-1222-4222-8222-222222222222']), 10);
    expect(amb.ok).toBe(false);
  });

  // saucedemo social links: target="_blank". Asserting the title right after
  // the click reads the OLD tab and fails every time.
  it('requires switch_tab right after clicking a link that opens a new tab', () => {
    const newTab = new Set([ELEMENT_A]);
    const bad = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'assert_title', value: 'Facebook' },
    ], valid, 10, new Map(), [], newTab);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join(' ')).toContain('switch_tab');

    const good = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'switch_tab', value: 'new' },
      { action: 'assert_title', value: 'Facebook' },
    ], valid, 10, new Map(), [], newTab);
    expect(good.ok).toBe(true);
  });

  it('rejects a description target that does NOT follow a state change', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://shop.test/' },
      { action: 'assert_visible', target: { kind: 'description', description: 'the hero banner' } },
    ], valid, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('only allowed for');
  });

  it('rejects a description target on an ACTION step', () => {
    const result = runSchemaGate([
      { action: 'click', target: { kind: 'description', description: 'the checkout button' } },
      { action: 'assert_url', value: '/checkout' },
    ], valid, 10);
    expect(result.ok).toBe(false);
  });
});

describe('runSchemaGate — role compatibility', () => {
  // Found by the P2 calibration run: on a site whose signup fields live in a
  // modal, the generator cited a real element id — a LINK — and "typed" into it.
  // Existing is not the same as usable.
  const roles = new Map([[ELEMENT_A, 'link'], [ELEMENT_B, 'textbox']]);

  it('rejects typing into a link even though the id is real', () => {
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{email}}' },
      { action: 'assert_url', value: '/x' },
    ], valid, 10, roles);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('cannot type a "link" element');
  });

  it('accepts typing into a textbox', () => {
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_B }, value: '{{email}}' },
      { action: 'assert_url', value: '/x' },
    ], valid, 10, roles);
    expect(result.ok).toBe(true);
  });

  it('rejects typing into a form element (strict at generation time)', () => {
    const formRoles = new Map([[ELEMENT_A, 'form']]);
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{email}}' },
      { action: 'assert_url', value: '/x' },
    ], valid, 10, formRoles);
    expect(result.ok).toBe(false);
  });

  it('rejects checking a non-toggle element', () => {
    const result = runSchemaGate([
      { action: 'check', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10, roles);
    expect(result.ok).toBe(false);
  });

  it('allows clicking anything — pointer actions are role-agnostic', () => {
    const result = runSchemaGate([
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_A } },
      { action: 'assert_url', value: '/x' },
    ], valid, 10, roles);
    expect(result.ok).toBe(true);
  });
});

describe('runSchemaGate — value and shape rules', () => {
  it('rejects a literal email where a seed token belongs', () => {
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: 'real.person@gmail.com' },
      { action: 'assert_url', value: '/x' },
    ], valid, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('seed token');
  });

  it('allows a deliberately invalid value in a negative test', () => {
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: 'not-an-email' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_visible', target: { kind: 'description', description: 'the validation error' } },
    ], valid, 10);
    expect(result.ok).toBe(true);
  });

  it('rejects an unbound catalog placeholder that leaked into a value', () => {
    // Found by calibration: the model copied {{known_entity}} out of the
    // archetype skeleton instead of binding a real title, so the test would
    // have searched for the literal placeholder.
    const roles = new Map([[ELEMENT_A, 'searchbox']]);
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{known_entity}}' },
      { action: 'assert_text', value: 'results' },
    ], valid, 10, roles, ['email', 'password']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('not a run variable');
  });

  it('accepts a token the run actually provides, and a click_random capture', () => {
    const roles = new Map([[ELEMENT_A, 'searchbox']]);
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{email}}' },
      { action: 'click_random', description: 'a product link', captureAs: 'selectedItem' },
      { action: 'assert_text', value: '{{selectedItem}}' },
    ], valid, 10, roles, ['email', 'password']);
    expect(result.ok).toBe(true);
  });

  it('rejects an unbound skeleton slot', () => {
    const roles = new Map([[ELEMENT_A, 'searchbox']]);
    const result = runSchemaGate([
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{search_term}' },
      { action: 'assert_text', value: 'results' },
    ], valid, 10, roles, ['email']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('unbound placeholder');
  });

  it('rejects a scenario that does not end on an assertion', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://shop.test/' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_A } },
    ], valid, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('prove nothing');
  });

  it('rejects a scenario over the step cap', () => {
    const steps = Array.from({ length: 12 }, () => ({
      action: 'click', target: { kind: 'element', elementId: ELEMENT_A },
    }));
    const result = runSchemaGate(steps, valid, 10);
    expect(result.ok).toBe(false);
  });
});

/**
 * Unfalsifiable oracles — the three shapes that validated GREEN against the
 * live product and proved nothing.
 * Spec: docs/specs/test-writer/spec-validation-trust.md §4
 */
describe('runSchemaGate — unfalsifiable oracles', () => {
  it('rejects asserting the same text the scenario typed (case 73cc9af4)', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/tests' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{firstName}}' },
      { action: 'press_key', value: 'Enter' },
      { action: 'assert_text', value: '{{firstName}}' },
    ], valid, 10, new Map(), ['firstName']);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('the same text step 2 typed');
  });

  it('allows asserting a typed value when it is read from a different element', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/new' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{firstName}}' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_text', target: { kind: 'element', elementId: ELEMENT_B }, value: '{{firstName}}' },
    ], valid, 10, new Map(), ['firstName']);

    expect(result.ok).toBe(true);
  });

  it('rejects a disjunction oracle that holds however the app behaves (case 2977cb62)', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/tests' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: 'zzqx' },
      { action: 'press_key', value: 'Enter' },
      { action: 'assert_visible', target: { kind: 'description', description: 'the results or no-results header' } },
    ], valid, 10);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('accepts either outcome');
  });

  it('rejects an assert_url the scenario had already satisfied by navigating there', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/tests' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: 'zzqx' },
      { action: 'assert_url', value: 'tests' },
    ], valid, 10);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('already contained');
  });

  it('allows assert_url when a click could have moved the page since navigating', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/tests' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_url', value: 'tests' },
    ], valid, 10);

    expect(result.ok).toBe(true);
  });

  it('allows assert_url for a destination the scenario has not reached yet', () => {
    const result = runSchemaGate([
      { action: 'navigate', url: 'https://app.test/login' },
      { action: 'type', target: { kind: 'element', elementId: ELEMENT_A }, value: '{{email}}' },
      { action: 'click', target: { kind: 'element', elementId: ELEMENT_B } },
      { action: 'assert_url', value: '/dashboard' },
    ], valid, 10, new Map(), ['email']);

    expect(result.ok).toBe(true);
  });
});
