import { collectSelectorSeeds } from '../write/scenario-writer';
import { domainOf, seedSelectors } from '../validate/selector-seeder';
import { renderScenario } from '../write/canonical-templates';
import type { GroundingElement, StepIntent } from '../../../types/test-writer';

/**
 * Pre-seeding closes the loop the founder spotted: Kaizen already knew which
 * element it meant when it wrote the sentence, so the proving run must not pay
 * the model to rediscover it.
 */

const BUTTON: GroundingElement = {
  id: '11111111-1111-4111-8111-111111111111',
  pageUrl: 'https://shop.test/login', role: 'button', name: 'Sign in',
  kind: 'button', revealedBy: null, selector: 'role=button[name="Sign in"]',
};
const FIELD: GroundingElement = {
  id: '22222222-2222-4222-8222-222222222222',
  pageUrl: 'https://shop.test/login', role: 'textbox', name: 'Email',
  kind: 'input', revealedBy: null, selector: '#email',
};
const REVEALED: GroundingElement = {
  id: '33333333-3333-4333-8333-333333333333',
  pageUrl: 'https://shop.test/', role: 'link', name: 'Latest',
  kind: 'link', revealedBy: 'Version menu', selector: null,   // probes capture no selector
};
const elements = new Map([BUTTON, FIELD, REVEALED].map((e) => [e.id, e]));

function seedsFor(intents: StepIntent[]) {
  return collectSelectorSeeds(intents, renderScenario(intents, elements), elements);
}

describe('collectSelectorSeeds', () => {
  it('pairs each element-targeted step with the selector recon observed', () => {
    const seeds = seedsFor([
      { action: 'navigate', url: 'https://shop.test/login' },
      { action: 'type', target: { kind: 'element', elementId: FIELD.id }, value: '{{email}}' },
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_url', value: '/dashboard' },
    ]);
    expect(seeds.map((s) => s.selector).sort()).toEqual(['#email', 'role=button[name="Sign in"]']);
    expect(seeds.every((s) => s.targetHash.length === 64)).toBe(true);
  });

  it('skips description targets — a class of elements has no single selector', () => {
    const seeds = seedsFor([
      { action: 'click_random', description: 'a product link', captureAs: 'selectedItem' },
      { action: 'assert_text', value: '{{selectedItem}}' },
    ]);
    expect(seeds).toEqual([]);
  });

  it('skips discover oracles — the element does not exist until the action runs', () => {
    const seeds = seedsFor([
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_visible', target: { kind: 'description', description: 'the error message' } },
    ]);
    expect(seeds).toHaveLength(1);
    expect(seeds[0].selector).toBe('role=button[name="Sign in"]');
  });

  it('skips probe-revealed elements, which carry no captured selector', () => {
    const seeds = seedsFor([
      { action: 'click', target: { kind: 'element', elementId: REVEALED.id } },
      { action: 'assert_url', value: '/x' },
    ]);
    expect(seeds).toEqual([]);
  });

  it('deduplicates repeated targets — one cache row per targetHash', () => {
    const seeds = seedsFor([
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_url', value: '/x' },
    ]);
    expect(seeds).toHaveLength(1);
  });

  it('matches the targetHash the renderer put on the step, so the resolver finds it', () => {
    const intents: StepIntent[] = [
      { action: 'click', target: { kind: 'element', elementId: BUTTON.id } },
      { action: 'assert_url', value: '/x' },
    ];
    const rendered = renderScenario(intents, elements);
    const seeds = collectSelectorSeeds(intents, rendered, elements);
    expect(seeds[0].targetHash).toBe(rendered[0].ast.targetHash);
  });
});

describe('seedSelectors', () => {
  const client = { query: jest.fn(async () => ({ rowCount: 1 })) };

  beforeEach(() => client.query.mockClear());

  it('writes tenant-scoped rows and never touches the shared pool', async () => {
    const written = await seedSelectors(
      't-1', 'https://shop.test/login',
      [{ targetHash: 'a'.repeat(64), selector: '#email' }],
      client as never,
    );
    expect(written).toBe(1);
    const [sql, values] = client.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('is_shared');
    expect(sql).toContain('false');
    expect(values[0]).toBe('t-1');          // tenant always set
    expect(values[2]).toBe('shop.test');    // domain from the base URL
  });

  it('does nothing when there is nothing observed to seed', async () => {
    expect(await seedSelectors('t-1', 'https://shop.test/', [], client as never)).toBe(0);
    expect(client.query).not.toHaveBeenCalled();
  });

  it('is non-fatal: a failed seed costs tokens, never the test', async () => {
    const failing = { query: jest.fn(async () => { throw new Error('db down'); }) };
    const written = await seedSelectors(
      't-1', 'https://shop.test/', [{ targetHash: 'b'.repeat(64), selector: '#x' }],
      failing as never,
    );
    expect(written).toBe(0);
  });

  it('extracts the domain the resolver keys on', () => {
    expect(domainOf('https://shop.test/login?x=1')).toBe('shop.test');
    expect(domainOf('not a url')).toBe('');
  });
});
