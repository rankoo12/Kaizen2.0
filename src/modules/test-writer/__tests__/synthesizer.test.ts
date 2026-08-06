import { AppBriefSynthesizer, findCoverageGaps } from '../comprehend/synthesizer';
import type { IObservability } from '../../observability/interfaces';
import type { AppBrief, TenantBrief } from '../../../types/test-writer';

/**
 * The knowledge-layer false-pass firewall: the LLM proposes journeys, the
 * observed link graph disposes of them. Kaizen must never "know" a path the
 * crawler never walked.
 */

const obs: IObservability = {
  startSpan: () => ({ end: () => {} }) as never,
  log: jest.fn(), increment: jest.fn(), histogram: jest.fn(),
};

const PAGES = [
  { id: '1', urlNormalized: 'https://s.test/', title: 'Home', purpose: 'landing', purposeTag: 'landing', capabilities: [], requiresAuth: false },
  { id: '2', urlNormalized: 'https://s.test/products', title: 'Products', purpose: 'listing', purposeTag: 'listing', capabilities: ['user can browse'], requiresAuth: false },
  { id: '3', urlNormalized: 'https://s.test/cart', title: 'Cart', purpose: 'cart', purposeTag: 'checkout', capabilities: [], requiresAuth: false },
];

const LINKS = {
  'https://s.test/': ['https://s.test/products'],
  'https://s.test/products': ['https://s.test/cart'],
};

function makeRepo(saved: { brief?: AppBrief } = {}) {
  return {
    listClassifiedPages: jest.fn(async () => PAGES),
    getLinkGraph: jest.fn(async () => LINKS),
    saveAppBrief: jest.fn(async (_t: string, _s: string, brief: AppBrief) => {
      saved.brief = brief;
      return 1;
    }),
  } as never;
}

function makeGateway(journeys: unknown[]) {
  return {
    synthesizeAppBrief: jest.fn(async () => ({
      appType: 'e-commerce storefront',
      summary: 'Sells things.',
      coreEntities: ['product'],
      journeys,
    })),
  } as never;
}

describe('AppBriefSynthesizer — journey verification', () => {
  it('keeps a journey whose hops all exist in the observed graph', async () => {
    const saved: { brief?: AppBrief } = {};
    const synth = new AppBriefSynthesizer(
      makeGateway([{
        name: 'Browse to cart', description: '...', requiresAuth: false, priority: 'critical',
        pagePath: ['https://s.test/', 'https://s.test/products', 'https://s.test/cart'],
      }]),
      makeRepo(saved), obs,
    );

    const result = await synth.synthesize('t1', 's1', 'j1', null);
    expect(result.brief.journeys).toHaveLength(1);
    expect(result.journeysDropped).toHaveLength(0);
  });

  it('drops a journey that cites a page the crawler never observed', async () => {
    const synth = new AppBriefSynthesizer(
      makeGateway([{
        name: 'Ghost journey', description: '...', requiresAuth: false, priority: 'high',
        pagePath: ['https://s.test/', 'https://s.test/checkout-that-was-never-crawled'],
      }]),
      makeRepo(), obs,
    );

    const result = await synth.synthesize('t1', 's1', 'j1', null);
    expect(result.brief.journeys).toHaveLength(0);
    expect(result.journeysDropped[0].reason).toContain('not observed');
  });

  it('drops a journey whose hop has no observed link', async () => {
    const synth = new AppBriefSynthesizer(
      makeGateway([{
        name: 'Teleport', description: '...', requiresAuth: false, priority: 'high',
        pagePath: ['https://s.test/cart', 'https://s.test/'],   // no cart -> home edge
      }]),
      makeRepo(), obs,
    );

    const result = await synth.synthesize('t1', 's1', 'j1', null);
    expect(result.brief.journeys).toHaveLength(0);
    expect(result.journeysDropped[0].reason).toContain('no observed link');
  });

  it('accepts a one-hop-through gap (the LLM commonly omits an obvious waypoint)', async () => {
    const synth = new AppBriefSynthesizer(
      makeGateway([{
        name: 'Home to cart', description: '...', requiresAuth: false, priority: 'critical',
        pagePath: ['https://s.test/', 'https://s.test/cart'],   // via /products
      }]),
      makeRepo(), obs,
    );

    const result = await synth.synthesize('t1', 's1', 'j1', null);
    expect(result.brief.journeys).toHaveLength(1);
  });
});

describe('findCoverageGaps', () => {
  const brief: AppBrief = {
    appType: 'shop', summary: '', coreEntities: [],
    journeys: [{ name: 'Browse', description: 'home to products', pagePath: [], requiresAuth: false, priority: 'high' }],
  };

  it('reports a described flow that nothing observed supports', () => {
    const tenantBrief = { criticalFlows: ['subscription billing renewal'] } as TenantBrief;
    expect(findCoverageGaps(tenantBrief, PAGES, brief)).toEqual(['subscription billing renewal']);
  });

  it('does not report a flow the crawl clearly reached', () => {
    const tenantBrief = { criticalFlows: ['products browsing'] } as TenantBrief;
    expect(findCoverageGaps(tenantBrief, PAGES, brief)).toEqual([]);
  });
});
