import { renderIntent, describeElement } from '../write/canonical-templates';
import { stepContentHash, stepTargetHash } from '../../test-compiler/learned.compiler';
import type { GroundingElement, StepIntent } from '../../../types/test-writer';

/**
 * The renderer emits BOTH artefacts from one intent: the sentence a human reads
 * and the AST the worker executes. If they ever disagree, a reviewer approves
 * one thing and the runner does another — so the AST is asserted field by field.
 */

const BUTTON: GroundingElement = {
  id: '11111111-1111-4111-8111-111111111111',
  pageUrl: 'https://shop.test/login', role: 'button', name: 'Sign in',
  kind: 'button', revealedBy: null,
};
const FIELD: GroundingElement = {
  id: '22222222-2222-4222-8222-222222222222',
  pageUrl: 'https://shop.test/login', role: 'textbox', name: 'Email',
  kind: 'input', revealedBy: null,
};
const elements = new Map([[BUTTON.id, BUTTON], [FIELD.id, FIELD]]);

describe('describeElement', () => {
  it('names an element the way a QA engineer would write it', () => {
    expect(describeElement(BUTTON)).toBe('the "Sign in" button');
    expect(describeElement(FIELD)).toBe('the "Email" field');
  });

  it('falls back to the role noun when the element has no accessible name', () => {
    expect(describeElement({ ...BUTTON, name: '' })).toBe('the button');
  });
});

describe('renderIntent', () => {
  it('renders navigate with the url on the AST', () => {
    const { text, ast } = renderIntent({ action: 'navigate', url: 'https://shop.test/cart' }, elements);
    expect(text).toBe('navigate to https://shop.test/cart');
    expect(ast).toMatchObject({ action: 'navigate', url: 'https://shop.test/cart', targetDescription: null });
  });

  it('renders type with the value and the element description', () => {
    const { text, ast } = renderIntent(
      { action: 'type', target: { kind: 'element', elementId: FIELD.id }, value: '{{email}}' },
      elements,
    );
    expect(text).toBe('type "{{email}}" in the "Email" field');
    expect(ast).toMatchObject({
      action: 'type', targetDescription: 'the "Email" field', value: '{{email}}',
    });
  });

  it('renders click_random with its capture', () => {
    const { text, ast } = renderIntent(
      { action: 'click_random', description: 'an add to cart button', captureAs: 'selectedItem' },
      elements,
    );
    // The description carries its own article; the sentence must not double it.
    expect(text).toBe('click a random add to cart button');
    expect(ast).toMatchObject({
      action: 'click_random', targetDescription: 'an add to cart button', captureAs: 'selectedItem',
    });
  });

  it('encodes assert_attribute as attribute=expected, as the engine expects', () => {
    const { ast } = renderIntent(
      {
        action: 'assert_attribute', target: { kind: 'element', elementId: FIELD.id },
        attribute: 'value', expected: '',
      },
      elements,
    );
    expect(ast.value).toBe('value=');
  });

  it('encodes drag_and_drop destination in value, as the compiler does', () => {
    const { ast } = renderIntent(
      {
        action: 'drag_and_drop',
        target: { kind: 'element', elementId: BUTTON.id },
        destination: { kind: 'element', elementId: FIELD.id },
      },
      elements,
    );
    expect(ast).toMatchObject({
      action: 'drag_and_drop',
      targetDescription: 'the "Sign in" button',
      value: 'the "Email" field',
    });
  });

  it('renders a discover oracle from its description verbatim', () => {
    const { text, ast } = renderIntent(
      { action: 'assert_visible', target: { kind: 'description', description: 'the error message' } },
      elements,
    );
    expect(text).toBe('verify the error message is visible');
    expect(ast.targetDescription).toBe('the error message');
  });

  it('hashes exactly as the compiler would hash the same sentence', () => {
    const { text, ast } = renderIntent(
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } }, elements,
    );
    expect(ast.contentHash).toBe(stepContentHash(text));
    expect(ast.targetHash).toBe(stepTargetHash('click', 'the "Sign in" button'));
  });

  it('renders every action in the intent union without throwing', () => {
    const intents: StepIntent[] = [
      { action: 'navigate', url: 'https://shop.test/' },
      { action: 'go_back' }, { action: 'go_forward' }, { action: 'reload' }, { action: 'close_tab' },
      { action: 'switch_tab', value: 'new' },
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'double_click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'right_click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'hover', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'check', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'uncheck', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'clear', target: { kind: 'element', elementId: FIELD.id } },
      { action: 'type', target: { kind: 'element', elementId: FIELD.id }, value: 'x' },
      { action: 'select', target: { kind: 'element', elementId: FIELD.id }, value: 'x' },
      { action: 'click_random', description: 'a product link', captureAs: 'selectedItem' },
      { action: 'assert_visible', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_not_visible', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_enabled', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_disabled', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_checked', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_text', value: 'Welcome' },
      { action: 'assert_not_text', value: 'Error' },
      { action: 'assert_url', value: '/cart' },
      { action: 'assert_title', value: 'Shop' },
      { action: 'press_key', value: 'Enter' },
      { action: 'wait', value: '1000' },
      { action: 'scroll' },
    ];
    for (const intent of intents) {
      const rendered = renderIntent(intent, elements);
      expect(rendered.text.length).toBeGreaterThan(3);
      expect(rendered.ast.action).toBe(intent.action);
      expect(rendered.ast.rawText).toBe(rendered.text);
    }
  });
});
