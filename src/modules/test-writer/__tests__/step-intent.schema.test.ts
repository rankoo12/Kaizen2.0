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
});

describe('runSchemaGate — description-variant exemptions', () => {
  it('allows a description target for click_random', () => {
    const result = runSchemaGate([
      { action: 'click_random', description: 'an add to cart button', captureAs: 'selectedItem' },
      { action: 'assert_text', value: '{{selectedItem}}' },
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
