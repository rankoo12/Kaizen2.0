import { ScenarioWriter, summariseRawSteps, checkChromeOnly, prependNavigate } from '../write/scenario-writer';
import { groundingNotes } from '../write/grounding-notes';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type {
  GroundingElement, PlannedScenario, ScenarioExpectation, StepIntent, WriteInput,
} from '../../../types/test-writer';

/**
 * Spec: docs/specs/test-writer/spec-judge-repair-loop.md §2.4, §2.5
 *
 * Two things the writer must do beyond generating: tell the model what the
 * pages do NOT have before it goes looking, and keep what was written when a
 * gate rejects it — a rejection nobody can read cannot be checked.
 */

function element(id: string, role: string, name: string): GroundingElement {
  return { id, pageUrl: 'https://shop.test/inventory', role, name, kind: role, revealedBy: null, selector: null };
}

const CART_LINK = element('11111111-1111-4111-8111-111111111111', 'link', 'Cart');
const ADD_BTN = element('22222222-2222-4222-8222-222222222222', 'button', 'Add to cart');
const SEARCH_BOX = element('33333333-3333-4333-8333-333333333333', 'searchbox', 'Search');
const SORT = element('44444444-4444-4444-8444-444444444444', 'combobox', '');

const plan: PlannedScenario = {
  name: 'Search for a product', journey: null, kind: 'happy', priority: 'normal',
  rationale: 'r', outline: '', targetPages: ['https://shop.test/inventory'],
  source: { kind: 'llm' }, requiresSyntheticData: false,
};

const obs: IObservability = {
  log: jest.fn(), increment: jest.fn(), histogram: jest.fn(), gauge: jest.fn(),
} as unknown as IObservability;

function writerWith(generate: jest.Mock) {
  const gateway = { generateScenario: generate } as unknown as ITestWriterGateway;
  return new ScenarioWriter(gateway, obs);
}

const baseParams = {
  tenantId: 't1', plan, formSummaries: [], pagePath: [], seedTokens: ['email'],
  steeringNotes: null, safeMode: true, maxSteps: 10, scope: 'authenticated' as const,
};

describe('groundingNotes', () => {
  it('says there is nothing to type into when no page has a field', () => {
    const notes = groundingNotes([CART_LINK, ADD_BTN]);
    expect(notes.some((n) => /NO typeable field/.test(n))).toBe(true);
    expect(notes.some((n) => /NO dropdown/.test(n))).toBe(true);
    expect(notes.some((n) => /NO checkbox/.test(n))).toBe(true);
  });

  it('stays quiet about what IS there', () => {
    const notes = groundingNotes([CART_LINK, SEARCH_BOX, SORT]);
    expect(notes.some((n) => /typeable/.test(n))).toBe(false);
    expect(notes.some((n) => /dropdown/.test(n))).toBe(false);
    expect(notes.some((n) => /checkbox/.test(n))).toBe(true);
  });
});

describe('ScenarioWriter', () => {
  // the-internet's 404 / javascript_error / nested_frames pages: nothing
  // clickable, plenty to verify. Spec: spec-oracle-delta-and-fidelity.md §2
  it('writes a text-only test for a page with no controls at all', async () => {
    const generate = jest.fn(async (_input: WriteInput): Promise<unknown> => ({
      name: 'Not found page shows its message', kind: 'positive', rationale: 'r',
      steps: [
        { action: 'navigate', url: 'https://shop.test/nope' },
        { action: 'assert_text', value: 'Not Found' },
      ],
    }));
    const writer = writerWith(generate);
    const outcome = await writer.write({
      ...baseParams, grounding: [], pageText: ['https://shop.test/nope: Not Found. The page you are looking for...'],
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate.mock.calls[0][0].pageText).toEqual([
      'https://shop.test/nope: Not Found. The page you are looking for...',
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.scenario.steps.map((s) => s.text)).toEqual([
      'navigate to https://shop.test/nope',
      'verify the text "Not Found" is shown',
    ]);
  });

  it('tells the model what the pages lack, on the first attempt and on the repair', async () => {
    // Model types into the link both times — the saucedemo failure shape.
    const generate = jest.fn(async (_input: WriteInput): Promise<unknown> => ({
      name: 'x', kind: 'positive', rationale: 'r',
      steps: [
        { action: 'type', target: { kind: 'element', elementId: CART_LINK.id }, value: 'shoes' },
        { action: 'assert_text', value: 'shoes' },
      ],
    }));
    const outcome = await writerWith(generate).write({ ...baseParams, grounding: [CART_LINK, ADD_BTN] });

    expect(generate).toHaveBeenCalledTimes(2);
    for (const [input] of generate.mock.calls) {
      expect(input.groundingNotes?.some((n) => /NO typeable field/.test(n))).toBe(true);
    }
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.stage).toBe('schema');
    // What it wrote survives into the rejection, readable by a human.
    expect(outcome.failure.steps).toEqual([
      'type link "Cart" = "shoes"',
      'assert_text = "shoes"',
    ]);
  });

  // Spec: spec-judge-repair-loop.md §2.3 — the first draft is mini, every repair is frontier.
  it('drafts on mini and repairs on frontier; a judge rewrite is frontier from the first attempt', async () => {
    const generate = jest.fn(async (_input: WriteInput): Promise<unknown> => ({
      name: 'x', kind: 'positive', rationale: 'r',
      steps: [{ action: 'type', target: { kind: 'element', elementId: CART_LINK.id }, value: 'shoes' }],
    }));
    await writerWith(generate).write({ ...baseParams, grounding: [CART_LINK] });
    expect(generate.mock.calls.map(([i]) => i.tier)).toEqual(['mini', 'frontier']);

    generate.mockClear();
    await writerWith(generate).write({
      ...baseParams, grounding: [CART_LINK],
      judgeFeedback: ['meaningful_oracle: asserts the url'], previousSteps: ['click the "Cart" link', 'verify the url contains "cart"'],
    });
    expect(generate.mock.calls.map(([i]) => i.tier)).toEqual(['frontier', 'frontier']);
    expect(generate.mock.calls[0][0].judgeFeedback).toEqual(['meaningful_oracle: asserts the url']);
    expect(generate.mock.calls[0][0].previousSteps).toHaveLength(2);
  });

  it('keeps the rendered steps on a safety rejection', async () => {
    const PAY = element('55555555-5555-4555-8555-555555555555', 'button', 'Pay now');
    const generate = jest.fn(async (): Promise<unknown> => ({
      name: 'x', kind: 'positive', rationale: 'r',
      steps: [
        { action: 'click', target: { kind: 'element', elementId: PAY.id } },
        { action: 'assert_visible', target: { kind: 'description', description: 'the receipt' } },
      ],
    }));
    const outcome = await writerWith(generate).write({ ...baseParams, grounding: [PAY] });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.failure.stage).toBe('safety');
    expect(outcome.failure.steps).toEqual(['click the "Pay now" button', 'verify the receipt is visible']);
  });
});

describe('summariseRawSteps', () => {
  it('names the element a step cited, or marks it unknown, and never throws on junk', () => {
    const elements = new Map([[CART_LINK.id, CART_LINK]]);
    expect(summariseRawSteps([
      { action: 'click', target: CART_LINK.id },
      { action: 'click', target: { kind: 'element', elementId: '99999999-9999-4999-8999-999999999999' } },
      { action: 'click_random', description: 'an add to cart button' },
      { action: 'navigate', url: 'https://shop.test/' },
      'garbage', null,
    ], elements)).toEqual([
      'click link "Cart"',
      'click (unknown element 99999999…)',
      'click_random "an add to cart button"',
      'navigate https://shop.test/',
      'garbage', 'null',
    ]);
    expect(summariseRawSteps('not an array', elements)).toEqual([]);
  });
});

describe('checkChromeOnly', () => {
  /**
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
   * The nav bar and the footer are on every page, so a scenario made only of
   * them tests nothing about the page it was planned for — however green it runs.
   */
  const FOOTER = { ...element('55555555-5555-4555-8555-555555555555', 'link', 'Elemental Selenium'), chrome: true };
  const HOME = { ...element('66666666-6666-4666-8666-666666666666', 'link', 'Home'), chrome: true };
  const elements = new Map([
    [FOOTER.id, FOOTER], [HOME.id, HOME], [SEARCH_BOX.id, SEARCH_BOX],
  ]);

  it('objects when every interaction is site-wide, and names what to use instead', () => {
    const steps: StepIntent[] = [
      { action: 'click', target: { kind: 'element', elementId: HOME.id } },
      { action: 'click', target: { kind: 'element', elementId: FOOTER.id } },
      { action: 'assert_title', value: 'Selenium' },
    ];
    const errors = checkChromeOnly(steps, elements);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/site-wide navigation or footer/);
    expect(errors[0]).toMatch(/searchbox "Search"/);
  });

  it('is silent as soon as one interaction belongs to the page', () => {
    const steps: StepIntent[] = [
      { action: 'click', target: { kind: 'element', elementId: HOME.id } },
      { action: 'type', target: { kind: 'element', elementId: SEARCH_BOX.id }, value: 'x' },
    ];
    expect(checkChromeOnly(steps, elements)).toEqual([]);
  });

  it('ignores assertions — checking a site-wide element is not the same as testing it', () => {
    const steps: StepIntent[] = [
      { action: 'type', target: { kind: 'element', elementId: SEARCH_BOX.id }, value: 'x' },
      { action: 'assert_visible', target: { kind: 'element', elementId: FOOTER.id } },
    ];
    expect(checkChromeOnly(steps, elements)).toEqual([]);
  });

  it('says nothing about a scenario that interacts with nothing at all', () => {
    expect(checkChromeOnly([{ action: 'assert_title', value: 'x' }], elements)).toEqual([]);
  });
});

describe('prependNavigate', () => {
  /**
   * Spec: docs/specs/test-writer/spec-oracle-delta-and-fidelity.md §2
   * A test that never says where it starts runs wherever the browser was left.
   */
  const pass: ScenarioExpectation = { outcome: 'pass' };
  const click: StepIntent = { action: 'click', target: { kind: 'element', elementId: CART_LINK.id } };

  it('starts the scenario on the page it was planned for', () => {
    const result = prependNavigate([click], plan, pass);
    expect(result.steps[0]).toEqual({ action: 'navigate', url: 'https://shop.test/inventory' });
    expect(result.steps).toHaveLength(2);
  });

  it('leaves a scenario that already navigates alone', () => {
    const steps: StepIntent[] = [{ action: 'navigate', url: 'https://shop.test/cart' }, click];
    expect(prependNavigate(steps, plan, pass).steps).toEqual(steps);
  });

  it('moves the expected failure point with the steps', () => {
    const expectation: ScenarioExpectation = { outcome: 'fail', failStepIndex: 2, reason: 'rejected' };
    const result = prependNavigate([click], plan, expectation);
    expect(result.expectation).toEqual({ outcome: 'fail', failStepIndex: 3, reason: 'rejected' });
  });

  it('does nothing when the plan names no page', () => {
    const noPages = { ...plan, targetPages: [] };
    expect(prependNavigate([click], noPages, pass).steps).toEqual([click]);
  });
});
