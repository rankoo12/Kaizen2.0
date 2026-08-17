import { ScenarioWriter, summariseRawSteps } from '../write/scenario-writer';
import { groundingNotes } from '../write/grounding-notes';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';
import type { IObservability } from '../../observability/interfaces';
import type { GroundingElement, PlannedScenario, WriteInput } from '../../../types/test-writer';

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
