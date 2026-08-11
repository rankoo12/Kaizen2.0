import { TestPlanner } from '../plan/test-planner';
import { SCENARIO_ARCHETYPES, getArchetype, renderCatalogBlock } from '../plan/catalog';
import type { ClassifiedPage } from '../site-model.repository';
import type { AppBrief } from '../../../types/test-writer';

/**
 * PLAN normalisation — the LLM proposes, observed reality disposes.
 * These cover the authenticated-scope rule from spec-authenticated-scope.md §6.1.
 */

const obs = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(), increment: jest.fn(), histogram: jest.fn(),
};

const appBrief: AppBrief = {
  summary: 'A shop', appType: 'ecommerce', entities: [], journeys: [], coverageGaps: [],
} as unknown as AppBrief;

function page(url: string, requiresAuth = false): ClassifiedPage {
  return {
    id: url, urlNormalized: url, title: 't', purpose: 'p', purposeTag: 'other',
    capabilities: ['do a thing'], entities: [], requiresAuth,
  } as unknown as ClassifiedPage;
}

function makePlanner(scenarios: unknown[]) {
  const gateway = { planScenarios: jest.fn().mockResolvedValue(scenarios) };
  return { planner: new TestPlanner(gateway as never, obs as never), gateway };
}

const baseParams = {
  tenantId: 't1',
  appBrief,
  tenantBrief: null,
  pages: [page('https://a.com/dash', true), page('https://a.com/admin', true)],
  existingCaseNames: [],
  syntheticDataConsent: false,
  maxScenarios: 6,
};

describe('TestPlanner — signed-out archetypes under authenticated scope', () => {
  // Every scenario in an authenticated job carries the login prefix, so an
  // archetype whose oracle asserts the ANONYMOUS experience can never pass.
  const SIGNED_OUT_KEYS = SCENARIO_ARCHETYPES
    .filter((a) => a.requiresSignedOut).map((a) => a.key);

  it('tags the archetypes whose premise is being signed out', () => {
    // Guards against the name-prefix rule that misses permissions.* and
    // password-reset — the trap this tag exists to avoid.
    expect(SIGNED_OUT_KEYS).toEqual(expect.arrayContaining([
      'auth.login.negative.wrong-password',
      'auth.signup.happy',
      'auth.password-reset.request',
      'permissions.protected-page-requires-login',
      'permissions.negative.direct-admin-url',
    ]));
  });

  it.each(SIGNED_OUT_KEYS)('drops %s in an authenticated job', async (key) => {
    const { planner } = makePlanner([{
      name: 'Some scenario', journey: null, kind: 'negative', priority: 'critical',
      rationale: 'r', targetPages: ['https://a.com/dash'],
      source: { kind: 'catalog', archetypeKey: key },
    }]);

    const result = await planner.plan({ ...baseParams, scope: 'authenticated' });

    expect(result.scenarios).toHaveLength(0);
    expect(result.dropped[0].reason).toMatch(/signed-out visitor/);
  });

  it('keeps the same archetypes in a public job', async () => {
    const { planner } = makePlanner([{
      name: 'Protected page redirects', journey: null, kind: 'negative', priority: 'critical',
      rationale: 'r', targetPages: ['https://a.com/dash'],
      source: { kind: 'catalog', archetypeKey: 'permissions.protected-page-requires-login' },
    }]);

    // Public scope drops requires_auth pages for a DIFFERENT reason, so use a
    // public page to isolate the rule under test.
    const result = await planner.plan({
      ...baseParams,
      pages: [page('https://a.com/dash', false)],
      scope: 'public',
    });

    expect(result.scenarios).toHaveLength(1);
  });

  it('keeps ordinary authenticated scenarios', async () => {
    const { planner } = makePlanner([{
      name: 'Search finds a known item', journey: null, kind: 'happy', priority: 'high',
      rationale: 'r', targetPages: ['https://a.com/dash'],
      source: { kind: 'catalog', archetypeKey: 'search.find-known-entity' },
    }]);

    const result = await planner.plan({ ...baseParams, scope: 'authenticated' });

    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].name).toBe('Search finds a known item');
  });
});

describe('renderCatalogBlock', () => {
  it('annotates signed-out entries without filtering them', () => {
    // The block is the CACHED static prefix: it must render identically for
    // every job regardless of scope, so the rule is enforced after the model
    // answers, not by shrinking the prompt.
    const block = renderCatalogBlock();
    expect(block).toContain('permissions.protected-page-requires-login');
    expect(block).toMatch(/permissions\.protected-page-requires-login.*SIGNED-OUT-ONLY/);
    expect(block).not.toMatch(/search\.find-known-entity.*SIGNED-OUT-ONLY/);
  });

  it('renders every archetype', () => {
    const lines = renderCatalogBlock().split('\n');
    expect(lines).toHaveLength(SCENARIO_ARCHETYPES.length);
    for (const a of SCENARIO_ARCHETYPES) expect(getArchetype(a.key)).not.toBeNull();
  });
});
