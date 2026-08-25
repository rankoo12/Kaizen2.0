import { runFactGate, buildConventions } from '../transcribe/fact-transcriber';
import { FactVerifier, stripLiveCount } from '../transcribe/fact-verifier';
import type { FactScenario } from '../transcribe/fact-transcriber';
import type { FactTest, GroundingElement, ScenarioRejection, StepIntent } from '../../../types/test-writer';
import type { IObservability } from '../../observability/interfaces';

/**
 * Fact tier — the gate that makes facts machine-verifiable, and the verifier
 * that replays them. Spec: docs/specs/test-writer/spec-agentic-testwriter.md §4
 */

const obs: IObservability = {
  log: jest.fn(),
  increment: jest.fn(),
  histogram: jest.fn(),
  startSpan: jest.fn(() => ({ end: jest.fn() })),
} as unknown as IObservability;

const EL = {
  button: '11111111-1111-1111-1111-111111111111',
  input: '22222222-2222-2222-2222-222222222222',
  newTab: '33333333-3333-3333-3333-333333333333',
  nameField: '44444444-4444-4444-4444-444444444444',
};

function elements(): Map<string, GroundingElement> {
  return new Map<string, GroundingElement>([
    [EL.button, {
      id: EL.button, pageUrl: 'http://app.local/tests', role: 'button', name: 'New Test',
      kind: 'button', revealedBy: null, selector: '#new-test',
    }],
    [EL.input, {
      id: EL.input, pageUrl: 'http://app.local/tests', role: 'textbox', name: 'Search tests',
      kind: 'input', revealedBy: null, selector: 'input.search',
    }],
    [EL.newTab, {
      id: EL.newTab, pageUrl: 'http://app.local/tests', role: 'link', name: 'Docs',
      kind: 'link', revealedBy: null, selector: 'a.docs', opensNewTab: true,
    }],
    [EL.nameField, {
      id: EL.nameField, pageUrl: 'http://app.local/tests', role: 'textbox', name: 'Test name',
      kind: 'input', revealedBy: null, selector: 'input.name',
    }],
  ]);
}

function fact(steps: StepIntent[]): FactTest {
  return { name: 'a fact', steps, rationale: 'because' };
}

describe('runFactGate', () => {
  it('accepts a grounded click-then-assert fact', () => {
    const result = runFactGate(fact([
      { action: 'click', target: { kind: 'element', elementId: EL.button } },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.input } },
    ]), elements());
    expect(result.ok).toBe(true);
  });

  it('accepts a presence-only fact (breadth is legitimate here)', () => {
    const result = runFactGate(fact([
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(true);
  });

  it('refuses description targets — the verifier resolves ids only', () => {
    const result = runFactGate(fact([
      { action: 'click', target: { kind: 'description', description: 'the save button' } },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('element-id only');
  });

  it('refuses an elementId the crawl never observed', () => {
    const result = runFactGate(fact([
      { action: 'click', target: { kind: 'element', elementId: '99999999-9999-9999-9999-999999999999' } },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
  });

  it('refuses actions outside the fact vocabulary', () => {
    const result = runFactGate(fact([
      { action: 'navigate', url: 'http://app.local/tests' },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not in the fact-tier vocabulary');
  });

  it('refuses a fact that does not end with an assertion', () => {
    const result = runFactGate(fact([
      { action: 'click', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
  });

  it('refuses role-incompatible actions (type into a button)', () => {
    const result = runFactGate(fact([
      { action: 'type', target: { kind: 'element', elementId: EL.button }, value: 'hello' },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.input } },
    ]), elements());
    expect(result.ok).toBe(false);
  });

  it('refuses clicking a new-tab link — the destination is unverifiable here', () => {
    const result = runFactGate(fact([
      { action: 'click', target: { kind: 'element', elementId: EL.newTab } },
      { action: 'assert_url', value: '/docs' },
    ]), elements());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('new tab');
  });

  it('refuses the echo trap: asserting the text just typed', () => {
    const result = runFactGate(fact([
      { action: 'type', target: { kind: 'element', elementId: EL.nameField }, value: 'needle' },
      { action: 'assert_text', value: 'needle' },
    ]), elements());
    expect(result.ok).toBe(false);
  });

  it('allows the echo when the typed element is a search box — the match is a result row', () => {
    const result = runFactGate(fact([
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: 'needle' },
      { action: 'assert_text', value: 'needle' },
    ]), elements());
    expect(result.ok).toBe(true);
  });

  it('refuses seed tokens — the verifier types literals only', () => {
    const result = runFactGate(fact([
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: '{{username}}' },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
  });

  it('refuses a non-event: acting on X and asserting only X is still there', () => {
    const result = runFactGate(fact([
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: 'AGENT' },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.input } },
    ]), elements());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('only the control it acted on');
  });

  it('keeps check-then-assert-checked — the state IS the fact', () => {
    const els = elements();
    els.set('44444444-4444-4444-4444-444444444444', {
      id: '44444444-4444-4444-4444-444444444444', pageUrl: 'http://app.local/tests', role: 'checkbox',
      name: 'Select all', kind: 'input', revealedBy: null, selector: '#all',
    });
    const result = runFactGate(fact([
      { action: 'check', target: { kind: 'element', elementId: '44444444-4444-4444-4444-444444444444' } },
      { action: 'assert_checked', target: { kind: 'element', elementId: '44444444-4444-4444-4444-444444444444' } },
    ]), els);
    expect(result.ok).toBe(true);
  });

  it('refuses contradictory visible/not-visible with no action between', () => {
    const result = runFactGate(fact([
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
      { action: 'assert_not_visible', target: { kind: 'element', elementId: EL.button } },
    ]), elements());
    expect(result.ok).toBe(false);
  });
});

describe('buildConventions', () => {
  it('keeps only lessons with content, deduplicated and capped', () => {
    const lessons = new Map<string, string[]>([
      ['http://app.local/tests', ['the app refused with "Target URL needs to start with http://"']],
    ]);
    const rejections: ScenarioRejection[] = [
      { name: 'A', stage: 'validation', reason: 'the action produced only: a closed dialog' },
      { name: 'B', stage: 'validation', reason: 'it failed at step 8 against the live site' },  // no content
      { name: 'C', stage: 'schema', reason: 'the app refused with message X' },                 // wrong stage
    ];
    const out = buildConventions(lessons, rejections);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('Target URL');
    expect(out[1]).toContain('produced only');
  });
});

describe('stripLiveCount', () => {
  it('drops a trailing live count and keeps the stable words', () => {
    expect(stripLiveCount('Tests 4')).toBe('Tests');
    expect(stripLiveCount('Demo 12')).toBe('Demo');
    expect(stripLiveCount('New Test')).toBe('New Test');
  });
});

// ─── verifier: intent execution against a scripted page ──────────────────────

type Script = {
  visible: Set<string>;          // selectors currently "visible"
  bodyText: string;
  url: string;
};

/** A minimal Playwright-page stand-in the executor drives. */
function fakePage(script: Script) {
  const locator = (selector: string) => ({
    first: () => locator(selector),
    count: async () => (script.visible.has(selector) ? 1 : 0),
    click: async () => {
      if (!script.visible.has(selector)) throw new Error(`no ${selector}`);
      if (selector === '#new-test') {
        script.visible.add('input.search');
        script.bodyText += ' Create a new test';
      }
    },
    hover: async () => {},
    fill: async (v: string) => { script.bodyText += ` ${v}`; },
    waitFor: async ({ state }: { state: string }) => {
      const shown = script.visible.has(selector);
      if (state === 'visible' && !shown) throw new Error(`${selector} not visible`);
      if (state === 'hidden' && shown) throw new Error(`${selector} still visible`);
    },
    isEnabled: async () => true,
    isChecked: async () => false,
    setChecked: async () => {},
    selectOption: async () => {},
    // mustLocateFillable checks the element's tag; selectors that name an
    // input in this fake ARE inputs, everything else is a div.
    evaluate: async (fn: (node: { tagName: string; isContentEditable: boolean }) => unknown) =>
      fn({ tagName: selector.includes('input') ? 'INPUT' : 'DIV', isContentEditable: false }),
    locator: () => ({ count: async () => 0, first: () => { throw new Error('empty'); } }),
  });
  return {
    setDefaultTimeout: () => {},
    on: () => {},
    url: () => script.url,
    goto: async (url: string) => { script.url = url; },
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async () => script.bodyText,
    locator,
    getByRole: (_role: string, opts: { name: string }) => locator(`role:${opts.name}`),
    getByText: (text: string) => locator(`text:${text}`),
    getByLabel: (text: string) => locator(`label:${text}`),
    getByPlaceholder: (text: string) => locator(`ph:${text}`),
  };
}

function verifierWith(script: Script): FactVerifier {
  const page = fakePage(script);
  const browser = { newContext: async () => ({ newPage: async () => page, close: async () => {}, addInitScript: async () => {} }) };
  const pool = { acquire: async () => browser as never, release: async () => {} };
  return new FactVerifier(pool, obs, undefined, { stepTimeoutMs: 400 });
}

function scenario(body: StepIntent[]): FactScenario {
  return {
    name: 'fact', page: 'http://app.local/tests', rationale: '',
    bodyIntents: body, intents: body, steps: [], selectorSeeds: [],
    gotoUrl: 'http://app.local/tests', hops: [], interactive: true, usesFixture: false,
  };
}

describe('FactVerifier', () => {
  it('passes a fact whose click reveals the asserted element', async () => {
    const script: Script = { visible: new Set(['#new-test']), bodyText: 'Tests', url: 'http://app.local/' };
    const verdicts = await verifierWith(script).verifyAll({
      tenantId: 't', baseUrl: 'http://app.local/',
      facts: [scenario([
        { action: 'click', target: { kind: 'element', elementId: EL.button } },
        { action: 'assert_visible', target: { kind: 'element', elementId: EL.input } },
        { action: 'assert_text', value: 'Create a new test' },
      ])],
      elements: elements(),
    });
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0].ok).toBe(true);
  });

  it('fails a fact whose assertion the live page does not confirm, naming the step', async () => {
    const script: Script = { visible: new Set(['#new-test']), bodyText: 'Tests', url: 'http://app.local/' };
    const verdicts = await verifierWith(script).verifyAll({
      tenantId: 't', baseUrl: 'http://app.local/',
      facts: [scenario([
        { action: 'assert_text', value: 'text that is not there' },
      ])],
      elements: elements(),
    });
    expect(verdicts[0].ok).toBe(false);
    expect(verdicts[0].stepIndex).toBe(0);
    expect(verdicts[0].reason).toContain('not on the page');
  });

  it('treats a completely absent element as absence for assert_not_visible', async () => {
    const script: Script = { visible: new Set<string>(), bodyText: '', url: 'http://app.local/' };
    const verdicts = await verifierWith(script).verifyAll({
      tenantId: 't', baseUrl: 'http://app.local/',
      facts: [scenario([
        { action: 'assert_not_visible', target: { kind: 'element', elementId: EL.input } },
      ])],
      elements: elements(),
    });
    expect(verdicts[0].ok).toBe(true);
  });

  it('refuses to verify outside the analyzed origin', async () => {
    const script: Script = { visible: new Set<string>(), bodyText: '', url: 'http://app.local/' };
    const facts = [scenario([
      { action: 'assert_text', value: 'anything' },
    ])];
    facts[0].gotoUrl = 'http://evil.example/steal';
    const verdicts = await verifierWith(script).verifyAll({
      tenantId: 't', baseUrl: 'http://app.local/', facts, elements: elements(),
    });
    expect(verdicts[0].ok).toBe(false);
    expect(verdicts[0].reason).toContain('outside the analyzed site');
  });
});

// ─── one bad completion costs one item, never the run ────────────────────────

import { parseModelJson } from '../../llm-gateway/testwriter.gateway';
import { transcribePage } from '../transcribe/fact-transcriber';
import type { ITestWriterGateway } from '../../llm-gateway/testwriter.interfaces';

describe('parseModelJson', () => {
  it('accepts a fenced object and prose after the closing brace', () => {
    expect(parseModelJson<{ a: number }>('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson<{ a: number }>('{"a":1}\nHope this helps!')).toEqual({ a: 1 });
  });
  it('still throws on an object that is broken inside', () => {
    expect(() => parseModelJson('{"a":1 "b":2}')).toThrow();
  });
});

describe('transcribePage containment', () => {
  it('declines the screen with the reason when the gateway throws, instead of failing the job', async () => {
    const gateway = {
      transcribeFactTests: async () => { throw new Error('Expected , or } in JSON at position 593'); },
    } as unknown as ITestWriterGateway;
    const result = await transcribePage({
      gateway, obs, tenantId: 't',
      dossier: {
        url: 'http://app.local/tests', urlNormalized: 'http://app.local/tests', title: 'Tests', headings: [],
        pageText: '', purpose: '', capabilities: [], elements: [], forms: [], requiresAuth: true,
      },
      grounding: [...elements().values()], conventions: [], factsPerPage: 10, scope: 'authenticated',
      safeMode: true, syntheticDataConsent: true, navigableUrl: (u) => u,
    });
    expect(result.facts).toHaveLength(0);
    // One decline per lens (structure, interactions, fixture — the screen has an opener).
    expect(result.rejected).toHaveLength(3);
    for (const r of result.rejected) {
      expect(r.stage).toBe('transcribe');
      expect(r.reason).toContain('position 593');
    }
  });
});

// ─── fixtures: the fact tier's own records ───────────────────────────────────

import { runFixtureGate, substituteFixture, FIXTURE_TOKEN } from '../transcribe/fact-transcriber';

describe('fixtures', () => {
  const saveId = '55555555-5555-5555-5555-555555555555';
  const withSave = () => {
    const els = elements();
    els.set(saveId, { id: saveId, pageUrl: 'http://app.local/tests', role: 'button', name: 'Save', kind: 'button', revealedBy: 'New Test', selector: '#save' });
    return els;
  };

  it('accepts a recipe that opens the form, types {{fixture}} as the name and saves', () => {
    const gate = runFixtureGate([
      { action: 'click', target: { kind: 'element', elementId: EL.button } },
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: FIXTURE_TOKEN },
      { action: 'click', target: { kind: 'element', elementId: saveId } },
    ], withSave());
    expect(gate.ok).toBe(true);
  });

  it('refuses a recipe that never types the fixture token', () => {
    const gate = runFixtureGate([
      { action: 'click', target: { kind: 'element', elementId: EL.button } },
      { action: 'click', target: { kind: 'element', elementId: saveId } },
    ], withSave());
    expect(gate.ok).toBe(false);
  });

  it('refuses assertions inside a fixture recipe', () => {
    const gate = runFixtureGate([
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: FIXTURE_TOKEN },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ], withSave());
    expect(gate.ok).toBe(false);
  });

  it('a fact may reference {{fixture}} only when the screen defined one', () => {
    const steps: StepIntent[] = [
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: FIXTURE_TOKEN },
      { action: 'assert_visible', target: { kind: 'element', elementId: EL.button } },
    ];
    expect(runFactGate(fact(steps), elements(), false).ok).toBe(false);
    expect(runFactGate(fact(steps), elements(), true).ok).toBe(true);
  });

  it('substitutes the token in typed and asserted values only', () => {
    const out = substituteFixture([
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: `search ${FIXTURE_TOKEN}` },
      { action: 'assert_text', value: FIXTURE_TOKEN },
      { action: 'click', target: { kind: 'element', elementId: EL.button } },
    ], 'Kaizen fixture abc123');
    expect((out[0] as { value: string }).value).toBe('search Kaizen fixture abc123');
    expect((out[1] as { value: string }).value).toBe('Kaizen fixture abc123');
    expect(out[2]).toEqual({ action: 'click', target: { kind: 'element', elementId: EL.button } });
  });

  it('the verifier creates the fixture once per screen and substitutes the name', async () => {
    const script: Script = { visible: new Set(['#new-test', 'input.search']), bodyText: 'Tests', url: 'http://app.local/' };
    const fixture: StepIntent[] = [
      { action: 'type', target: { kind: 'element', elementId: EL.input }, value: FIXTURE_TOKEN },
    ];
    const factA = scenario([{ action: 'assert_text', value: FIXTURE_TOKEN }]);
    const factB = scenario([{ action: 'assert_text', value: FIXTURE_TOKEN }]);
    for (const f of [factA, factB]) { f.usesFixture = true; f.fixtureIntents = fixture; }
    const verdicts = await verifierWith(script).verifyAll({
      tenantId: 't', baseUrl: 'http://app.local/', facts: [factA, factB], elements: elements(),
    });
    expect(verdicts.map((v) => v.ok)).toEqual([true, true]);
    // The fake page's fill() appends the typed value to the body: one fixture name, typed once.
    expect(script.bodyText.match(/Kaizen fixture/g)).toHaveLength(1);
  });
});
